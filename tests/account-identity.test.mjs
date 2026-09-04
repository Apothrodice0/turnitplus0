import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  ACCOUNT_TYPES,
  DEFAULT_ACCOUNT_TYPE,
  isAccountType,
  INSTITUTION_STATUSES,
  isInstitutionStatus,
  ROR_ID_RE,
  normalizeRorId,
  rorIdToUrl,
  CITY_STATUSES,
  isCityStatus,
  normalizeGeonamesId,
  GEONAMES_ID_MAX,
  normalizeUnverifiedText,
  normalizeCountryCode,
  getIsoCountry,
  normalizeFullName,
  FULL_NAME_MAX_CODE_POINTS,
  normalizePhoneNumber,
  ACCOUNT_IDENTITY_HMAC_KEY_ENV,
  ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN,
  ACCOUNT_IDENTITY_KDF_DOMAIN,
  ACCOUNT_IDENTITY_FINGERPRINT_KINDS,
  ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING,
  ACCOUNT_IDENTITY_KEY_VERSION,
  ACCOUNT_IDENTITY_NORMALIZATION_VERSION,
  accountIdentityFingerprint,
  getAccountIdentityHmacKey,
  normalizeAccountIdentityProfile,
  claimTrustTier,
  identityClaimIsOwnerEvidenceEligible,
} from "../lib/account-identity.ts";
import { ISO_3166_1_COUNTRIES } from "../lib/iso-3166-1-countries.ts";
import { OWNER_LINK_ACCOUNT_REF_DOMAIN } from "../lib/owner-link.ts";

/**
 * Account Identity FOUNDATION (A1) - PURE-layer tests. No DB. Covers the
 * vocabularies, every canonical/low-trust validator, the Unicode-safe
 * full-name normalizer (ZWJ/ZWNJ preserved, bidi/control rejected), the phone
 * path (delegated to libphonenumber-js), the keyed-fingerprint fail-closed
 * contract, the aggregate profile normalizer, and the scoring/owner-link
 * isolation. All non-ASCII test data is written as \u escapes so the source
 * stays reviewable in plain ASCII.
 */

const repo = path.resolve(".");
const cp = (...codes) => String.fromCodePoint(...codes);
// full_name is REQUIRED (NOT NULL) - every valid profile input carries one.
const NAME = "Test User";

// Representative real names across scripts (escaped).
const NAME_ARABIC = cp(0x645, 0x62d, 0x645, 0x62f, 0x20, 0x639, 0x644, 0x64a); // "Muhammad Ali"
const NAME_CHINESE = cp(0x5f20, 0x4f1f); // "Zhang Wei"
const NAME_CYRILLIC = cp(0x410, 0x43d, 0x43d, 0x430, 0x20, 0x41f, 0x435, 0x442, 0x440, 0x43e, 0x432, 0x430);
const NAME_HINDI = cp(0x930, 0x93e, 0x91c, 0x20, 0x915, 0x941, 0x92e, 0x93e, 0x930);
const NAME_GREEK = cp(0x3a3, 0x3c9, 0x3ba, 0x3c1, 0x3ac, 0x3c4, 0x3b7, 0x3c2);
// French/German with combining vs precomposed:
const NAME_DECOMPOSED = "Jose" + cp(0x301) + " da Silva"; // e + combining acute
const NAME_PRECOMPOSED = cp(0x4a, 0x6f, 0x73, 0xe9) + " da Silva"; // Jos-e-acute
// Persian with ZWNJ, Devanagari with ZWJ:
const NAME_ZWNJ = cp(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645);
const NAME_ZWJ = cp(0x928, 0x92e, 0x938, 0x94d, 0x924, 0x947, 0x200d, 0x91c, 0x940);
const ZWNJ = cp(0x200c);
const ZWJ = cp(0x200d);

// ===========================================================================
// 1 - account type is descriptive identity, not authorization
// ===========================================================================

