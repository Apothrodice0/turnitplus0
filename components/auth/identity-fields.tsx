"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { ISO_3166_1_COUNTRIES } from "@/lib/iso-3166-1-countries";

/**
 * A2 — the structured-identity fields shared by the signup form and the account-
 * settings form. It COLLECTS canonical values (ISO alpha-2 country, GeoNames
 * city id, ROR institution id, an Algeria-first phone, account type, full name)
 * and hands them to the parent via a ref. All authority is server-side: this is
 * a convenience layer, and the server re-resolves the city + institution ids and
 * re-validates everything on submit.
 *
 * Institution is account-type-driven, not a separate choice: student / instructor
 * / researcher MUST resolve to a canonical ROR institution (the section is shown
 * and required, with no "independent" escape hatch); an independent account has
 * no institution UI at all and submits status NONE automatically.
 *
 * Markup: a Fragment of plain <label><span>…</span>…</label> blocks so every
 * field is a direct child of the surrounding <form className="auth-form"> and
 * inherits the exact same label typography, field height and spacing as the
 * Username / Email / Password fields above it (see app/globals.css .auth-form).
 *
 * Rollout is Algeria-first: country defaults to Algeria, and the phone field is
 * a fixed "+213" prefix followed by exactly 9 local digits.
 */

export type AccountTypeValue = "student" | "instructor" | "researcher" | "independent";

export type CollectedIdentity = {
  fullName: string;
  accountType: AccountTypeValue;
  countryCode: string;
  cityGeonamesId: number;
  phone: { number: string; defaultCountry: string | null };
  institution: { status: "NONE" } | { status: "ROR"; rorId: string };
};

export type IdentityFieldsHandle = {
  /** Returns the collected identity, or null (and shows inline errors) if incomplete. */
  collect: () => CollectedIdentity | null;
  /** True when the user has not entered anything (lets a grandfathered account save username/email alone). */
  isPristine: () => boolean;
};

type CityHit = { geonamesId: number; name: string; countryCode: string; countryName: string; admin1: string };
type InstitutionHit = { rorId: string; name: string; countryCode: string | null; countryName: string | null };

const ACCOUNT_TYPES: { value: AccountTypeValue; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "instructor", label: "Instructor" },
  { value: "researcher", label: "Researcher" },
  { value: "independent", label: "Independent / not affiliated" },
];
const AFFILIATED = new Set<AccountTypeValue>(["student", "instructor", "researcher"]);

// Algeria-first defaults.
const DEFAULT_COUNTRY = "DZ";
const PHONE_PREFIX = "+213";
const PHONE_LOCAL_DIGITS = 9;

/** Split a stored E.164 into the 9 local digits when it is an Algeria (+213) number; otherwise "". */
function localDigitsFromE164(e164: string | null | undefined): string {
  if (typeof e164 !== "string") return "";
  if (!e164.startsWith(PHONE_PREFIX)) return "";
  const rest = e164.slice(PHONE_PREFIX.length).replace(/\D/g, "");
  return rest.length === PHONE_LOCAL_DIGITS ? rest : "";
}

export type IdentityFieldsProps = {
  mode?: "signup" | "settings";
  /** Pre-fill (account settings). */
  initial?: Partial<{
    fullName: string;
    accountType: AccountTypeValue;
    countryCode: string;
    city: { geonamesId: number; name: string | null } | null;
    institution: { status: "NONE" } | { status: "ROR"; rorId: string } | null;
    phoneE164: string | null;
  }>;
  disabled?: boolean;
};

