// Unit tests for shared name matching. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameName, findNameMentions, removeNameMentions } from '../src/lib/nameMatch.ts';

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

test('removeNameMentions replaces the name and keeps the rest of the sentence', () => {
  const out = removeNameMentions('40 people, 9 demos. Winner: Tidewater Maps, flood-risk maps for small towns.', ['Tidewater Maps']);
  assert.doesNotMatch(out, /tidewater/i);
  assert.match(out, /40 people, 9 demos/);
});
