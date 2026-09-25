// Combines the Skill files into ONE plain text file, for AI apps that have no Skills feature
// (for example ChatGPT: paste the result into a Project's instructions or upload it as a project file).
// Run: npm run instructions   ->   dist/volta-newsletter-instructions.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = join(root, 'skill', 'volta-newsletter');
// SKILL.md first (the rules), then the detail files in the order the routine uses them.
const files = ['SKILL.md', 'workflow.md', 'sources-and-vetting.md', 'brand-and-html.md', 'analytics.md', 'backlog-and-followup.md'];

// SKILL.md starts with a small header block between two "---" lines that only Claude reads: drop it.
const withoutHeader = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

const parts = files.map((name) => {
  const text = readFileSync(join(skillDir, name), 'utf8');
  return `<!-- ===== ${name} ===== -->\n\n${name === 'SKILL.md' ? withoutHeader(text) : text}`;
});

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'volta-newsletter-instructions.md');
writeFileSync(out, parts.join('\n\n'));
console.log(`Wrote ${out} (${Math.round(parts.join('').length / 1024)} KB). If your app limits instruction length, paste SKILL.md and workflow.md first.`);
