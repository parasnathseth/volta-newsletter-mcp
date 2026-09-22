// PostToolUse hook (Write|Edit): runs `npm test` only when the changed file is under
// src/ or skill/volta-newsletter/ (the code and the Skill the e2e harness checks against).
// Docs, config and other edits are skipped so the hook stays cheap on everything else.
// On failure, reports back to Claude via PostToolUse's "block" decision so it sees the
// failure and can fix it; on a pass or a skip, it exits quietly.
import { spawnSync } from 'node:child_process';

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    process.exit(0); // malformed input: never block on something we can't read
  }

  const filePath = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath ?? '';
  const normalized = String(filePath).replace(/\\/g, '/');
  const relevant = /(^|\/)src\//.test(normalized) || /(^|\/)skill\/volta-newsletter\//.test(normalized);
  if (process.env.HOOK_DEBUG) console.error('DEBUG payload=', JSON.stringify(payload), 'filePath=', filePath, 'normalized=', normalized, 'relevant=', relevant);
  if (!relevant) process.exit(0);

  const result = spawnSync('npm', ['test'], { cwd: process.cwd(), encoding: 'utf8', shell: true, timeout: 120_000 });
  const passed = result.status === 0;
  if (passed) process.exit(0);

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-2000);
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `npm test failed after editing ${filePath}. Fix the failure before continuing.\n\n${output}`,
    }),
  );
  process.exit(0); // the hook process itself must exit 0; "decision" is what signals the block
});
