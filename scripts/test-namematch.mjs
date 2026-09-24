// Unit tests for shared name matching. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameName, findNameMentions, removeNameMentions } from '../src/lib/nameMatch.ts';

// Odd characters are built from code points, so they cannot be lost or changed when this file is edited.
const cp = (...codes) => String.fromCodePoint(...codes);
const ZERO_WIDTH_SPACE = cp(0x200b);
const SOFT_HYPHEN = cp(0x00ad);
const E_ACUTE = cp(0x00e9);
const O_CIRCUMFLEX = cp(0x00f4);
const COMBINING_ACUTE = cp(0x0301);
const FULLWIDTH_T = cp(0xff34);

test('sameName ignores case, punctuation and spacing', () => {
  assert.equal(sameName('Tidewater Maps', ' tidewater   maps. '), true);
  assert.equal(sameName('Tidewater Maps', 'Tidewater Map'), false);
  assert.equal(sameName('', ''), false);
});

test('findNameMentions matches whole words only', () => {
  assert.deepEqual(findNameMentions('Winner: TIDEWATER MAPS, flood-risk maps for small towns.', ['Tidewater Maps', 'Brightlane Co']), ['Tidewater Maps']);
  assert.deepEqual(findNameMentions('Adaptive tools for teams', ['Ada']), []);
  assert.deepEqual(findNameMentions('nothing here', ['Tidewater Maps']), []);
});

test('REGRESSION: HTML entities cannot hide a name (numeric, hex, without the ";", named)', () => {
  const found = (text) => findNameMentions(text, ['Tidewater Maps']).length === 1;
  assert.ok(found('Tidew&#97;ter Maps'));
  assert.ok(found('Tidew&#x61;ter Maps'));
  assert.ok(found('Tidew&#X61;ter Maps'));
  assert.ok(found('Tidew&#97ter Maps'), 'a browser also reads a numeric entity that has no closing ";"');
  assert.ok(found('Tide&shy;water Maps'));
  assert.ok(found('Tide&#8203;water Maps'));
  assert.ok(found('Tide&#173;water Maps'));
  assert.ok(found('Tidewater&nbsp;Maps'));
  assert.ok(found('Tidewater&#160;Maps'));
  assert.ok(found('&#84;idewater &#77;aps'));
  assert.ok(findNameMentions('Thanks Smith &amp; Sons', ['Smith & Sons']).length === 1);
});

test('REGRESSION: invisible characters cannot hide a name (zero-width space, soft hyphen, joiners, BOM)', () => {
  const found = (text) => findNameMentions(text, ['Tidewater Maps']).length === 1;
  assert.ok(found(`Tide${ZERO_WIDTH_SPACE}water Maps`));
  assert.ok(found(`Tide${SOFT_HYPHEN}water Maps`));
  assert.ok(found(`Tide${cp(0x200d)}water${cp(0x200c)} Maps`));
  assert.ok(found(`${cp(0xfeff)}Tidewater Maps`));
  assert.ok(found(`Tidewater${cp(0x2060)} Maps`));
  assert.ok(sameName('Tidewater Maps', `Tide${ZERO_WIDTH_SPACE}water Maps`));
  // ...and a name saved with an invisible character in it still matches plain text.
  assert.ok(findNameMentions('Tidewater Maps', [`Tide${SOFT_HYPHEN}water Maps`]).length === 1);
});

test('REGRESSION: look-alike (fullwidth) letters cannot hide a name', () => {
  assert.equal(findNameMentions(`${FULLWIDTH_T}idewater Maps`, ['Tidewater Maps']).length, 1);
  assert.equal(findNameMentions(`${FULLWIDTH_T}IDEWATER ${cp(0xff2d)}APS`, ['Tidewater Maps']).length, 1);
});

