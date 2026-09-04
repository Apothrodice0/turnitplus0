import {
  isAccountType,
  normalizeFullName,
  normalizeCountryCode,
  normalizePhoneNumber,
  normalizeRorId,
  normalizeAccountIdentityProfile,
  type AccountType,
  type NormalizedAccountIdentityProfile,
} from "./account-identity";
import { resolveGeonamesCity, type GeonamesCity } from "./geonames-cities";
import { resolveRorInstitution, type RorInstitution } from "./ror-client";
import { isoCountryByAlpha2 } from "./iso-3166-1-countries";

/**
 * A2 — the SERVER-AUTHORITATIVE identity resolver shared by POST /api/auth/signup
 * and PATCH /api/auth/me. It takes the raw client payload and:
 *
 *   - normalizes the full name with A1's Unicode-safe rules (REQUIRED),
 *   - validates the residence country against the bundled ISO list (REQUIRED,
 *     canonical alpha-2 — the client sends the code, the server checks membership),
 *   - RE-RESOLVES the client-supplied GeoNames city id against the bundled
 *     dataset and rejects a city whose own country != the residence country
 *     (the client-supplied city NAME is never read or stored),
 *   - validates the phone with A1 / libphonenumber-js, stores E.164, keeps the
 *     phone's dial region separate from residence, marks it UNVERIFIED,
 *   - RE-RESOLVES the client-supplied ROR id against the live ROR registry;
 *     student / instructor / researcher MUST have a resolvable institution,
 *     independent MAY use an explicit NONE, and free-text institutions are
 *     rejected outright (no arbitrary trusted university text),
 *   - forces every verification flag UNVERIFIED and never derives a fingerprint;
 *     any verification state in the client payload is ignored.
 *
 * On success it returns the exact NormalizedAccountIdentityProfile the profile
 * row is built from, plus resolved display details for the response only.
 * On failure it returns the full list of field errors — field + machine code
 * only, NEVER the offending value (privacy).
 */

export type SignupIdentityInput = {
  fullName?: unknown;
  accountType?: unknown;
  /** residence country — ISO 3166-1 alpha-2 (the client sends the canonical code) */
  countryCode?: unknown;
  /** canonical GeoNames numeric feature id (the client sends the id, never the name) */
  cityGeonamesId?: unknown;
  phone?: unknown;
  /** { status: 'NONE' } | { status: 'ROR', rorId } — 'UNVERIFIED_TEXT' is rejected at signup */
  institution?: unknown;
};

export type IdentityErrorField = "fullName" | "accountType" | "countryCode" | "city" | "phone" | "institution";
export type IdentityFieldError = { field: IdentityErrorField; code: string };

export type ResolvedInstitution =
  | { status: "NONE" }
  | { status: "ROR"; rorId: string; name: string; countryCode: string | null; countryName: string | null };

export type ResolvedSignupIdentity = {
  /** exactly what the account_identity_profiles row is built from (A1 shape; verification all false) */
  normalized: NormalizedAccountIdentityProfile;
  /** resolved display details for the API RESPONSE only — the DB stores just the canonical ids */
  display: {
    accountType: AccountType;
    countryCode: string;
    countryName: string;
    city: { geonamesId: number; name: string; countryCode: string; countryName: string; admin1: string };
    institution: ResolvedInstitution;
    phoneRegion: string | null;
  };
};

export type ResolveSignupIdentityResult =
  | { ok: true; identity: ResolvedSignupIdentity }
  | { ok: false; errors: IdentityFieldError[] };

const AFFILIATED_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set(["student", "instructor", "researcher"]);

function parseInstitutionInput(raw: unknown): { status?: unknown; rorId?: unknown } {
  if (raw == null) return { status: "NONE" };
  if (typeof raw !== "object") return { status: raw };
  return raw as { status?: unknown; rorId?: unknown };
}

function parsePhoneInput(raw: unknown): { number: unknown; defaultCountry: unknown } {
  if (raw == null || typeof raw !== "object") return { number: raw, defaultCountry: null };
  const r = raw as { number?: unknown; defaultCountry?: unknown };
  return { number: r.number, defaultCountry: r.defaultCountry ?? null };
}

