import { campaignAdminUrl, isDryRun, mailchimp, MailchimpError, type MailchimpEnv } from './mailchimp.ts';
import { clearDraft, consentProblems, EditionError, getEdition, markDrafted, type Edition, type EditionEnv } from './edition.ts';
import { getTemplateState, type TemplateEnv } from './template.ts';

export interface CampaignEnv extends MailchimpEnv, EditionEnv, TemplateEnv {
  TEST_EMAIL_ALLOWED_DOMAINS?: string;
  EXTRA_ALLOWED_EMAILS?: string; // DEV ONLY
}

export class ConsentError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(
      `No Mailchimp draft was created because consent is not confirmed for every featured story:\n- ${problems.join('\n- ')}\nAsk the user whether each founder has agreed to that story, then record it with save_edition (consent "confirmed" plus how it was given). A test email can still be sent meanwhile.`,
    );
    this.name = 'ConsentError';
    this.problems = problems;
  }
}

interface ChecklistItem {
  type: string;
  id?: number;
  heading?: string;
  details?: string;
}

export interface DraftResult {
  editionId: string;
  campaignId: string;
  url: string;
  reusedExistingDraft: boolean;
  dryRun: boolean;
  wouldDo?: string[];
  sendReady: boolean | null;
  checklistProblems: string[];
}

const missingFields = (e: Edition): string[] => {
  const m: string[] = [];
  if (!e.subject.trim()) m.push('a subject line');
  if (!e.previewText.trim()) m.push('preview text');
  if (!e.bodyHtml.trim()) m.push('a body');
  return m;
};

async function pickAudience(env: CampaignEnv): Promise<{ listId: string; fromName: string; replyTo: string }> {
  const lists = await mailchimp<{ lists: { id: string; name: string }[] }>(env, 'GET', '/lists?count=20&fields=lists.id,lists.name');
  if (!lists.lists?.length) throw new Error('The Mailchimp account has no audience to create a campaign for.');
  const chosen = (env.MAILCHIMP_LIST_ID && lists.lists.find((l) => l.id === env.MAILCHIMP_LIST_ID)) || lists.lists[0];
  const detail = await mailchimp<{ campaign_defaults?: { from_name?: string; from_email?: string } }>(env, 'GET', `/lists/${chosen.id}?fields=campaign_defaults`);
  return {
    listId: chosen.id,
    fromName: detail.campaign_defaults?.from_name || 'Volta',
    replyTo: detail.campaign_defaults?.from_email || '',
  };
}

const campaignTitle = (e: Edition) => `${e.label} (${e.createdAt.slice(0, 10)})`;

const problemsFrom = (items: ChecklistItem[] = []) =>
  items.filter((i) => i.type === 'error' || i.type === 'warning').map((i) => `${i.type}: ${i.heading ?? ''}${i.details ? ` (${i.details.replace(/<[^>]+>/g, '').slice(0, 160)})` : ''}`);