test("1: account types are exactly student|instructor|researcher|independent, default independent", () => {
  assert.deepEqual([...ACCOUNT_TYPES].sort(), ["independent", "instructor", "researcher", "student"]);
  assert.equal(DEFAULT_ACCOUNT_TYPE, "independent");
  for (const t of ACCOUNT_TYPES) assert.equal(isAccountType(t), true);
  assert.equal(isAccountType("admin"), false, "role values are not account types");
  assert.equal(isAccountType("user"), false);
  assert.equal(isAccountType("STUDENT"), false);
  assert.equal(isAccountType(null), false);
});

// ===========================================================================
// 2 - ROR institution identity (checksum-validated), explicit NONE
// ===========================================================================

test("2: normalizeRorId accepts bare / URL / any-case valid ROR ids and rejects bad checksums & shapes", () => {
  assert.deepEqual([...INSTITUTION_STATUSES].sort(), ["NONE", "ROR", "UNVERIFIED_TEXT"].sort());
  assert.equal(isInstitutionStatus("NONE"), true);
  assert.equal(isInstitutionStatus("USER_TEXT"), false, "no arbitrary trusted USER_TEXT status");

  // real ROR ids (checksum-correct)
  assert.equal(normalizeRorId("03vek6s52"), "03vek6s52");
  assert.equal(normalizeRorId("https://ror.org/03vek6s52"), "03vek6s52");
  assert.equal(normalizeRorId("HTTPS://ROR.ORG/03VEK6S52"), "03vek6s52");
  assert.equal(normalizeRorId("  ror.org/02mhbdp94  "), "02mhbdp94");
  assert.equal(normalizeRorId("http://www.ror.org/013cjyk83"), "013cjyk83");
  assert.match(normalizeRorId("03vek6s52"), ROR_ID_RE);
  assert.equal(rorIdToUrl("03vek6s52"), "https://ror.org/03vek6s52");

  // bad checksum
  assert.equal(normalizeRorId("03vek6s51"), null);
  assert.equal(normalizeRorId("03vek6s50"), null);
  // wrong shape / disallowed Crockford chars (i, l, o, u)
  assert.equal(normalizeRorId("03vek6s5"), null, "too short");
  assert.equal(normalizeRorId("13vek6s52"), null, "must start with 0");
  assert.equal(normalizeRorId("0ivek6s52"), null, "letter 'i' is not Crockford base32");
  assert.equal(normalizeRorId("0olek6s52"), null, "letters 'o'/'l' are not Crockford base32");
  assert.equal(normalizeRorId("grid.5335.0"), null, "a GRID id is not a ROR id");
  assert.equal(normalizeRorId(""), null);
  assert.equal(normalizeRorId(null), null);
});

// ===========================================================================
// 3 - GeoNames city identity, explicit NONE
// ===========================================================================

test("3: normalizeGeonamesId accepts positive integers (string or number) only", () => {
  assert.deepEqual([...CITY_STATUSES].sort(), ["GEONAMES", "NONE", "UNVERIFIED_TEXT"].sort());
  assert.equal(isCityStatus("GEONAMES"), true);
  assert.equal(isCityStatus("LATLON"), false);

  assert.equal(normalizeGeonamesId(5128581), 5128581); // New York City
  assert.equal(normalizeGeonamesId("2643743"), 2643743); // London
  assert.equal(normalizeGeonamesId(1), 1);
  assert.equal(normalizeGeonamesId(GEONAMES_ID_MAX), GEONAMES_ID_MAX);
  assert.equal(normalizeGeonamesId(0), null);
  assert.equal(normalizeGeonamesId(-5), null);
  assert.equal(normalizeGeonamesId(1.5), null);
  assert.equal(normalizeGeonamesId(GEONAMES_ID_MAX + 1), null);
  assert.equal(normalizeGeonamesId("abc"), null);
  assert.equal(normalizeGeonamesId(""), null);
  assert.equal(normalizeGeonamesId(null), null);
});

// ===========================================================================
// 4 - residence country: canonical ISO 3166-1, alpha-2 or alpha-3
// ===========================================================================