test('REGRESSION: accents, entities for accented letters and NFC/NFD forms all match each other', () => {
  const name = `Ren${E_ACUTE}e C${O_CIRCUMFLEX}t${E_ACUTE}`; // Renée Côté
  assert.equal(findNameMentions('Ren&eacute;e C&ocirc;t&eacute; joins us', [name]).length, 1);
  assert.equal(findNameMentions('REN&Eacute;E C&Ocirc;T&Eacute;', [name]).length, 1);
  assert.equal(findNameMentions(`Ren${E_ACUTE}e C${O_CIRCUMFLEX}t${E_ACUTE}`, ['Ren&eacute;e C&ocirc;t&eacute;']).length, 1);
  assert.equal(findNameMentions(name.normalize('NFD'), [name.normalize('NFC')]).length, 1, 'decomposed text, composed name');
  assert.equal(findNameMentions(name.normalize('NFC'), [name.normalize('NFD')]).length, 1, 'composed text, decomposed name');
  assert.equal(findNameMentions(`Rene${COMBINING_ACUTE}e Cote`, [name]).length, 1);
  assert.equal(findNameMentions('Renee Cote', [name]).length, 1, 'leaving the accents off does not hide a name either');
  assert.ok(sameName(name, 'Renee Cote'));
  assert.ok(sameName(`${cp(0x0130)}stanbul`, 'istanbul'), 'a capital dotted I does not bring a stray mark back');
});

test('entities and odd characters do not create false matches, and odd input does not crash', () => {
  assert.deepEqual(findNameMentions('Ad&#97;ptive tools', ['Ada']), [], 'still whole words only');
  assert.deepEqual(findNameMentions(`Ad${ZERO_WIDTH_SPACE}aptive tools`, ['Ada']), []);
  assert.deepEqual(findNameMentions('&constructor; &toString; &__proto__; tidewater maps', ['Tidewater Maps']), ['Tidewater Maps']);
  for (const text of ['&#0;', '&#99999999;', '&#xFFFFFFF;', '&#xD800;', '&;', '&#;', '&#x;', '&']) {
    assert.doesNotThrow(() => findNameMentions(text, ['Tidewater Maps']), text);
  }
});

test('removeNameMentions replaces the name and keeps the rest of the sentence', () => {
  const out = removeNameMentions('40 people, 9 demos. Winner: Tidewater Maps, flood-risk maps for small towns.', ['Tidewater Maps']);
  assert.doesNotMatch(out, /tidewater/i);
  assert.match(out, /40 people, 9 demos/);
});

test('REGRESSION: removeNameMentions works for a name that starts (or ends) with an accented letter', () => {
  const elise = `${cp(0x00c9)}lise Roy`; // Élise Roy
  const out = removeNameMentions(`Meet ${elise} today, and ${cp(0x00c9)}LISE ROY too.`, [elise]);
  assert.doesNotMatch(out, /lise/i);
  assert.match(out, /^Meet a Volta company today, and a Volta company too\.$/);
  assert.equal(removeNameMentions(`${elise}ce is someone else`, [elise]), `${elise}ce is someone else`, 'still whole words only');
  assert.equal(removeNameMentions(`${cp(0x00c9)}lise Roy`.normalize('NFD'), [elise.normalize('NFC')]), 'a Volta company', 'decomposed text, composed name');
  const cafe = `Caf${E_ACUTE} Nord`;
  assert.equal(removeNameMentions(`Try ${cafe}!`, [cafe]), 'Try a Volta company!');
  assert.equal(removeNameMentions('Thanks, Smith & Sons.', ['Smith & Sons']), 'Thanks, a Volta company.');
});

test('removeNameMentions ignores names too short to match safely', () => {
  assert.equal(removeNameMentions('a b c', ['a']), 'a b c');
  assert.equal(removeNameMentions('a b c - - -', ['- - -', '', '   ', '!!']), 'a b c - - -');
  assert.equal(removeNameMentions('a b c', [`${SOFT_HYPHEN}a`]), 'a b c', 'one letter once the invisible character is gone');
  assert.equal(removeNameMentions(null, ['Tidewater Maps']), '');
});

test('REGRESSION: removeNameMentions stays fast for names of standalone punctuation words and for huge input', () => {
  // Before the fix, this took about 3 seconds at 60 and about 34 seconds at 80 (backtracking).
  let start = Date.now();
  assert.equal(removeNameMentions(`x${'-'.repeat(80)}`, ['x - - - - - - -']), `x${'-'.repeat(80)}`);
  assert.ok(Date.now() - start < 500, `took ${Date.now() - start} ms`);

  start = Date.now();
  const huge = removeNameMentions('x '.repeat(300_000), ['Tidewater Maps', 'x - - - - - - -', 'Brightlane Co']);
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`);
  assert.ok(huge.length <= 50_000, 'only the first 50 000 characters are read; the rest is dropped');
  assert.doesNotMatch(removeNameMentions(`${'x '.repeat(100_000)}Tidewater Maps`, ['Tidewater Maps']), /tidewater/i, 'a name past the cut cannot survive');
});
