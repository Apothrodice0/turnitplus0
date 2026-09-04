import { createHmac } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { CountryCode } from "libphonenumber-js";
import { isoCountryByAlpha2, isoCountryByAlpha3, type IsoCountry } from "./iso-3166-1-countries";

/**
 * Account Identity FOUNDATION (A1) - the PURE layer: account-type / institution
 * / city / country / phone / full-name vocabularies and validators, plus the
 * keyed-fingerprint derivation CONTRACT. No database, no I/O; the only
 * environment read is the dedicated identity HMAC secret (fresh on every call,
 * no caching - the lib/owner-link.ts convention). The DB helpers live in
 * lib/account-identity-repo.ts.
 *
 * WHAT THIS IS
 * A per-account 1:1 identity profile sitting beside `users` (never a new
 * required column on `users`). It records what KIND of account this is and,
 * optionally, where the person is and how to reach them - as CANONICAL
 * identifiers wherever possible (ISO 3166-1 country, ROR institution, GeoNames
 * city, E.164 phone).
 *
 * WHAT THIS IS NOT
 *   - NOT authorization. `users.role` (user | admin) is the ONLY authorization
 *     field and is untouched here. Account TYPE (student | instructor |
 *     researcher | independent) is descriptive identity, never a permission.
 *   - NOT a verification system. In A1 every value is UNVERIFIED. Nothing in
 *     this module or its repo can mark an email, phone, or institution VERIFIED,
 *     and no HMAC fingerprint is ever derived from an unverified value
 *     (accountIdentityFingerprint fails closed unless { verified: true }).
 *   - NOT owner evidence. A raw UNVERIFIED_TEXT institution/city string is
 *     explicitly LOW-TRUST and can never feed owner-link inference - see
 *     identityClaimIsOwnerEvidenceEligible (always false in A1).
 *   - NOT wired into scoring / similarity / owner-link / Device Passport /
 *     corpus in any way. tests/account-identity.test.mjs pins the isolation.
 *
 * PRIVACY: callers must never log a raw phone number, a full name, or a
 * fingerprint. Validation errors here are field + machine code only - they
 * never echo the offending value.
 */

// ===========================================================================
// account type - descriptive identity, NEVER authorization
// ===========================================================================

/**
 * The kind of account. `independent` covers any non-affiliated / personal user
 * and is the safe default when nothing is chosen - it makes NO institutional
 * claim. `users.role` stays the sole authorization field (user | admin).
 */
export const ACCOUNT_TYPES = ["student", "instructor", "researcher", "independent"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Absent a deliberate choice, an account is unaffiliated `independent`. */
export const DEFAULT_ACCOUNT_TYPE: AccountType = "independent";

const ACCOUNT_TYPE_SET: ReadonlySet<string> = new Set(ACCOUNT_TYPES);

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && ACCOUNT_TYPE_SET.has(value);
}

// ===========================================================================
// institution identity - designed around ROR IDs, with an explicit NONE state
// ===========================================================================

/**
 *   NONE            explicitly non-affiliated. NOT a missing value - a positive
 *                   statement, so an independent user is never forced to invent
 *                   fake university data.
 *   ROR             a canonical Research Organization Registry identifier.
 *   UNVERIFIED_TEXT a low-trust free-text institution name. Exists ONLY for
 *                   future compatibility (importing a legacy self-reported
 *                   string). It is permanently ineligible as owner evidence
 *                   until it is BOTH canonicalized to a ROR ID AND independently
 *                   verified - see identityClaimIsOwnerEvidenceEligible.
 */
export const INSTITUTION_STATUSES = ["NONE", "ROR", "UNVERIFIED_TEXT"] as const;
export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];

const INSTITUTION_STATUS_SET: ReadonlySet<string> = new Set(INSTITUTION_STATUSES);
export function isInstitutionStatus(value: unknown): value is InstitutionStatus {
  return typeof value === "string" && INSTITUTION_STATUS_SET.has(value);
}

/**
 * A ROR ID body: "0" + 6 Crockford-base32 chars (lowercase, no i/l/o/u) + 2
 * decimal check digits. The full identifier is "https://ror.org/" + this.
 */
