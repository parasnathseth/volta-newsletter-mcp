// Thin Mailchimp Marketing API client. The API key comes from the Worker secret
// MAILCHIMP_API_KEY and is never logged or included in error messages.

export interface MailchimpEnv {
  MAILCHIMP_API_KEY?: string;
  MAILCHIMP_LIST_ID?: string; // optional: which audience drafts go to when the account has several
  MAILCHIMP_DRY_RUN?: string; // "true" = validate and report, but make no changes in Mailchimp
}

export const isDryRun = (env: MailchimpEnv) => env.MAILCHIMP_DRY_RUN === 'true';

/** Link to open a campaign in the Mailchimp app, from its numeric web_id. */
export function campaignAdminUrl(env: MailchimpEnv, webId: number | string): string {
  const dc = env.MAILCHIMP_API_KEY?.split('-').pop() ?? 'us1';
  return `https://${dc}.admin.mailchimp.com/campaigns/edit?id=${webId}`;
}

export class MailchimpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MailchimpError';
    this.status = status;
  }
}

export async function mailchimp<T = any>(env: MailchimpEnv, method: string, path: string, body?: unknown): Promise<T> {
  const key = env.MAILCHIMP_API_KEY;
  if (!key) throw new Error('MAILCHIMP_API_KEY is not configured on the server.');
  const dc = key.split('-').pop() ?? '';
  // The datacenter comes from the key's suffix and becomes part of the host name, so it must look like "us20".
  if (!/^[a-z]{2,4}\d{1,3}$/.test(dc)) throw new Error('MAILCHIMP_API_KEY does not look like a Mailchimp key (expected a "-us20" style suffix).');

  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + btoa('anystring:' + key),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });

  if (res.status === 204) return null as T;
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON body; fall through with status text
  }
  if (!res.ok) {
    const detail = [json.title, json.detail].filter(Boolean).join(': ') || res.statusText || 'request failed';
    throw new MailchimpError(res.status, `Mailchimp ${method} ${path.split('?')[0]} failed (${res.status}): ${detail}`);
  }
  return json as T;
}