/** Creates (or re-pushes) the Mailchimp draft for an edition. Never sends. */
export async function createDraft(env: CampaignEnv, bundledShell: string, args: { editionId?: string; by: string; overwrite?: boolean }): Promise<DraftResult> {
  const edition = await getEdition(env, args.editionId);

  const missing = missingFields(edition);
  if (missing.length) throw new EditionError(`The edition needs ${missing.join(', ')} before a draft can be created. Add them with save_edition.`);
  const consent = consentProblems(edition);
  if (consent.length) throw new ConsentError(consent);

  const template = await getTemplateState(env, bundledShell);
  const audience = await pickAudience(env);
  const dry = isDryRun(env);

  // Reuse the edition's existing draft if it is still a draft, instead of creating duplicates.
  let existing: { id: string; web_id: number; status: string } | null = null;
  if (edition.campaignId) {
    try {
      existing = await mailchimp(env, 'GET', `/campaigns/${edition.campaignId}?fields=id,web_id,status`);
    } catch (err) {
      if (!(err instanceof MailchimpError && err.status === 404)) throw err;
    }
    if (existing && existing.status !== 'save') {
      throw new EditionError(`This edition's Mailchimp campaign is already "${existing.status}" (not a draft), so it was left alone. Start a new edition for the next send.`);
    }
    if (existing && !args.overwrite) {
      throw new EditionError(
        `This edition already has a Mailchimp draft (${campaignAdminUrl(env, existing.web_id)}). Creating the draft again replaces that draft's content with the saved edition and discards any edits made directly in Mailchimp. If the user wants that, confirm with them and call create_draft again with overwrite: true.`,
      );
    }
  }

  const settings = { subject_line: edition.subject, preview_text: edition.previewText, title: campaignTitle(edition) };
  if (dry) {
    return {
      editionId: edition.id,
      campaignId: existing?.id ?? '(dry run)',
      url: '',
      reusedExistingDraft: !!existing,
      dryRun: true,
      wouldDo: [
        existing ? `Update draft ${existing.id} settings and content` : `Create a new draft in audience ${audience.listId}`,
        `Subject: "${edition.subject}"`,
        `Insert the ${edition.bodyHtml.length}-character body into template ${template.mailchimpTemplateId}`,
        'Nothing was changed in Mailchimp (dry-run mode).',
      ],
      sendReady: null,
      checklistProblems: [],
    };
  }

  let campaign: { id: string; web_id: number };
  if (existing) {
    campaign = existing;
    await mailchimp(env, 'PATCH', `/campaigns/${existing.id}`, { settings: { ...settings, template_id: template.mailchimpTemplateId } });
  } else {
    campaign = await mailchimp(env, 'POST', '/campaigns', {
      type: 'regular',
      recipients: { list_id: audience.listId },
      settings: { ...settings, from_name: audience.fromName, reply_to: audience.replyTo, template_id: template.mailchimpTemplateId },
    });
  }
  await mailchimp(env, 'PUT', `/campaigns/${campaign.id}/content`, {
    template: { id: template.mailchimpTemplateId, sections: { body: edition.bodyHtml } },
  });

  const url = campaignAdminUrl(env, campaign.web_id);
  await markDrafted(env, edition.id, { campaignId: campaign.id, campaignUrl: url, by: args.by });

  const checklist = await mailchimp<{ is_ready?: boolean; items?: ChecklistItem[] }>(env, 'GET', `/campaigns/${campaign.id}/send-checklist`).catch(() => null);
  return {
    editionId: edition.id,
    campaignId: campaign.id,
    url,
    reusedExistingDraft: !!existing,
    dryRun: false,
    sendReady: checklist?.is_ready ?? null,
    checklistProblems: problemsFrom(checklist?.items),
  };
}