test("4: normalizeCountryCode maps to canonical uppercase alpha-2, or null", () => {
  assert.equal(normalizeCountryCode("us"), "US");
  assert.equal(normalizeCountryCode("US"), "US");
  assert.equal(normalizeCountryCode(" usa "), "US");
  assert.equal(normalizeCountryCode("GBR"), "GB");
  assert.equal(normalizeCountryCode("dz"), "DZ");
  assert.equal(normalizeCountryCode("XX"), null);
  assert.equal(normalizeCountryCode("ZZZ"), null);
  assert.equal(normalizeCountryCode("U"), null);
  assert.equal(normalizeCountryCode(""), null);
  assert.equal(normalizeCountryCode(null), null);
  assert.equal(getIsoCountry("FR")?.alpha3, "FRA");
});

test("4b: the bundled ISO 3166-1 dataset is structurally sound", () => {
  assert.ok(
    ISO_3166_1_COUNTRIES.length >= 245 && ISO_3166_1_COUNTRIES.length <= 252,
    `count ${ISO_3166_1_COUNTRIES.length}`,
  );
  const a2 = new Set(), a3 = new Set(), nu = new Set();
  for (const c of ISO_3166_1_COUNTRIES) {
    assert.match(c.alpha2, /^[A-Z]{2}$/, `alpha2 ${c.alpha2}`);
    assert.match(c.alpha3, /^[A-Z]{3}$/, `alpha3 ${c.alpha3}`);
    assert.match(c.numeric, /^[0-9]{3}$/, `numeric ${c.numeric}`);
    assert.ok(typeof c.name === "string" && c.name.length > 0);
    assert.equal(a2.has(c.alpha2), false, `dup alpha2 ${c.alpha2}`);
    assert.equal(a3.has(c.alpha3), false, `dup alpha3 ${c.alpha3}`);
    assert.equal(nu.has(c.numeric), false, `dup numeric ${c.numeric}`);
    a2.add(c.alpha2);
    a3.add(c.alpha3);
    nu.add(c.numeric);
  }
  const spot = {
    US: ["USA", "840"], GB: ["GBR", "826"], FR: ["FRA", "250"], JP: ["JPN", "392"],
    DE: ["DEU", "276"], BR: ["BRA", "076"], ZA: ["ZAF", "710"], IN: ["IND", "356"],
    AU: ["AUS", "036"], CN: ["CHN", "156"], DZ: ["DZA", "012"],
  };
  for (const [k, [a3v, nuv]] of Object.entries(spot)) {
    const row = ISO_3166_1_COUNTRIES.find((c) => c.alpha2 === k);
    assert.ok(row, `missing ${k}`);
    assert.equal(row.alpha3, a3v);
    assert.equal(row.numeric, nuv);
  }
});

// ===========================================================================
// 5 - full name: Unicode-safe normalization
// ===========================================================================

test("5: normalizeFullName does NFC + whitespace collapse, keeps legitimate international names", () => {
  assert.deepEqual(normalizeFullName("  John   Smith  "), { ok: true, value: "John Smith" });
  // NFC: decomposed and precomposed forms converge
  assert.equal(normalizeFullName(NAME_DECOMPOSED).value, normalizeFullName(NAME_PRECOMPOSED).value);
  assert.equal(normalizeFullName(NAME_DECOMPOSED).value, NAME_PRECOMPOSED);

  for (const name of [
    "O'Brien",
    "Jean-Luc Picard",
    "Anne-Sophie",
    NAME_ARABIC,
    NAME_CHINESE,
    NAME_CYRILLIC,
    NAME_HINDI,
    NAME_GREEK,
  ]) {
    assert.equal(normalizeFullName(name).ok, true, `should accept ${JSON.stringify(name)}`);
  }
});

test("5b: ZWJ (U+200D) and ZWNJ (U+200C) are PRESERVED, never stripped", () => {
  const r1 = normalizeFullName(NAME_ZWNJ);
  assert.equal(r1.ok, true);
  assert.ok([...r1.value].includes(ZWNJ), "ZWNJ must survive normalization");

  const r2 = normalizeFullName(NAME_ZWJ);
  assert.equal(r2.ok, true);
  assert.ok([...r2.value].includes(ZWJ), "ZWJ must survive normalization");
});