export const IdentityFields = forwardRef<IdentityFieldsHandle, IdentityFieldsProps>(function IdentityFields(
  { mode = "signup", initial, disabled },
  ref,
) {
  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [accountType, setAccountType] = useState<AccountTypeValue | "">(initial?.accountType ?? "");
  const [countryCode, setCountryCode] = useState(
    initial?.countryCode ?? (mode === "signup" ? DEFAULT_COUNTRY : ""),
  );
  const [phoneDigits, setPhoneDigits] = useState(localDigitsFromE164(initial?.phoneE164));

  const [cityQuery, setCityQuery] = useState(initial?.city?.name ?? "");
  const [citySelected, setCitySelected] = useState<CityHit | null>(
    initial?.city && initial.city.name
      ? { geonamesId: initial.city.geonamesId, name: initial.city.name, countryCode: initial?.countryCode ?? "", countryName: "", admin1: "" }
      : null,
  );
  const [cityHits, setCityHits] = useState<CityHit[]>([]);

  const [instQuery, setInstQuery] = useState("");
  const [instSelected, setInstSelected] = useState<InstitutionHit | null>(
    initial?.institution?.status === "ROR"
      ? { rorId: initial.institution.rorId, name: initial.institution.rorId, countryCode: null, countryName: null }
      : null,
  );
  const [instHits, setInstHits] = useState<InstitutionHit[]>([]);

  const [errors, setErrors] = useState<Record<string, string>>({});

  // The institution section is a pure function of account type: it is shown, and
  // a canonical ROR institution is required, only for the affiliated types.
  // Independent (and not-yet-chosen) accounts have no institution UI and submit
  // status NONE automatically.
  const institutionRequired = accountType !== "" && AFFILIATED.has(accountType);

  const countries = useMemo(
    () => [...ISO_3166_1_COUNTRIES].map((c) => ({ code: c.alpha2, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  // Debounced city search, scoped to the chosen residence country.
  useEffect(() => {
    if (!countryCode || !cityQuery || cityQuery.length < 2 || (citySelected && citySelected.name === cityQuery)) {
      setCityHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/identity/cities?q=${encodeURIComponent(cityQuery)}&country=${countryCode}`, { signal: ctrl.signal });
        const data = (await res.json()) as { results?: CityHit[] };
        setCityHits(Array.isArray(data.results) ? data.results : []);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [cityQuery, countryCode, citySelected]);

  // Debounced institution search (only while an affiliated account type is selected).
  useEffect(() => {
    if (!institutionRequired || !instQuery || instQuery.length < 2) {
      setInstHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/identity/institutions?q=${encodeURIComponent(instQuery)}`, { signal: ctrl.signal });
        const data = (await res.json()) as { results?: InstitutionHit[] };
        setInstHits(Array.isArray(data.results) ? data.results : []);
      } catch {
        /* ignore */
      }
    }, 300);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [instQuery, institutionRequired]);

  const collect = useCallback((): CollectedIdentity | null => {
    const next: Record<string, string> = {};
    if (!fullName.trim()) next.fullName = "Your full name is required.";
    if (!accountType) next.accountType = "Choose an account type.";
    if (!countryCode) next.countryCode = "Choose your country of residence.";
    if (!citySelected) next.city = "Search for and select your city.";
    else if (countryCode && citySelected.countryCode && citySelected.countryCode !== countryCode) {
      next.city = "That city is not in the country you selected.";
    }
    if (phoneDigits.length !== PHONE_LOCAL_DIGITS) {
      next.phone = `Enter the ${PHONE_LOCAL_DIGITS} digits after ${PHONE_PREFIX}.`;
    }

    // Institution is entirely account-type-driven — there is no user-facing
    // "no institution" choice. Affiliated types must resolve to a canonical ROR
    // id; every other account submits NONE with no institution input at all.
    let institution: CollectedIdentity["institution"];
    if (!institutionRequired) {
      institution = { status: "NONE" };
    } else if (instSelected) {
      institution = { status: "ROR", rorId: instSelected.rorId };
    } else {
      next.institution = "Search for and select your institution.";
      institution = { status: "NONE" };
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      fullName: fullName.trim(),
      accountType: accountType as AccountTypeValue,
      countryCode,
      cityGeonamesId: citySelected!.geonamesId,
      phone: { number: `${PHONE_PREFIX}${phoneDigits}`, defaultCountry: countryCode || DEFAULT_COUNTRY },
      institution,
    };
  }, [fullName, accountType, countryCode, citySelected, phoneDigits, institutionRequired, instSelected]);

  const isPristine = useCallback(
    () =>
      !fullName.trim() &&
      !accountType &&
      (mode === "settings" ? !countryCode : countryCode === DEFAULT_COUNTRY) &&
      !phoneDigits &&
      !citySelected &&
      !instSelected,
    [fullName, accountType, countryCode, phoneDigits, citySelected, instSelected, mode],
  );

  useImperativeHandle(ref, () => ({ collect, isPristine }), [collect, isPristine]);

  return (
    <>
      <p className="identity-section-lead">A few details about you. Your name, city and institution are checked against
      official registries; nothing here is verified yet.</p>

      <label>
        <span>Full name</span>
        <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" maxLength={200} placeholder="Your full name" disabled={disabled} required />
        {errors.fullName && <em className="identity-field-error">{errors.fullName}</em>}
      </label>

      <label>
        <span>Account type</span>
        <select
          value={accountType}
          onChange={(e) => {
            const nextType = e.target.value as AccountTypeValue;
            setAccountType(nextType);
            // Institution follows account type. Moving to a non-affiliated type
            // clears any chosen/typed institution (the account now submits NONE);
            // moving back to an affiliated type therefore forces a fresh ROR
            // selection instead of silently reusing a stale one.
            if (!AFFILIATED.has(nextType)) {
              setInstSelected(null);
              setInstQuery("");
              setInstHits([]);
            }
            if (errors.institution) {
              setErrors((prev) => {
                const rest = { ...prev };
                delete rest.institution;
                return rest;
              });
            }
          }}
          disabled={disabled}
          required
        >
          <option value="" disabled>Select an account type…</option>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {errors.accountType && <em className="identity-field-error">{errors.accountType}</em>}
      </label>

      <label>
        <span>Country of residence</span>
        <select
          value={countryCode}
          onChange={(e) => {
            setCountryCode(e.target.value);
            if (citySelected && citySelected.countryCode !== e.target.value) {
              setCitySelected(null);
              setCityQuery("");
            }
          }}
          disabled={disabled}
          required
        >
          <option value="" disabled>Select a country…</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
        {errors.countryCode && <em className="identity-field-error">{errors.countryCode}</em>}
      </label>

      <label>
        <span>City</span>
        <input
          type="text"
          value={cityQuery}
          onChange={(e) => {
            setCityQuery(e.target.value);
            setCitySelected(null);
          }}
          placeholder={countryCode ? "Start typing your city…" : "Choose a country first"}
          disabled={disabled || !countryCode}
          autoComplete="off"
        />
        {cityHits.length > 0 && !citySelected && (
          <ul className="identity-typeahead" role="listbox">
            {cityHits.map((c) => (
              <li key={c.geonamesId}>
                <button
                  type="button"
                  onClick={() => {
                    setCitySelected(c);
                    setCityQuery(c.name);
                    setCityHits([]);
                  }}
                >
                  <strong>{c.name}</strong>
                  <span>{c.admin1 ? `${c.admin1} · ` : ""}{c.countryName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {citySelected && <em className="identity-field-ok">Selected: {citySelected.name}</em>}
        {errors.city && <em className="identity-field-error">{errors.city}</em>}
      </label>

      {institutionRequired && (
        <fieldset className="identity-institution">
          <legend>Institution / university</legend>
          <p className="identity-hint">Students, instructors and researchers must be affiliated with a
          registered institution. Search the global registry and select yours.</p>
          <div className="identity-institution-search">
            <input
              type="text"
              value={instSelected ? instSelected.name : instQuery}
              onChange={(e) => {
                setInstQuery(e.target.value);
                setInstSelected(null);
              }}
              placeholder="Start typing your institution…"
              disabled={disabled}
              autoComplete="off"
              aria-label="Institution or university"
            />
            {instHits.length > 0 && !instSelected && (
              <ul className="identity-typeahead" role="listbox">
                {instHits.map((i) => (
                  <li key={i.rorId}>
                    <button
                      type="button"
                      onClick={() => {
                        setInstSelected(i);
                        setInstQuery(i.name);
                        setInstHits([]);
                      }}
                    >
                      <strong>{i.name}</strong>
                      {i.countryName && <span>{i.countryName}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {instSelected && <em className="identity-field-ok">Selected: {instSelected.name}</em>}
          </div>
          {errors.institution && <em className="identity-field-error">{errors.institution}</em>}
        </fieldset>
      )}

      <label>
        <span>Phone number</span>
        <div className="identity-phone-group">
          <span className="identity-phone-prefix" aria-hidden="true">{PHONE_PREFIX}</span>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            value={phoneDigits}
            onChange={(e) => setPhoneDigits(e.target.value.replace(/\D/g, "").slice(0, PHONE_LOCAL_DIGITS))}
            placeholder="555123456"
            maxLength={PHONE_LOCAL_DIGITS}
            aria-label={`Phone number, ${PHONE_LOCAL_DIGITS} digits after ${PHONE_PREFIX}`}
            disabled={disabled}
            required
          />
        </div>
        {errors.phone && <em className="identity-field-error">{errors.phone}</em>}
        <em className="identity-hint">Not verified yet — stored so we can support future account recovery.</em>
      </label>
    </>
  );
});