export const ROR_ID_RE = /^0[0-9a-hjkmnp-tv-z]{6}[0-9]{2}$/;
const ROR_URL_PREFIX_RE = /^(?:https?:\/\/)?(?:www\.)?ror\.org\//i;
const CROCKFORD_BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** ISO 7064 MOD 97-10 check of a ROR ID body (last two chars are the checksum). */
function rorChecksumValid(body: string): boolean {
  const digits = body.slice(0, -2);
  const check = Number.parseInt(body.slice(-2), 10);
  let value = 0;
  for (const ch of digits) {
    const idx = CROCKFORD_BASE32.indexOf(ch);
    if (idx < 0) return false;
    value = value * 32 + idx;
  }
  return 98 - ((value * 100) % 97) === check;
}

/**
 * Normalize any ROR input (bare body or a ror.org URL, any case) to the
 * canonical lowercase 9-character body, or null if it is not a structurally
 * valid, checksum-correct ROR ID.
 */
export function normalizeRorId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const body = input.trim().replace(ROR_URL_PREFIX_RE, "").toLowerCase();
  if (!ROR_ID_RE.test(body)) return null;
  return rorChecksumValid(body) ? body : null;
}

/** The canonical URL form of a ROR ID body (for display / linking only). */
export function rorIdToUrl(body: string): string {
  return `https://ror.org/${body}`;
}

// ===========================================================================
// city identity - designed around GeoNames IDs, with an explicit NONE state
// ===========================================================================

/**
 *   NONE            no city recorded (a positive "not provided", not an error).
 *   GEONAMES        a canonical GeoNames feature id (integer).
 *   UNVERIFIED_TEXT a low-trust free-text place name - same permanent
 *                   owner-evidence ineligibility as an UNVERIFIED_TEXT
 *                   institution.
 */
export const CITY_STATUSES = ["NONE", "GEONAMES", "UNVERIFIED_TEXT"] as const;
export type CityStatus = (typeof CITY_STATUSES)[number];

const CITY_STATUS_SET: ReadonlySet<string> = new Set(CITY_STATUSES);
export function isCityStatus(value: unknown): value is CityStatus {
  return typeof value === "string" && CITY_STATUS_SET.has(value);
}

/** GeoNames ids are positive integers; the registry is ~13M and growing, so cap generously. */
export const GEONAMES_ID_MAX = 2_147_483_647;

export function normalizeGeonamesId(input: unknown): number | null {
  const n = typeof input === "string" ? Number(input.trim()) : input;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > GEONAMES_ID_MAX) return null;
  return n;
}

// ===========================================================================
// dangerous character set - shared by full-name and low-trust-text normalizers
// ===========================================================================

/**
 * Whether a string (already NFC-normalized and whitespace-collapsed) contains a
 * code point that is ALWAYS unsafe in a name or low-trust text. Implemented as
 * an explicit code-point scan rather than a control-character regex so the set
 * stays reviewable in plain ASCII and no eslint no-control-regex exception is
 * needed. Rejected:
 *   - C0/C1 controls (U+0000..U+0008, U+000E..U+001F, U+007F..U+009F). The
 *     whitespace controls U+0009..U+000D were already collapsed to a space.
 *   - invisible format characters with no legitimate role in a canonical name:
 *     U+00AD soft hyphen, U+180E Mongolian vowel separator, U+200B ZERO WIDTH
 *     SPACE.
 *   - the bidi mark / override / embedding / isolate set - the "Trojan Source"
 *     characters: U+061C, U+200E, U+200F, U+202A..U+202E, U+2066..U+2069.
 *   - interlinear-annotation controls U+FFF9..U+FFFB.
 *   - U+FFFD replacement character (its presence means the data is already
 *     mojibake) and the U+FFFE/U+FFFF non-characters.
 *   - any unpaired surrogate (U+D800..U+DFFF as a lone code unit).
 * NOT rejected: U+200C ZWNJ and U+200D ZWJ - both are REQUIRED by legitimate
 * names in many scripts (Persian, Indic) and by emoji-family sequences, so they
 * are deliberately left intact. Combining marks likewise pass through untouched.
 */
function hasUnsafeTextCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i); // UTF-16 code unit - lone surrogates stay visible
    if (code <= 0x08) return true;
    if (code >= 0x0e && code <= 0x1f) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code === 0x00ad || code === 0x180e || code === 0x200b) return true;
    if (code === 0x061c || code === 0x200e || code === 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code >= 0xfff9 && code <= 0xfffb) return true;
    if (code === 0xfffd || code === 0xfffe || code === 0xffff) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // a well-formed surrogate pair - skip both units
        continue;
      }
      return true; // lone high surrogate
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true; // lone low surrogate
  }
  return false;
}

// ===========================================================================
// low-trust free text (UNVERIFIED_TEXT institution / city names)
// ===========================================================================

export const UNVERIFIED_TEXT_MAX_CODE_POINTS = 200;

/**
 * Normalize a low-trust free-text place / institution name: NFC, collapse all
 * Unicode whitespace to single spaces, reject the dangerous character set, cap
 * length, require a letter. Returns null if nothing usable remains. The RESULT
 * is still low-trust - normalization is not verification.
 */
export function normalizeUnverifiedText(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const collapsed = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  if (hasUnsafeTextCharacter(collapsed)) return null;
  if ([...collapsed].length > UNVERIFIED_TEXT_MAX_CODE_POINTS) return null;
  if (!/\p{L}/u.test(collapsed)) return null;
  return collapsed;
}

// ===========================================================================
// residence country - canonical ISO 3166-1 (see lib/iso-3166-1-countries.ts)
// ===========================================================================

/**
 * Normalize a residence country to an ISO 3166-1 alpha-2 (uppercase). Accepts
 * alpha-2 or alpha-3, any case. Returns null for anything not officially
 * assigned. This is RESIDENCE only - it is never derived from, or conflated
 * with, the phone number's dial/region context.
 */
export function normalizeCountryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toUpperCase();
  if (raw.length === 2) return isoCountryByAlpha2(raw)?.alpha2 ?? null;
  if (raw.length === 3) return isoCountryByAlpha3(raw)?.alpha2 ?? null;
  return null;
}

export function getIsoCountry(alpha2: string): IsoCountry | undefined {
  return isoCountryByAlpha2(alpha2);
}

// ===========================================================================
// full name - Unicode-safe normalization
// ===========================================================================

export const FULL_NAME_MAX_CODE_POINTS = 200;

export type FullNameResult = { ok: true; value: string } | { ok: false; code: FullNameRejectCode };
export type FullNameRejectCode = "EMPTY" | "UNSAFE_CHARACTERS" | "TOO_LONG" | "NO_LETTER";

/**
 * Normalize a person's full name safely across scripts:
 *   1. Unicode NFC (so a composed and a decomposed "e-acute" store identically).
 *   2. Collapse every run of Unicode whitespace to a single U+0020 and trim.
 *   3. Reject the dangerous character set WITHOUT touching ZWJ / ZWNJ or any
 *      combining mark - legitimate international names are preserved.
 *   4. Require at least one letter; cap at FULL_NAME_MAX_CODE_POINTS code points.
 * The returned value must never be logged.
 */
export function normalizeFullName(input: unknown): FullNameResult {
  if (typeof input !== "string") return { ok: false, code: "EMPTY" };
  const collapsed = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return { ok: false, code: "EMPTY" };
  if (hasUnsafeTextCharacter(collapsed)) return { ok: false, code: "UNSAFE_CHARACTERS" };
  if ([...collapsed].length > FULL_NAME_MAX_CODE_POINTS) return { ok: false, code: "TOO_LONG" };
  if (!/\p{L}/u.test(collapsed)) return { ok: false, code: "NO_LETTER" };
  return { ok: true, value: collapsed };
}

// ===========================================================================
// phone - delegated ENTIRELY to libphonenumber-js (no custom national rules)
// ===========================================================================

/** E.164 caps a number at "+" plus 15 digits. */
export const PHONE_MAX_E164_LENGTH = 16;

export type PhoneRejectReason = "EMPTY" | "NOT_A_NUMBER" | "INVALID" | "TOO_LONG";
export type PhoneResult =
  | { ok: true; e164: string; phoneRegion: string | null }
  | { ok: false; reason: PhoneRejectReason };