test("5c: dangerous characters are rejected without damaging valid names", () => {
  const reject = [
    ["Ann" + cp(0x202e) + "evil", "RLO override"],
    [cp(0x202d) + "xyz", "LRO override"],
    [cp(0x2066) + "spoof" + cp(0x2069), "bidi isolates"],
    ["name" + cp(0x200f), "RLM"],
    ["a" + cp(0x200e) + "b", "LRM"],
    ["Arabic mark" + cp(0x61c), "ALM"],
    ["John" + cp(0x00) + "Smith", "NUL"],
    ["a" + cp(0x07) + "b", "BEL"],
    ["a" + cp(0x1b) + "b", "ESC"],
    ["John" + cp(0xd800), "lone high surrogate"],
    ["Jo" + cp(0xad) + "hn", "soft hyphen"],
    ["John" + cp(0x200b) + "Smith", "zero-width space"],
    ["a" + cp(0xfffd) + "b", "replacement character"],
  ];
  for (const [name, why] of reject) {
    assert.deepEqual(normalizeFullName(name), { ok: false, code: "UNSAFE_CHARACTERS" }, `must reject ${why}`);
  }
});

test("5d: empty / no-letter / over-length names are rejected with specific codes", () => {
  assert.equal(normalizeFullName("").code, "EMPTY");
  assert.equal(normalizeFullName("   ").code, "EMPTY");
  assert.equal(normalizeFullName(42).code, "EMPTY");
  assert.equal(normalizeFullName(null).code, "EMPTY");
  assert.equal(normalizeFullName("12345").code, "NO_LETTER");
  assert.equal(normalizeFullName("- . -").code, "NO_LETTER");
  assert.equal(normalizeFullName("A".repeat(FULL_NAME_MAX_CODE_POINTS)).ok, true);
  assert.equal(normalizeFullName("A".repeat(FULL_NAME_MAX_CODE_POINTS + 1)).code, "TOO_LONG");
});

// ===========================================================================
// 6 - low-trust free text (UNVERIFIED_TEXT names)
// ===========================================================================

test("6: normalizeUnverifiedText normalizes but stays low-trust; rejects the same dangerous set", () => {
  assert.equal(normalizeUnverifiedText("  University   of Paris "), "University of Paris");
  assert.equal(normalizeUnverifiedText(NAME_PRECOMPOSED.split(" ")[0]), NAME_PRECOMPOSED.split(" ")[0]);
  assert.equal(normalizeUnverifiedText("bad" + cp(0x202e) + "place"), null);
  assert.equal(normalizeUnverifiedText("x" + cp(0x00) + "y"), null);
  assert.equal(normalizeUnverifiedText("   "), null);
  assert.equal(normalizeUnverifiedText("123"), null, "must contain a letter");
  assert.equal(normalizeUnverifiedText("A".repeat(500)), null);
});

// ===========================================================================
// 7 - phone: delegated ENTIRELY to libphonenumber-js, stored E.164
// ===========================================================================

test("7: normalizePhoneNumber returns E.164 + its own region, delegating validity to libphonenumber-js", () => {
  assert.deepEqual(normalizePhoneNumber("+14155552671"), { ok: true, e164: "+14155552671", phoneRegion: "US" });
  assert.deepEqual(normalizePhoneNumber("+44 20 7946 0958"), { ok: true, e164: "+442079460958", phoneRegion: "GB" });
  // a national number needs its region supplied
  assert.deepEqual(normalizePhoneNumber("020 7946 0958", { defaultCountry: "GB" }), {
    ok: true,
    e164: "+442079460958",
    phoneRegion: "GB",
  });
  assert.equal(normalizePhoneNumber("2079460958").ok, false, "national number with no region is not accepted");

  assert.equal(normalizePhoneNumber("").reason, "EMPTY");
  assert.equal(normalizePhoneNumber("+1 555").reason, "INVALID"); // parseable but not a valid number
  assert.equal(normalizePhoneNumber("not a phone").reason, "NOT_A_NUMBER");
  assert.equal(normalizePhoneNumber("+999999999999").reason, "NOT_A_NUMBER");
});

