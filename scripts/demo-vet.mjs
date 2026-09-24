// Shows the vetting rules working on the 24 made-up updates in fixtures/test-pack/.
// Run: node scripts/demo-vet.mjs
// Needs no account, no network and no AI: it calls the same vetUpdates function the
// vet_updates tool uses, on the three test-pack files.
import { vetUpdates } from '../src/lib/vet.ts';
import { loadTestPack } from './lib/testpack.mjs';

const pack = loadTestPack();
const output = vetUpdates(pack);
const byId = new Map(pack.items.map((item) => [item.id, item]));

// Cut long text to fit a column.
const fit = (text, width) => (text.length > width ? `${text.slice(0, width - 3)}...` : text);
// Wrap a sentence into lines of at most `width` characters.
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

console.log(`Newsletter date: ${pack.newsletterDate}   Last issue: ${pack.lastIssueDate}`);
console.log(`Do-not-feature list: ${pack.doNotFeature.map((entry) => entry.name).join(', ')}`);
console.log('');
console.log(`${'ID'.padEnd(3)}  ${'WHAT'.padEnd(30)}  ${'VERDICT'.padEnd(7)}  ${'RULE'.padEnd(13)}  WHY`);
console.log('-'.repeat(110));

for (const result of output.results) {
  const item = byId.get(result.id);
  const what = fit(item.company || item.person || item.title || '(untitled)', 30);
  const [first, ...rest] = wrap(result.reason, 56);
  console.log(`${result.id.padEnd(3)}  ${what.padEnd(30)}  ${result.verdict.toUpperCase().padEnd(7)}  ${result.rule.padEnd(13)}  ${first}`);
  const indent = ' '.repeat(3 + 2 + 30 + 2 + 7 + 2 + 13 + 2);
  for (const line of rest) console.log(`${indent}${line}`);
  // Notes: instructions that were stripped, names that were removed, other rules that also fired.
  for (const flag of result.flags) {
    for (const [i, line] of wrap(flag, 56).entries()) console.log(`${indent}${i === 0 ? '* ' : '  '}${line}`);
  }
}

console.log('-'.repeat(110));
const { feature, hold, drop } = output.counts;
console.log(`Totals: ${feature} feature, ${hold} hold (Bader decides), ${drop} drop   (${output.results.length} updates)`);