/**
 * Parse and validate a phone number with libphonenumber-js and return it as
 * E.164. `phoneRegion` is the number's OWN dial/region context (ISO alpha-2, or
 * null for a global-service number such as +800) - a SEPARATE concept from the
 * account's residence country_code, stored in its own column.
 *
 * Validity is decided solely by libphonenumber-js's isValid(); this function
 * implements no national-number length or prefix rules of its own.
 */
export function normalizePhoneNumber(input: unknown, opts: { defaultCountry?: string | null } = {}): PhoneResult {
  if (typeof input !== "string" || input.trim().length === 0) return { ok: false, reason: "EMPTY" };
  const defaultAlpha2 = opts.defaultCountry ? normalizeCountryCode(opts.defaultCountry) : null;
  let parsed: ReturnType<typeof parsePhoneNumberFromString>;
  try {
    parsed = parsePhoneNumberFromString(
      input,
      defaultAlpha2 ? { defaultCountry: defaultAlpha2 as CountryCode } : undefined,
    );
  } catch {
    return { ok: false, reason: "NOT_A_NUMBER" };
  }
  if (!parsed) return { ok: false, reason: "NOT_A_NUMBER" };
  if (!parsed.isValid()) return { ok: false, reason: "INVALID" };
  const e164 = parsed.number;
  if (e164.length > PHONE_MAX_E164_LENGTH) return { ok: false, reason: "TOO_LONG" };
  return { ok: true, e164, phoneRegion: parsed.country ?? null };
}

// ===========================================================================
// keyed fingerprint CONTRACT - no fingerprint is written in A1
// ===========================================================================

/** The dedicated identity-fingerprint HMAC secret's env var. No default, no shipped secret. */
export const ACCOUNT_IDENTITY_HMAC_KEY_ENV = "ACCOUNT_IDENTITY_HMAC_KEY";

/**
 * Domain separator for the final value HMAC. Distinct from lib/owner-link.ts's
 * OWNER_LINK_* domains and from lib/device-passport-actor-ledger.ts's, so an
 * identity fingerprint can never collide with an owner ref or a device actor
 * key computed for the same input.
 */
export const ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN = "TP_ACCT_IDENTITY_V1:";

/**
 * Domain separator for the KEY-DERIVATION step (a distinct namespace from the
 * value HMAC above). The per-kind key is HMAC-SHA256(rootKey,
 * ACCOUNT_IDENTITY_KDF_DOMAIN + kind).
 */
export const ACCOUNT_IDENTITY_KDF_DOMAIN = "TP_ACCT_IDENTITY_KDF_V1:";

/** Bump only on a real keying-scheme change. */
export const ACCOUNT_IDENTITY_KEY_VERSION = 1;

/**
 * The kinds of value a fingerprint may ever represent - each name encodes that
 * the value MUST be VERIFIED first. A1 writes none of these; the table
 * account_identity_fingerprints stays empty until a separately-reviewed
 * verified-identity phase.
 */
export const ACCOUNT_IDENTITY_FINGERPRINT_KINDS = [
  "VERIFIED_EMAIL",
  "VERIFIED_PHONE_E164",
  "VERIFIED_INSTITUTION_ROR",
] as const;
export type AccountIdentityFingerprintKind = (typeof ACCOUNT_IDENTITY_FINGERPRINT_KINDS)[number];

const FINGERPRINT_KIND_SET: ReadonlySet<string> = new Set(ACCOUNT_IDENTITY_FINGERPRINT_KINDS);
export function isAccountIdentityFingerprintKind(value: unknown): value is AccountIdentityFingerprintKind {
  return typeof value === "string" && FINGERPRINT_KIND_SET.has(value);
}