test("7b: phone region is SEPARATE from residence country", () => {
  const r = normalizeAccountIdentityProfile({ fullName: NAME, countryCode: "FR", phone: { number: "+14155552671" } });
  assert.equal(r.ok, true);
  assert.equal(r.profile.countryCode, "FR", "residence stays FR");
  assert.equal(r.profile.phoneRegion, "US", "phone dial context is US, independently");
  assert.equal(r.profile.phoneE164, "+14155552671");
});

// ===========================================================================
// 8 - keyed fingerprint: fail-closed contract, no fingerprint written in A1
// ===========================================================================

test("8: accountIdentityFingerprint fails closed without a key, and NEVER for an unverified value", () => {
  const original = process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
  const ROOT = "test-only-identity-root-hmac-key";
  try {
    delete process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
    assert.equal(getAccountIdentityHmacKey(), null);
    assert.equal(accountIdentityFingerprint("VERIFIED_EMAIL", "a@b.test", { verified: true }), null, "no key -> null");

    process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = ROOT;
    assert.equal(accountIdentityFingerprint("VERIFIED_EMAIL", "a@b.test", { verified: false }), null, "unverified -> null even with a key");
    assert.equal(accountIdentityFingerprint("VERIFIED_EMAIL", "a@b.test", {}), null);
    assert.equal(accountIdentityFingerprint("SOMETHING_ELSE", "x", { verified: true }), null, "unknown kind -> null");
    assert.equal(accountIdentityFingerprint("VERIFIED_EMAIL", "", { verified: true }), null, "empty value -> null");

    const fp1 = accountIdentityFingerprint("VERIFIED_EMAIL", "a@b.test", { verified: true });
    assert.match(fp1, /^[0-9a-f]{64}$/);
    assert.equal(fp1, accountIdentityFingerprint("VERIFIED_EMAIL", "a@b.test", { verified: true }), "deterministic");
    assert.notEqual(fp1, "a@b.test");
    assert.notEqual(
      accountIdentityFingerprint("VERIFIED_EMAIL", "c@d.test", { verified: true }),
      fp1,
      "different value -> different digest",
    );
    assert.notEqual(ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN, OWNER_LINK_ACCOUNT_REF_DOMAIN);
    assert.notEqual(ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN, ACCOUNT_IDENTITY_KDF_DOMAIN);
  } finally {
    if (original === undefined) delete process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
    else process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = original;
  }
});

test("8b: the HMAC key is derived PER KIND - one value under different kinds gives cryptographically unrelated digests", () => {
  const original = process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
  const ROOT = "test-only-identity-root-hmac-key";
  try {
    process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = ROOT;
    const VALUE = "shared-value";
    const digests = ACCOUNT_IDENTITY_FINGERPRINT_KINDS.map((k) =>
      accountIdentityFingerprint(k, VALUE, { verified: true }),
    );
    // all three kinds of the SAME value are mutually distinct
    assert.equal(new Set(digests).size, ACCOUNT_IDENTITY_FINGERPRINT_KINDS.length, "each kind yields a distinct digest for one value");

    // and it is genuinely a derived-key HMAC, not HMAC(root, domain+kind+value)
    for (const kind of ACCOUNT_IDENTITY_FINGERPRINT_KINDS) {
      const perKindKey = createHmac("sha256", ROOT).update(ACCOUNT_IDENTITY_KDF_DOMAIN + kind, "utf8").digest();
      const expected = createHmac("sha256", perKindKey)
        .update(ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN + VALUE, "utf8")
        .digest("hex");
      assert.equal(accountIdentityFingerprint(kind, VALUE, { verified: true }), expected, `${kind} uses the derived per-kind key`);

      const naiveSingleKey = createHmac("sha256", ROOT)
        .update(ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN + kind + VALUE, "utf8")
        .digest("hex");
      assert.notEqual(accountIdentityFingerprint(kind, VALUE, { verified: true }), naiveSingleKey, `${kind} is NOT a single-root-key HMAC`);
    }

    // keyless / unverified still fail closed
    delete process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
    assert.equal(accountIdentityFingerprint("VERIFIED_PHONE_E164", "shared-value", { verified: true }), null);
    process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = ROOT;
    assert.equal(accountIdentityFingerprint("VERIFIED_PHONE_E164", "shared-value", { verified: false }), null);
  } finally {
    if (original === undefined) delete process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
    else process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV] = original;
  }
});

