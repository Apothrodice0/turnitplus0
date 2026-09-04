import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityFields } from '../components/auth/identity-fields.tsx';

/**
 * A2 signup UI — the account-type-dependent institution section.
 *
 * Contract under test (UI only; server validation in
 * tests/account-identity-signup.test.mjs is unchanged):
 *   - student | instructor | researcher  -> institution section shown,
 *     canonical ROR institution required, NO "no institution / independent"
 *     opt-out anywhere in the section.
 *   - independent                        -> institution section is not
 *     rendered at all; collect() submits institution status NONE with no
 *     institution input.
 *
 * Uses the repo's no-jsdom renderToStaticMarkup convention for the visible
 * rendering rule (the `initial.accountType` prop drives it, so no click
 * simulation is needed), plus targeted source assertions for the
 * collect()/state-clearing logic that a static render cannot exercise.
 */

const SOURCE = fs.readFileSync(
  path.join(path.resolve('.'), 'components/auth/identity-fields.tsx'),
  'utf8',
);

function render(initial) {
  return renderToStaticMarkup(
    React.createElement(IdentityFields, { mode: 'signup', initial }),
  );
}

const AFFILIATED_TYPES = ['student', 'instructor', 'researcher'];

// --- rendered output: visibility is driven purely by account type -----------

for (const accountType of AFFILIATED_TYPES) {
  test(`${accountType}: the institution section is shown and asks for a canonical institution`, () => {
    const html = render({ accountType });
    assert.match(html, /class="identity-institution"/, 'the institution fieldset must render for an affiliated account type');
    assert.match(html, /Institution \/ university/, 'the section keeps its label');
    assert.match(html, /Start typing your institution/, 'the searchable institution input must be present');
  });

  test(`${accountType}: the section offers no "no institution / independent" opt-out`, () => {
    const html = render({ accountType });
    assert.doesNotMatch(html, /No institution/i);
    assert.doesNotMatch(html, /I am independent/i);
    assert.doesNotMatch(html, /radiogroup/, 'the old instMode radio group must be gone');
    assert.doesNotMatch(html, /name="instMode"/);
  });
}

test('independent: the institution section is not rendered at all', () => {
  const html = render({ accountType: 'independent' });
  assert.doesNotMatch(html, /identity-institution/, 'no institution fieldset');
  assert.doesNotMatch(html, /Institution \/ university/, 'no institution label');
  assert.doesNotMatch(html, /Start typing your institution/, 'no institution input');
  // ...but the rest of the form still renders (the component did not error out).
  assert.match(html, /Full name/);
  assert.match(html, /Phone number/);
  assert.match(html, /value="independent"/, 'the independent option is still selected');
});

test('no account type chosen yet: the institution section is hidden until a type is picked', () => {
  const html = render(undefined);
  assert.doesNotMatch(html, /identity-institution/);
  assert.doesNotMatch(html, /Institution \/ university/);
});

test('settings mode, an affiliated account with an existing ROR: the section is shown and pre-filled', () => {
  const html = renderToStaticMarkup(
    React.createElement(IdentityFields, {
      mode: 'settings',
      initial: { accountType: 'researcher', institution: { status: 'ROR', rorId: '042nb2s44' } },
    }),
  );
  assert.match(html, /class="identity-institution"/);
  assert.match(html, /042nb2s44/, 'the existing institution selection is reflected in the input');
});

// --- source: logic a static render cannot reach ----------------------------

test('SOURCE: the instMode ("search" | "none") toggle state is fully removed', () => {
  assert.doesNotMatch(SOURCE, /instMode/, 'no instMode state, prop, effect dependency or JSX reference may remain');
  assert.doesNotMatch(SOURCE, /setInstMode/);
});

test('SOURCE: AFFILIATED is exactly student + instructor + researcher', () => {
  const m = SOURCE.match(/const AFFILIATED = new Set<AccountTypeValue>\(\[([^\]]*)\]\)/);
  assert.ok(m, 'AFFILIATED set literal must exist');
  const members = m[1].match(/"[^"]+"/g).map((s) => s.replace(/"/g, '')).sort();
  assert.deepEqual(members, ['instructor', 'researcher', 'student']);
});

test('SOURCE: institutionRequired gates both the section render and collect()', () => {
  assert.match(
    SOURCE,
    /const institutionRequired = accountType !== "" && AFFILIATED\.has\(accountType\)/,
    'institutionRequired is a pure function of account type',
  );
  assert.match(SOURCE, /\{institutionRequired && \(\s*<fieldset className="identity-institution">/, 'the fieldset renders only when institutionRequired');
});

test('SOURCE: collect() submits NONE automatically for a non-affiliated type, with no error', () => {
  // Isolate the institution branch of collect().
  const branch = SOURCE.match(/let institution: CollectedIdentity\["institution"\];[\s\S]*?\n\s*setErrors\(next\);/);
  assert.ok(branch, 'could not locate the institution branch of collect()');
  const text = branch[0];
  assert.match(text, /if \(!institutionRequired\) \{\s*institution = \{ status: "NONE" \};\s*\}/, 'non-affiliated -> NONE, no error pushed');
  assert.match(text, /else if \(instSelected\) \{\s*institution = \{ status: "ROR", rorId: instSelected\.rorId \};/, 'affiliated + selection -> ROR');
  assert.match(text, /else \{\s*next\.institution = "Search for and select your institution\."/, 'affiliated + no selection -> required error');
  assert.doesNotMatch(text, /choose .No institution/i, 'the error text must not offer an opt-out that no longer exists');
});

test('SOURCE: changing account type to a non-affiliated type clears any chosen/typed institution', () => {
  const handler = SOURCE.match(/const nextType = e\.target\.value as AccountTypeValue;[\s\S]*?\n\s{10}\}\}/);
  assert.ok(handler, 'could not locate the account-type onChange handler');
  const text = handler[0];
  assert.match(text, /if \(!AFFILIATED\.has\(nextType\)\) \{\s*setInstSelected\(null\);\s*setInstQuery\(""\);\s*setInstHits\(\[\]\);/, 'affiliated -> independent must clear the ROR selection, query and hits');
});