export async function resolveSignupIdentity(
  input: SignupIdentityInput,
  opts: { resolveInstitution?: typeof resolveRorInstitution } = {},
): Promise<ResolveSignupIdentityResult> {
  const errors: IdentityFieldError[] = [];
  const resolveInstitution = opts.resolveInstitution ?? resolveRorInstitution;

  // --- account type (REQUIRED) -------------------------------------------------
  let accountType: AccountType | null = null;
  if (input.accountType == null || String(input.accountType).trim().length === 0) {
    errors.push({ field: "accountType", code: "REQUIRED" });
  } else if (isAccountType(input.accountType)) {
    accountType = input.accountType;
  } else {
    errors.push({ field: "accountType", code: "UNKNOWN_ACCOUNT_TYPE" });
  }

  // --- full name (REQUIRED) --------------------------------------------------
  let fullName: string | null = null;
  if (input.fullName == null || String(input.fullName).trim().length === 0) {
    errors.push({ field: "fullName", code: "REQUIRED" });
  } else {
    const r = normalizeFullName(input.fullName);
    if (r.ok) fullName = r.value;
    else errors.push({ field: "fullName", code: r.code });
  }

  // --- residence country (REQUIRED, canonical ISO alpha-2) -----------------
  let countryCode: string | null = null;
  if (input.countryCode == null || String(input.countryCode).trim().length === 0) {
    errors.push({ field: "countryCode", code: "REQUIRED" });
  } else {
    const c = normalizeCountryCode(input.countryCode);
    if (c) countryCode = c;
    else errors.push({ field: "countryCode", code: "UNKNOWN_COUNTRY" });
  }

  // --- city (REQUIRED, canonical GeoNames id, re-resolved, country must match) ---
  let resolvedCity: GeonamesCity | null = null;
  if (input.cityGeonamesId == null || String(input.cityGeonamesId).trim().length === 0) {
    errors.push({ field: "city", code: "REQUIRED" });
  } else {
    resolvedCity = resolveGeonamesCity(input.cityGeonamesId);
    if (!resolvedCity) {
      errors.push({ field: "city", code: "UNKNOWN_CITY" });
    } else if (countryCode && resolvedCity.countryCode !== countryCode) {
      errors.push({ field: "city", code: "CITY_COUNTRY_MISMATCH" });
    }
  }

  // --- phone (REQUIRED, libphonenumber-js, stored E.164, UNVERIFIED) --------
  let phoneE164: string | null = null;
  let phoneRegion: string | null = null;
  const phone = parsePhoneInput(input.phone);
  if (phone.number == null || String(phone.number).trim().length === 0) {
    errors.push({ field: "phone", code: "REQUIRED" });
  } else {
    const p = normalizePhoneNumber(phone.number, { defaultCountry: typeof phone.defaultCountry === "string" ? phone.defaultCountry : null });
    if (p.ok) {
      phoneE164 = p.e164;
      phoneRegion = p.phoneRegion;
    } else {
      errors.push({ field: "phone", code: `PHONE_${p.reason}` });
    }
  }

  // --- institution (ROR re-resolve; affiliated types require one) ----------
  const instInput = parseInstitutionInput(input.institution);
  let institution: ResolvedInstitution = { status: "NONE" };
  let institutionRorId: string | null = null;
  if (instInput.status === "UNVERIFIED_TEXT") {
    errors.push({ field: "institution", code: "TEXT_NOT_ALLOWED" });
  } else if (instInput.status === "ROR") {
    const body = normalizeRorId(instInput.rorId);
    if (!body) {
      errors.push({ field: "institution", code: "INVALID_ROR_ID" });
    } else {
      const resolved: RorInstitution | null = await resolveInstitution(body);
      if (!resolved) {
        errors.push({ field: "institution", code: "UNKNOWN_ROR" });
      } else {
        institutionRorId = resolved.rorId;
        institution = {
          status: "ROR",
          rorId: resolved.rorId,
          name: resolved.name,
          countryCode: resolved.countryCode,
          countryName: resolved.countryName,
        };
      }
    }
  } else if (instInput.status === "NONE" || instInput.status == null) {
    if (accountType && AFFILIATED_ACCOUNT_TYPES.has(accountType)) {
      errors.push({ field: "institution", code: "INSTITUTION_REQUIRED" });
    }
  } else {
    errors.push({ field: "institution", code: "UNKNOWN_INSTITUTION_STATUS" });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Everything above resolved — build the canonical A1 profile shape from the
  // RE-RESOLVED values (never the client's names). normalizeAccountIdentityProfile
  // re-validates and, critically, forces every verification flag to false.
  const normalizedResult = normalizeAccountIdentityProfile({
    accountType: accountType!,
    fullName: fullName!,
    countryCode: countryCode!,
    city: { status: "GEONAMES", geonamesId: resolvedCity!.geonamesId },
    institution: institutionRorId ? { status: "ROR", rorId: institutionRorId } : { status: "NONE" },
    phone: phoneE164 ? { number: phoneE164 } : null,
  });
  if (!normalizedResult.ok) {
    // Should be unreachable (inputs are already canonical) — surface defensively.
    return {
      ok: false,
      errors: normalizedResult.errors.map((e) => ({
        field: (e.field === "accountType" || e.field === "fullName" || e.field === "countryCode" || e.field === "city" || e.field === "phone" || e.field === "institution"
          ? e.field
          : "institution") as IdentityErrorField,
        code: e.code,
      })),
    };
  }

  const countryName = isoCountryByAlpha2(countryCode!)?.name ?? countryCode!;
  return {
    ok: true,
    identity: {
      normalized: normalizedResult.profile,
      display: {
        accountType: accountType!,
        countryCode: countryCode!,
        countryName,
        city: {
          geonamesId: resolvedCity!.geonamesId,
          name: resolvedCity!.name,
          countryCode: resolvedCity!.countryCode,
          countryName: isoCountryByAlpha2(resolvedCity!.countryCode)?.name ?? resolvedCity!.countryCode,
          admin1: resolvedCity!.admin1,
        },
        institution,
        phoneRegion,
      },
    },
  };
}