/**
 * How much an owner-link producer may EVER read into a matching identity
 * fingerprint of each kind. This ceiling is fail-closed CONTEXT for a future
 * phase — A1 consumes none of it.
 *
 *   ACCOUNT_ONLY           useful for this account's own verification /
 *     integrity, but NOT eligible to establish OR support cross-account
 *     ownership by equality. Two live accounts cannot even produce an equal
 *     value of this kind, so "matching" is structurally impossible.
 *   SUPPORTING             corroborating / context evidence only. A future
 *     owner-link producer must treat it as (at most) owner-link's MEDIUM tier
 *     and it can NEVER, alone, establish or keep an ACTIVE owner link.
 *   ESTABLISHING_CANDIDATE a signal that a separate confidence review COULD
 *     later promote to HIGH (it still is not HIGH just for being owner-bound).
 *
 * VERIFIED_EMAIL is ACCOUNT_ONLY: the fingerprint is over the PRIMARY verified
 * login email (users.email), and ux_users_email makes that column UNIQUE, so
 * two live TurnitPlus accounts can never share it. Exact equality of the
 * primary verified email is therefore STRUCTURALLY UNAVAILABLE as a
 * cross-account owner-link signal — there is nothing for an owner-link producer
 * to match on. (A future VERIFIED_RECOVERY_EMAIL / OAUTH_PROVIDER_SUBJECT /
 * INSTITUTIONAL_SSO_SUBJECT would be a SEPARATE fingerprint kind with its own,
 * possibly different, semantics — it is NOT this one, and A1 adds no
 * recovery-email feature. Do NOT weaken or remove ux_users_email to make this
 * kind matchable.)
 *
 * VERIFIED_INSTITUTION_ROR is SUPPORTING and nothing else: an entire university
 * shares one verified ROR id, so institution equality — even canonical, even
 * verified — is NEVER ownership proof.
 *
 * VERIFIED_PHONE_E164 is an ESTABLISHING_CANDIDATE only: a verified shared phone
 * matches lib/owner-link.ts's owner-bound treatment, but it is still not
 * automatic ownership proof and a separate confidence review gates any HIGH.
 */
export const ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING: Record<
  AccountIdentityFingerprintKind,
  "ACCOUNT_ONLY" | "SUPPORTING" | "ESTABLISHING_CANDIDATE"
> = {
  VERIFIED_EMAIL: "ACCOUNT_ONLY",
  VERIFIED_PHONE_E164: "ESTABLISHING_CANDIDATE",
  VERIFIED_INSTITUTION_ROR: "SUPPORTING",
};

