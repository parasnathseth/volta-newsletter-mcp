// Structured one-line JSON logs (captured by Workers Logs, 3-day retention on
// the free plan). Never pass email bodies, HTML, keys or tokens in `fields`.
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields, ts: new Date().toISOString() }));
}