test("8c: the per-kind owner-link evidence ceiling matches the structural reality of each identity value", () => {
  // primary verified login email: ux_users_email makes it unique, so two live
  // accounts can never share it -> exact equality is not an owner-link signal.
  assert.equal(ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING.VERIFIED_EMAIL, "ACCOUNT_ONLY");
  // an entire campus shares one verified ROR -> institution equality is never ownership proof.
  assert.equal(ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING.VERIFIED_INSTITUTION_ROR, "SUPPORTING");
  // a verified shared phone MAY, after a separate confidence review, become HIGH - but not automatically.
  assert.equal(ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING.VERIFIED_PHONE_E164, "ESTABLISHING_CANDIDATE");
  // NO kind is bare "ESTABLISHING" (automatic ownership proof) in A1.
  assert.equal(Object.values(ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING).includes("ESTABLISHING"), false);
  // every fingerprint kind has an explicit ceiling, and every ceiling is one of the three tiers.
  assert.deepEqual(
    Object.keys(ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING).sort(),
    [...ACCOUNT_IDENTITY_FINGERPRINT_KINDS].sort(),
  );
  for (const tier of Object.values(ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING)) {
    assert.ok(["ACCOUNT_ONLY", "SUPPORTING", "ESTABLISHING_CANDIDATE"].includes(tier), tier);
  }

  // collapse whitespace AND JSDoc "*" line prefixes so prose assertions are wrap-agnostic
  const prose = (p) => fs.readFileSync(path.join(repo, p), "utf8").replace(/[\s*]+/g, " ");
  const src = prose("lib/account-identity.ts");
  // the "primary email equality cannot link two live accounts" fact is pinned in the source
  assert.match(src, /ux_users_email makes that column UNIQUE/);
  assert.match(src, /STRUCTURALLY UNAVAILABLE/);
  assert.match(src, /Do NOT weaken or remove ux_users_email/);
  assert.match(src, /A1 adds no recovery-email feature/);
  // a future recovery email / OAuth subject / SSO subject is called out as a SEPARATE kind
  assert.match(src, /VERIFIED_RECOVERY_EMAIL|OAUTH_PROVIDER_SUBJECT|INSTITUTIONAL_SSO_SUBJECT/);
  // institution equality is never ownership proof
  assert.match(src, /institution equality[\s\S]{0,80}(never|NEVER)/i);

  // ux_users_email must still be declared, unchanged, in db/schema.ts (do not weaken it)
  const schema = fs.readFileSync(path.join(repo, "db", "schema.ts"), "utf8").replace(/\s+/g, " ");
  assert.match(schema, /uniqueIndex\("ux_users_email"\)\.on\(table\.email\)/);
});

// ===========================================================================
// 9 - aggregate profile validation
// ===========================================================================

test("9: normalizeAccountIdentityProfile - full name is REQUIRED; otherwise the minimal profile is the safe default", () => {
  // a missing / blank name is a validation error (full_name is NOT NULL)
  for (const bad of [{}, { fullName: null }, { fullName: "" }, { fullName: "   " }, { fullName: "\t\n " }]) {
    const r = normalizeAccountIdentityProfile(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.filter((e) => e.field === "fullName").map((e) => e.code), ["REQUIRED"]);
  }
  // a bad-but-present name reports the specific normalizer code, not REQUIRED
  assert.equal(
    normalizeAccountIdentityProfile({ fullName: "Ann" + cp(0x202e) + "evil" }).errors.find((e) => e.field === "fullName").code,
    "UNSAFE_CHARACTERS",
  );

  // name-only input => the unaffiliated default for everything else
  const r = normalizeAccountIdentityProfile({ fullName: "  Grace   Hopper " });
  assert.equal(r.ok, true);
  assert.deepEqual(r.profile, {
    accountType: "independent",
    fullName: "Grace Hopper",
    countryCode: null,
    institutionStatus: "NONE",
    institutionRorId: null,
    institutionUnverifiedName: null,
    cityStatus: "NONE",
    cityGeonamesId: null,
    cityUnverifiedName: null,
    phoneE164: null,
    phoneRegion: null,
    normalizationVersion: ACCOUNT_IDENTITY_NORMALIZATION_VERSION,
    emailVerified: false,
    phoneVerified: false,
    institutionVerified: false,
  });
});

