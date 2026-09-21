// A soft per-user rate limit for the tools that can do the most damage if Claude is
// confused or manipulated (test emails to colleagues, replacing the shared template,
// deleting drafts or backlog entries). It is a brake, not a security boundary: KV is
// eventually consistent, so under a burst a few extra calls can slip through.
//
// Counters live in KV under `rate:<action>:<user>:<window>` and expire on their own.

export interface RateLimitEnv {
  OAUTH_KV: KVNamespace;
}

export interface Limit {
  max: number;
  windowSeconds: number;
}

/** Limits per user. Generous for normal use (a person working through one newsletter), tight for a runaway loop. */
export const LIMITS: Record<string, Limit> = {
  send_test: { max: 10, windowSeconds: 3600 },
  update_template: { max: 20, windowSeconds: 3600 },
  restore_template: { max: 20, windowSeconds: 3600 },
  delete_draft: { max: 20, windowSeconds: 3600 },
  delete_edition: { max: 20, windowSeconds: 3600 },
  create_draft: { max: 30, windowSeconds: 3600 },
  backlog_remove: { max: 30, windowSeconds: 3600 },
};

export class RateLimitError extends Error {
  constructor(action: string, limit: Limit) {
    super(`Too many ${action} requests: the limit is ${limit.max} per ${Math.round(limit.windowSeconds / 60)} minutes for each person. Wait a while and try again, and check that nothing is looping.`);
    this.name = 'RateLimitError';
  }
}

/** Counts one use of `action` by `user`; throws RateLimitError once the limit for the current window is passed. */
export async function checkRateLimit(env: RateLimitEnv, action: string, user: string, now = Date.now()): Promise<void> {
  const limit = LIMITS[action];
  if (!limit) return;
  const window = Math.floor(now / 1000 / limit.windowSeconds);
  const key = `rate:${action}:${user.toLowerCase()}:${window}`;
  const used = Number((await env.OAUTH_KV.get(key)) ?? 0);
  if (used >= limit.max) throw new RateLimitError(action, limit);
  // KV requires a TTL of at least 60 seconds; keep the counter a little past the window.
  await env.OAUTH_KV.put(key, String(used + 1), { expirationTtl: limit.windowSeconds + 60 });
}