// ---- send_test ----------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Test emails may only go to allowed domains (default voltaeffect.com) plus, for development, exact addresses in EXTRA_ALLOWED_EMAILS. */
export function checkTestRecipients(env: CampaignEnv, to: string[]): { allowed: string[]; rejected: string[] } {
  const domains = (env.TEST_EMAIL_ALLOWED_DOMAINS ?? 'voltaeffect.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const extras = (env.EXTRA_ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const allowed = new Map<string, string>(); // lowercase -> as typed, so case variants collapse
  const rejected: string[] = [];
  for (const raw of to) {
    const email = raw.trim().toLowerCase();
    const ok = EMAIL_RE.test(email) && (domains.some((d) => email.endsWith(`@${d}`)) || extras.includes(email));
    if (!ok) rejected.push(raw.trim());
    else if (!allowed.has(email)) allowed.set(email, raw.trim());
  }
  return { allowed: [...allowed.values()], rejected };
}

/** Sends a test email of an edition through a temporary Mailchimp draft, which is deleted afterwards. Works without consent, since it only reaches allowed internal addresses. */
export async function sendTest(
  env: CampaignEnv,
  bundledShell: string,
  args: { editionId?: string; to: string[] },
): Promise<{ editionId: string; sentTo: string[]; dryRun: boolean; note: string }> {
  if (!args.to.length) throw new EditionError('Give at least one recipient address.');
  if (args.to.length > 5) throw new EditionError('At most 5 test recipients at a time.');
  const { allowed, rejected } = checkTestRecipients(env, args.to);
  if (rejected.length) {
    const domains = env.TEST_EMAIL_ALLOWED_DOMAINS ?? 'voltaeffect.com';
    throw new EditionError(`Test emails can only be sent to addresses at: ${domains}. Not allowed: ${rejected.join(', ')}.`);
  }

  const edition = await getEdition(env, args.editionId);
  if (!edition.bodyHtml.trim()) throw new EditionError('This edition has no body yet. Add one with save_edition.');
  const template = await getTemplateState(env, bundledShell);

  if (isDryRun(env)) {
    return { editionId: edition.id, sentTo: allowed, dryRun: true, note: `Dry run: would send a test of "${edition.subject || '(no subject)'}" to ${allowed.join(', ')}. Nothing was sent.` };
  }

  const audience = await pickAudience(env);
  const temp = await mailchimp<{ id: string }>(env, 'POST', '/campaigns', {
    type: 'regular',
    recipients: { list_id: audience.listId },
    settings: {
      subject_line: edition.subject || '(no subject)',
      preview_text: edition.previewText,
      title: `[TEST] ${campaignTitle(edition)} ${new Date().toISOString()}`,
      from_name: audience.fromName,
      reply_to: audience.replyTo,
      template_id: template.mailchimpTemplateId,
    },
  });
  try {
    await mailchimp(env, 'PUT', `/campaigns/${temp.id}/content`, { template: { id: template.mailchimpTemplateId, sections: { body: edition.bodyHtml } } });
    await mailchimp(env, 'POST', `/campaigns/${temp.id}/actions/test`, { test_emails: allowed, send_type: 'html' });
  } finally {
    await mailchimp(env, 'DELETE', `/campaigns/${temp.id}`).catch(() => undefined); // best effort; the temp draft is never sent to the audience
  }
  return { editionId: edition.id, sentTo: allowed, dryRun: false, note: 'Test email sent. It can take a minute to arrive; check spam if it does not.' };
}

// ---- reports ------------------------------------------------------------------

export interface ReportOut {
  sent: true;
  campaignId: string;
  title: string;
  subject: string;
  sendTime: string | null;
  emailsSent: number;
  opens: { unique: number; total: number; rate: number };
  clicks: { unique: number; total: number; rate: number };
  unsubscribes: number;
  bounces: { hard: number; soft: number };
  topLinks: { url: string; totalClicks: number; uniqueClicks: number }[];
}

export type NotSent = { sent: false; campaignId: string; status: string; message: string };

export async function getReport(env: CampaignEnv, args: { campaignId?: string; editionId?: string }): Promise<ReportOut | NotSent> {
  let campaignId = args.campaignId;
  if (!campaignId) {
    const edition = await getEdition(env, args.editionId);
    if (!edition.campaignId) throw new EditionError('This edition has no Mailchimp campaign yet, so there is no report.');
    campaignId = edition.campaignId;
  }
  // Mailchimp's reports endpoint answers 200 with zeros for drafts and even for deleted
  // campaigns, so the campaign's real status decides whether there is anything to report.
  let campaign: { status: string };
  try {
    campaign = await mailchimp(env, 'GET', `/campaigns/${campaignId}?fields=id,status`);
  } catch (err) {
    if (err instanceof MailchimpError && err.status === 404) {
      return { sent: false, campaignId, status: 'not_found', message: 'Mailchimp has no campaign with this id (it may have been deleted).' };
    }
    throw err;
  }
  if (campaign.status !== 'sent') {
    return { sent: false, campaignId, status: campaign.status, message: `This campaign has not been sent (status: ${campaign.status}), so there are no results yet.` };
  }
  const r: any = await mailchimp(env, 'GET', `/reports/${campaignId}`);
  const clicks = await mailchimp<{ urls_clicked?: any[] }>(env, 'GET', `/reports/${campaignId}/click-details?count=20`).catch(() => ({ urls_clicked: [] }));
  return {
    sent: true,
    campaignId,
    title: r.campaign_title ?? '',
    subject: r.subject_line ?? '',
    sendTime: r.send_time || null,
    emailsSent: r.emails_sent ?? 0,
    opens: { unique: r.opens?.unique_opens ?? 0, total: r.opens?.opens_total ?? 0, rate: r.opens?.open_rate ?? 0 },
    clicks: { unique: r.clicks?.unique_clicks ?? 0, total: r.clicks?.clicks_total ?? 0, rate: r.clicks?.click_rate ?? 0 },
    unsubscribes: r.unsubscribed ?? 0,
    bounces: { hard: r.bounces?.hard_bounces ?? 0, soft: r.bounces?.soft_bounces ?? 0 },
    topLinks: (clicks.urls_clicked ?? [])
      .map((u) => ({ url: u.url, totalClicks: u.total_clicks ?? 0, uniqueClicks: u.unique_clicks ?? 0 }))
      .sort((a, b) => b.uniqueClicks - a.uniqueClicks)
      .slice(0, 10),
  };
}

// ---- delete_draft -------------------------------------------------------------

export interface DeleteDraftResult {
  editionId: string;
  campaignId: string;
  outcome: 'deleted' | 'already_gone';
  dryRun: boolean;
  note: string;
}

/** Deletes an edition's Mailchimp DRAFT (never a sent or scheduled campaign) and reopens the edition. */
export async function deleteDraft(env: CampaignEnv, args: { editionId?: string; by: string }): Promise<DeleteDraftResult> {
  const edition = await getEdition(env, args.editionId);
  if (!edition.campaignId) throw new EditionError('This edition has no Mailchimp draft to delete.');
  const campaignId = edition.campaignId;

  let status: string | null = null;
  try {
    status = (await mailchimp<{ status: string }>(env, 'GET', `/campaigns/${campaignId}?fields=id,status`)).status;
  } catch (err) {
    if (!(err instanceof MailchimpError && err.status === 404)) throw err;
  }

  if (status === null) {
    if (!isDryRun(env)) await clearDraft(env, edition.id, args.by);
    return { editionId: edition.id, campaignId, outcome: 'already_gone', dryRun: isDryRun(env), note: 'The draft was already gone from Mailchimp; the edition no longer points at it.' };
  }
  if (status !== 'save') {
    throw new EditionError(`Campaign ${campaignId} is "${status}", not a draft, so it was not deleted. Only unsent drafts can be deleted here; handle anything else in Mailchimp.`);
  }
  if (isDryRun(env)) {
    return { editionId: edition.id, campaignId, outcome: 'deleted', dryRun: true, note: `Dry run: would delete draft ${campaignId}. Nothing was changed.` };
  }
  await mailchimp(env, 'DELETE', `/campaigns/${campaignId}`);
  await clearDraft(env, edition.id, args.by);
  return { editionId: edition.id, campaignId, outcome: 'deleted', dryRun: false, note: 'The Mailchimp draft was deleted and the edition is back to in progress. The edition content is still saved.' };
}

export interface PastCampaign {
  campaignId: string;
  title: string;
  subject: string;
  sendTime: string | null;
  emailsSent: number;
  openRate: number | null;
  clickRate: number | null;
  text?: string;
}

/** Recently sent campaigns with headline stats, optionally with plain-text content (for tone reference). */
export async function listPastCampaigns(env: CampaignEnv, args: { limit: number; includeContent: boolean }): Promise<PastCampaign[]> {
  const res = await mailchimp<{ campaigns?: any[] }>(
    env,
    'GET',
    `/campaigns?status=sent&count=${args.limit}&sort_field=send_time&sort_dir=DESC&fields=campaigns.id,campaigns.send_time,campaigns.emails_sent,campaigns.settings.subject_line,campaigns.settings.title,campaigns.report_summary`,
  );
  const out: PastCampaign[] = (res.campaigns ?? []).map((c) => ({
    campaignId: c.id,
    title: c.settings?.title ?? '',
    subject: c.settings?.subject_line ?? '',
    sendTime: c.send_time || null,
    emailsSent: c.emails_sent ?? 0,
    openRate: c.report_summary?.open_rate ?? null,
    clickRate: c.report_summary?.click_rate ?? null,
  }));
  if (args.includeContent) {
    await Promise.all(
      out.slice(0, 3).map(async (c) => {
        const content = await mailchimp<{ plain_text?: string }>(env, 'GET', `/campaigns/${c.campaignId}/content?fields=plain_text`).catch(() => ({}) as { plain_text?: string });
        if (content.plain_text) c.text = content.plain_text.replace(/\s+/g, ' ').trim().slice(0, 3000);
      }),
    );
  }
  return out;
}