/** The dedicated identity ROOT HMAC secret, or null when unset / blank. Read fresh every call. */
export function getAccountIdentityHmacKey(): string | null {
  const raw = process.env[ACCOUNT_IDENTITY_HMAC_KEY_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive a per-kind effective HMAC key from the one root secret so that each
 * fingerprint kind is keyed by cryptographically independent material. The
 * same normalized value under two different kinds therefore produces UNRELATED
 * digests (not merely digests that differ because the kind is in the message).
 */
function deriveAccountIdentityKey(rootKey: string, kind: AccountIdentityFingerprintKind): Buffer {
  return createHmac("sha256", rootKey).update(ACCOUNT_IDENTITY_KDF_DOMAIN + kind, "utf8").digest();
}

/**
 * The keyed fingerprint of ONE already-canonical identity value (a lowercased
 * email, an E.164 phone, a ROR id body). This is the derivation CONTRACT for
 * account_identity_fingerprints - it is NOT called by any writer in A1.
 *
 * Construction: rootKey -> per-kind key (deriveAccountIdentityKey) ->
 * HMAC-SHA256(perKindKey, ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN + value), hex.
 *
 * FAIL CLOSED - returns null unless ALL of: the kind is known, `opts.verified`
 * is exactly true (an unverified value can NEVER be fingerprinted), the value
 * is a non-empty string, and the root HMAC key is available. A raw value is
 * never returned and can never be reversed from the digest.
 */
export function accountIdentityFingerprint(
  kind: AccountIdentityFingerprintKind,
  canonicalValue: string,
  opts: { verified: boolean },
): string | null {
  if (!isAccountIdentityFingerprintKind(kind)) return null;
  if (opts?.verified !== true) return null;
  if (typeof canonicalValue !== "string" || canonicalValue.length === 0) return null;
  const rootKey = getAccountIdentityHmacKey();
  if (!rootKey) return null;
  const perKindKey = deriveAccountIdentityKey(rootKey, kind);
  return createHmac("sha256", perKindKey)
    .update(ACCOUNT_IDENTITY_FINGERPRINT_DOMAIN + canonicalValue, "utf8")
    .digest("hex");
}

// ===========================================================================
// aggregate profile validation
// ===========================================================================

/** Bump when normalizeFullName / normalizePhoneNumber / normalize* semantics change. */
export const ACCOUNT_IDENTITY_NORMALIZATION_VERSION = 1;

export type InstitutionInput =
  | { status: "NONE" }
  | { status: "ROR"; rorId: string }
  | { status: "UNVERIFIED_TEXT"; name: string };

export type CityInput =
  | { status: "NONE" }
  | { status: "GEONAMES"; geonamesId: number | string }
  | { status: "UNVERIFIED_TEXT"; name: string };

export type AccountIdentityProfileInput = {
  accountType?: string | null;
  /** REQUIRED - the human-identity anchor. A missing / empty value is a validation error. */
  fullName?: string | null;
  /** residence country, ISO 3166-1 alpha-2 or alpha-3, any case */
  countryCode?: string | null;
  institution?: InstitutionInput | null;
  city?: CityInput | null;
  phone?: { number: string; defaultCountry?: string | null } | null;
};

export type NormalizedAccountIdentityProfile = {
  accountType: AccountType;
  /** Always a normalized non-empty string - full_name is NOT NULL in the schema. */
  fullName: string;
  countryCode: string | null;
  institutionStatus: InstitutionStatus;
  institutionRorId: string | null;
  institutionUnverifiedName: string | null;
  cityStatus: CityStatus;
  cityGeonamesId: number | null;
  cityUnverifiedName: string | null;
  phoneE164: string | null;
  phoneRegion: string | null;
  normalizationVersion: number;
  /**
   * Verification is ALWAYS unverified at this layer. These literal-false fields
   * exist so the repo cannot forget to write NULL to every *_verified_at column.
   */
  emailVerified: false;
  phoneVerified: false;
  institutionVerified: false;
};

export type AccountIdentityErrorField =
  | "accountType"
  | "fullName"
  | "countryCode"
  | "institution"
  | "city"
  | "phone";

/** Field + machine code only - NEVER the offending value (privacy). */
export type AccountIdentityValidationError = { field: AccountIdentityErrorField; code: string };

export type NormalizeAccountIdentityResult =
  | { ok: true; profile: NormalizedAccountIdentityProfile }
  | { ok: false; errors: AccountIdentityValidationError[] };

/**
 * Validate + normalize a whole identity-profile input into the exact shape the
 * repo persists. Pure. Every verification flag is forced unverified. On any
 * problem it returns the full list of field errors (value-free).
 */
export function normalizeAccountIdentityProfile(
  input: AccountIdentityProfileInput,
): NormalizeAccountIdentityResult {
  const errors: AccountIdentityValidationError[] = [];

  // account type - absent => independent; present but unknown => error
  let accountType: AccountType = DEFAULT_ACCOUNT_TYPE;
  if (input.accountType != null) {
    if (isAccountType(input.accountType)) accountType = input.accountType;
    else errors.push({ field: "accountType", code: "UNKNOWN_ACCOUNT_TYPE" });
  }

  // full name - REQUIRED (the human-identity anchor; full_name is NOT NULL)
  let fullName = "";
  if (input.fullName == null || String(input.fullName).trim().length === 0) {
    errors.push({ field: "fullName", code: "REQUIRED" });
  } else {
    const r = normalizeFullName(input.fullName);
    if (r.ok) fullName = r.value;
    else errors.push({ field: "fullName", code: r.code });
  }

  // residence country - optional
  let countryCode: string | null = null;
  if (input.countryCode != null && String(input.countryCode).trim().length > 0) {
    const c = normalizeCountryCode(input.countryCode);
    if (c) countryCode = c;
    else errors.push({ field: "countryCode", code: "UNKNOWN_COUNTRY" });
  }

  // institution - absent => explicit NONE
  let institutionStatus: InstitutionStatus = "NONE";
  let institutionRorId: string | null = null;
  let institutionUnverifiedName: string | null = null;
  const inst = input.institution ?? { status: "NONE" as const };
  if (!isInstitutionStatus(inst.status)) {
    errors.push({ field: "institution", code: "UNKNOWN_INSTITUTION_STATUS" });
  } else if (inst.status === "ROR") {
    const body = normalizeRorId(inst.rorId);
    if (body) {
      institutionStatus = "ROR";
      institutionRorId = body;
    } else {
      errors.push({ field: "institution", code: "INVALID_ROR_ID" });
    }
  } else if (inst.status === "UNVERIFIED_TEXT") {
    const name = normalizeUnverifiedText(inst.name);
    if (name) {
      institutionStatus = "UNVERIFIED_TEXT";
      institutionUnverifiedName = name;
    } else {
      errors.push({ field: "institution", code: "INVALID_INSTITUTION_TEXT" });
    }
  } // else NONE - nothing to do

  // city - absent => explicit NONE
  let cityStatus: CityStatus = "NONE";
  let cityGeonamesId: number | null = null;
  let cityUnverifiedName: string | null = null;
  const city = input.city ?? { status: "NONE" as const };
  if (!isCityStatus(city.status)) {
    errors.push({ field: "city", code: "UNKNOWN_CITY_STATUS" });
  } else if (city.status === "GEONAMES") {
    const id = normalizeGeonamesId(city.geonamesId);
    if (id != null) {
      cityStatus = "GEONAMES";
      cityGeonamesId = id;
    } else {
      errors.push({ field: "city", code: "INVALID_GEONAMES_ID" });
    }
  } else if (city.status === "UNVERIFIED_TEXT") {
    const name = normalizeUnverifiedText(city.name);
    if (name) {
      cityStatus = "UNVERIFIED_TEXT";
      cityUnverifiedName = name;
    } else {
      errors.push({ field: "city", code: "INVALID_CITY_TEXT" });
    }
  } // else NONE

  // phone - optional; delegated to libphonenumber-js
  let phoneE164: string | null = null;
  let phoneRegion: string | null = null;
  if (input.phone != null && String(input.phone.number ?? "").trim().length > 0) {
    const p = normalizePhoneNumber(input.phone.number, { defaultCountry: input.phone.defaultCountry ?? null });
    if (p.ok) {
      phoneE164 = p.e164;
      phoneRegion = p.phoneRegion;
    } else {
      errors.push({ field: "phone", code: `PHONE_${p.reason}` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    profile: {
      accountType,
      fullName,
      countryCode,
      institutionStatus,
      institutionRorId,
      institutionUnverifiedName,
      cityStatus,
      cityGeonamesId,
      cityUnverifiedName,
      phoneE164,
      phoneRegion,
      normalizationVersion: ACCOUNT_IDENTITY_NORMALIZATION_VERSION,
      emailVerified: false,
      phoneVerified: false,
      institutionVerified: false,
    },
  };
}

// ===========================================================================
// owner-evidence eligibility - always false in A1
// ===========================================================================

export type ClaimTrustTier = "NONE" | "CANONICAL_UNVERIFIED" | "UNVERIFIED_TEXT";

/** The trust tier of an institution/city claim status. Nothing consumes this yet. */
export function claimTrustTier(status: InstitutionStatus | CityStatus): ClaimTrustTier {
  if (status === "NONE") return "NONE";
  if (status === "ROR" || status === "GEONAMES") return "CANONICAL_UNVERIFIED";
  return "UNVERIFIED_TEXT";
}

/**
 * Whether any part of a normalized identity profile may currently feed
 * owner-link inference. In A1 this is UNCONDITIONALLY false: no value is
 * verified, and a canonical-but-unverified or free-text claim is never enough.
 * A later phase may only flip this after a separate confidence review.
 *
 * EVEN THEN, see ACCOUNT_IDENTITY_FINGERPRINT_EVIDENCE_CEILING for what each
 * verified value could ever mean cross-account:
 *   - the PRIMARY verified email cannot link two live accounts at all —
 *     ux_users_email makes users.email unique, so equality is structurally
 *     impossible (ACCOUNT_ONLY);
 *   - a shared verified institution is NEVER, on its own, ownership proof — an
 *     entire campus shares one verified ROR id (SUPPORTING only);
 *   - a shared verified phone is at most an ESTABLISHING_CANDIDATE gated by a
 *     separate confidence review, never automatic ownership proof.
 */
export function identityClaimIsOwnerEvidenceEligible(_profile: NormalizedAccountIdentityProfile): false {
  return false;
}