test("9b: a fully-populated canonical profile normalizes end to end", () => {
  const r = normalizeAccountIdentityProfile({
    accountType: "researcher",
    fullName: "  Dr.   Ada  Lovelace ",
    countryCode: "gb",
    institution: { status: "ROR", rorId: "https://ror.org/02mhbdp94" },
    city: { status: "GEONAMES", geonamesId: "2643743" },
    phone: { number: "+44 20 7946 0958" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.profile.accountType, "researcher");
  assert.equal(r.profile.fullName, "Dr. Ada Lovelace");
  assert.equal(r.profile.countryCode, "GB");
  assert.equal(r.profile.institutionStatus, "ROR");
  assert.equal(r.profile.institutionRorId, "02mhbdp94");
  assert.equal(r.profile.cityStatus, "GEONAMES");
  assert.equal(r.profile.cityGeonamesId, 2643743);
  assert.equal(r.profile.phoneE164, "+442079460958");
});

test("9c: institution / city accept an explicit NONE and a low-trust UNVERIFIED_TEXT", () => {
  const none = normalizeAccountIdentityProfile({ fullName: NAME, accountType: "independent", institution: { status: "NONE" } });
  assert.equal(none.ok, true);
  assert.equal(none.profile.institutionStatus, "NONE");

  const txt = normalizeAccountIdentityProfile({
    fullName: NAME,
    institution: { status: "UNVERIFIED_TEXT", name: "  Some College  " },
    city: { status: "UNVERIFIED_TEXT", name: "Springfield" },
  });
  assert.equal(txt.ok, true);
  assert.equal(txt.profile.institutionStatus, "UNVERIFIED_TEXT");
  assert.equal(txt.profile.institutionUnverifiedName, "Some College");
  assert.equal(txt.profile.cityUnverifiedName, "Springfield");
});

test("9d: invalid fields accumulate value-free errors (privacy)", () => {
  const r = normalizeAccountIdentityProfile({
    accountType: "wizard",
    fullName: "Ann" + cp(0x202e) + "evil",
    countryCode: "ZQ",
    institution: { status: "ROR", rorId: "not-a-ror" },
    city: { status: "GEONAMES", geonamesId: -1 },
    phone: { number: "+1 555 secretpart" },
  });
  assert.equal(r.ok, false);
  const byField = Object.fromEntries(r.errors.map((e) => [e.field, e.code]));
  assert.equal(byField.accountType, "UNKNOWN_ACCOUNT_TYPE");
  assert.equal(byField.fullName, "UNSAFE_CHARACTERS");
  assert.equal(byField.countryCode, "UNKNOWN_COUNTRY");
  assert.equal(byField.institution, "INVALID_ROR_ID");
  assert.equal(byField.city, "INVALID_GEONAMES_ID");
  assert.ok(byField.phone && byField.phone.startsWith("PHONE_"));
  const blob = JSON.stringify(r.errors);
  for (const leak of ["secretpart", "Ann", "evil", "555", "not-a-ror"]) {
    assert.equal(blob.includes(leak), false, `error blob must not echo ${JSON.stringify(leak)}`);
  }
});

// ===========================================================================
// 10 - nothing is verified, nothing is owner evidence, in A1
// ===========================================================================

test("10: verification is always unverified and no claim is owner-evidence-eligible in A1", () => {
  const inputs = [
    { fullName: NAME },
    { fullName: NAME, accountType: "student", institution: { status: "ROR", rorId: "03vek6s52" }, phone: { number: "+14155552671" } },
    { fullName: NAME, city: { status: "GEONAMES", geonamesId: 5128581 }, countryCode: "US" },
    { fullName: NAME, institution: { status: "UNVERIFIED_TEXT", name: "Some University" } },
  ];
  for (const input of inputs) {
    const r = normalizeAccountIdentityProfile(input);
    assert.equal(r.ok, true);
    assert.equal(r.profile.emailVerified, false);
    assert.equal(r.profile.phoneVerified, false);
    assert.equal(r.profile.institutionVerified, false);
    assert.equal(identityClaimIsOwnerEvidenceEligible(r.profile), false);
  }
  assert.equal(claimTrustTier("NONE"), "NONE");
  assert.equal(claimTrustTier("ROR"), "CANONICAL_UNVERIFIED");
  assert.equal(claimTrustTier("GEONAMES"), "CANONICAL_UNVERIFIED");
  assert.equal(claimTrustTier("UNVERIFIED_TEXT"), "UNVERIFIED_TEXT");
});

// ===========================================================================
// 11 - the lib vocabularies mirror the drizzle/0045 CHECK constraints
// ===========================================================================

test("11: lib/account-identity.ts vocabularies match the drizzle/0045 CHECK lists exactly", () => {
  const sql = fs.readFileSync(path.join(repo, "drizzle", "0045_account_identity.sql"), "utf8");
  const checkList = (column) => {
    const m = sql.match(new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`));
    assert.ok(m, `no CHECK ... ${column} IN (...) in drizzle/0045`);
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  };
  assert.deepEqual(checkList("account_type"), new Set(ACCOUNT_TYPES));
  assert.deepEqual(checkList("institution_status"), new Set(INSTITUTION_STATUSES));
  assert.deepEqual(checkList("city_status"), new Set(CITY_STATUSES));
  assert.deepEqual(checkList("fingerprint_kind"), new Set(ACCOUNT_IDENTITY_FINGERPRINT_KINDS));
  assert.equal(ACCOUNT_IDENTITY_KEY_VERSION, 1);
});

// ===========================================================================
// 12 - isolation: no scoring / auth / owner-link / Device Passport coupling
// ===========================================================================

test("12: no scoring / matcher / auth-flow / owner-link module imports account-identity, and vice versa", () => {
  const importLines = (src) =>
    src.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  const IDENTITY_RE = /account-identity/;

  const mustNotImportIdentity = [
    "lib/report-primary-similarity.ts",
    "lib/unified-similarity.ts",
    "lib/similarity-core.ts",
    "lib/report-types.ts",
    "lib/report-historical-match.ts",
    "lib/user-submission-matching.ts",
    "lib/owner-link.ts",
    "lib/owner-link-repo.ts",
    "lib/device-passport-server.ts",
    "lib/admin-role.ts",
    "lib/auth-session.ts",
    "lib/account-deletion.ts",
    "app/api/auth/signup/route.ts",
    "app/api/auth/login/route.ts",
    "app/api/reports/route.ts",
    "app/api/reports/[id]/route.ts",
  ];
  for (const rel of mustNotImportIdentity) {
    const full = path.join(repo, rel);
    if (!fs.existsSync(full)) continue;
    assert.doesNotMatch(importLines(fs.readFileSync(full, "utf8")), IDENTITY_RE, `${rel} must not import account-identity`);
  }

  for (const rel of ["lib/account-identity.ts", "lib/account-identity-repo.ts"]) {
    const imports = importLines(fs.readFileSync(path.join(repo, rel), "utf8"));
    for (const forbidden of [
      "unified-similarity",
      "report-primary-similarity",
      "similarity-core",
      "user-submission-matching",
      "report-historical-match",
      "owner-link",
      "device-passport",
      "device-self-scoring",
      "corpus-",
    ]) {
      assert.doesNotMatch(imports, new RegExp(forbidden), `${rel} must not import ${forbidden}`);
    }
  }

  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };
  const appImporters = walk(path.join(repo, "app"))
    .filter((f) => IDENTITY_RE.test(importLines(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(repo, f).split(path.sep).join("/"));
  assert.deepEqual(appImporters, [], `no app/ file may import an account-identity module yet: ${appImporters.join(", ")}`);
});
