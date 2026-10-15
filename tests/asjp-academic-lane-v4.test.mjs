import assert from 'node:assert/strict';
import test from 'node:test';
import { legalForm, religiousForm, repetitionForm } from '../lib/asjp-academic-lane.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';

/** ASJP lane v4 label forms: religious vs legal, the instrument word boundary, repetition still removed. */
const tok = (text) => tokensForScoringNormalization(text, 2);

test('v4: a scripture quotation is religious text, not legal text, even next to "decreed"', () => {
  const verse = 'whoever kills a soul unless for a soul or for corruption done in the land it is as if he had slain mankind entirely';
  const context = `Because of that, We decreed upon the Children of Israel that ${verse} (Qur'an 5:32)`;
  assert.equal(religiousForm(tok(verse).length, ' “', '” ', context).quoted, true);
  assert.equal(legalForm(tok(verse), ' “', '” ', context), null, '"decreed" is not the instrument "decree"');
});

test('v4: the instrument pattern does not match inside a longer word', () => {
  const q = tok('the parties shall be bound by the provisions');
  assert.equal(legalForm(q, ' “', ' ', 'the codes of conduct and the chartered accountants agree that'), null);
  assert.ok(legalForm(q, ' “', ' ', 'under the Civil Code the text reads'));
  assert.ok(legalForm(q, ' “', ' ', 'Law No. 15-12 provides that'), 'a numbered law is still an instrument');
});

test('v4: no scripture named, no religious form; an unquoted long cluster is not religious', () => {
  assert.equal(religiousForm(30, ' ', ' ', 'the author argues that mankind is responsible for the land'), null);
  assert.equal(religiousForm(120, ' ', '. ', 'as the Bible says, a long paraphrase follows here'), null);
});

test('v4: repeated placeholder text is still recognised at any length', () => {
  const unit = 'enter your abstract here an abstract is a brief comprehensive summary of the contents of the article';
  assert.equal(repetitionForm(tok(Array.from({ length: 8 }, () => unit).join(' ')))?.category, 'PLACEHOLDER_REPETITION');
});
