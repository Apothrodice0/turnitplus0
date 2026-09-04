"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ISO_3166_1_COUNTRIES } from "@/lib/iso-3166-1-countries";

/**
 * A2 — the structured-identity fields shared by the signup form and the account-
 * settings form. It COLLECTS canonical values (ISO alpha-2 country, GeoNames
 * city id, ROR institution id, E.164-bound phone, account type, full name) and
 * hands them to the parent via a ref. All authority is server-side: this is a
 * convenience layer, and the server re-resolves the city + institution ids and
 * re-validates everything on submit.
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
  /** True when the user has not entered anything (used to let a grandfathered account save username/email alone). */
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

export type IdentityFieldsProps = {
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
  { initial, disabled },
  ref,
) {
  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [accountType, setAccountType] = useState<AccountTypeValue | "">(initial?.accountType ?? "");
  const [countryCode, setCountryCode] = useState(initial?.countryCode ?? "");
  const [phone, setPhone] = useState(initial?.phoneE164 ?? "");

  const [cityQuery, setCityQuery] = useState(initial?.city?.name ?? "");
  const [citySelected, setCitySelected] = useState<CityHit | null>(
    initial?.city && initial.city.name
      ? { geonamesId: initial.city.geonamesId, name: initial.city.name, countryCode: initial?.countryCode ?? "", countryName: "", admin1: "" }
      : null,
  );
  const [cityHits, setCityHits] = useState<CityHit[]>([]);

  const [instMode, setInstMode] = useState<"search" | "none">(
    initial?.institution?.status === "NONE" ? "none" : "search",
  );
  const [instQuery, setInstQuery] = useState("");
  const [instSelected, setInstSelected] = useState<InstitutionHit | null>(
    initial?.institution?.status === "ROR"
      ? { rorId: initial.institution.rorId, name: initial.institution.rorId, countryCode: null, countryName: null }
      : null,
  );
  const [instHits, setInstHits] = useState<InstitutionHit[]>([]);

  const [errors, setErrors] = useState<Record<string, string>>({});

  const countries = useMemo(
    () => [...ISO_3166_1_COUNTRIES].map((c) => ({ code: c.alpha2, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );

  // Debounced city search, scoped to the chosen residence country.
  useEffect(() => {
    if (!cityQuery || cityQuery.length < 2 || (citySelected && citySelected.name === cityQuery)) {
      setCityHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const url = `/api/identity/cities?q=${encodeURIComponent(cityQuery)}${countryCode ? `&country=${countryCode}` : ""}`;
        const res = await fetch(url, { signal: ctrl.signal });
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

  // Debounced institution search.
  useEffect(() => {
    if (instMode !== "search" || !instQuery || instQuery.length < 2) {
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
  }, [instQuery, instMode]);

  const collect = useCallback((): CollectedIdentity | null => {
    const next: Record<string, string> = {};
    if (!fullName.trim()) next.fullName = "Your full name is required.";
    if (!accountType) next.accountType = "Choose an account type.";
    if (!countryCode) next.countryCode = "Choose your country of residence.";
    if (!citySelected) next.city = "Search for and select your city.";
    else if (countryCode && citySelected.countryCode && citySelected.countryCode !== countryCode) {
      next.city = "That city is not in the country you selected.";
    }
    if (!phone.trim()) next.phone = "A phone number is required.";
    const affiliated = accountType && AFFILIATED.has(accountType);
    let institution: CollectedIdentity["institution"];
    if (instMode === "none") {
      if (affiliated) next.institution = "Students, instructors and researchers must select an institution.";
      institution = { status: "NONE" };
    } else if (instSelected) {
      institution = { status: "ROR", rorId: instSelected.rorId };
    } else {
      next.institution = "Search for and select your institution (or choose 'no institution').";
      institution = { status: "NONE" };
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      fullName: fullName.trim(),
      accountType: accountType as AccountTypeValue,
      countryCode,
      cityGeonamesId: citySelected!.geonamesId,
      phone: { number: phone.trim(), defaultCountry: countryCode || null },
      institution,
    };
  }, [fullName, accountType, countryCode, citySelected, phone, instMode, instSelected]);

  const isPristine = useCallback(
    () =>
      !fullName.trim() &&
      !accountType &&
      !countryCode &&
      !phone.trim() &&
      !citySelected &&
      !instSelected &&
      instMode === "search",
    [fullName, accountType, countryCode, phone, citySelected, instSelected, instMode],
  );

  useImperativeHandle(ref, () => ({ collect, isPristine }), [collect, isPristine]);

  const cityInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="identity-fields">
      <label className="auth-field">
        <span>Full name</span>
        <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" maxLength={200} disabled={disabled} required />
        {errors.fullName && <em className="auth-field-error">{errors.fullName}</em>}
      </label>

      <label className="auth-field">
        <span>Account type</span>
        <select value={accountType} onChange={(e) => setAccountType(e.target.value as AccountTypeValue)} disabled={disabled} required>
          <option value="" disabled>Select…</option>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {errors.accountType && <em className="auth-field-error">{errors.accountType}</em>}
      </label>

      <label className="auth-field">
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
          <option value="" disabled>Select…</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
        {errors.countryCode && <em className="auth-field-error">{errors.countryCode}</em>}
      </label>

      <label className="auth-field">
        <span>City</span>
        <input
          ref={cityInputRef}
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
                  {c.name}
                  {c.admin1 ? `, ${c.admin1}` : ""} — {c.countryName}
                </button>
              </li>
            ))}
          </ul>
        )}
        {citySelected && <em className="identity-field-ok">Selected: {citySelected.name}</em>}
        {errors.city && <em className="auth-field-error">{errors.city}</em>}
      </label>

      <fieldset className="auth-field">
        <legend>Institution / university</legend>
        <label className="identity-radio">
          <input type="radio" name="instMode" checked={instMode === "search"} onChange={() => setInstMode("search")} disabled={disabled} />
          <span>Select my institution</span>
        </label>
        <label className="identity-radio">
          <input type="radio" name="instMode" checked={instMode === "none"} onChange={() => setInstMode("none")} disabled={disabled} />
          <span>No institution — I am independent</span>
        </label>
        {instMode === "search" && (
          <>
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
                      {i.name}
                      {i.countryName ? ` — ${i.countryName}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {instSelected && <em className="identity-field-ok">Selected: {instSelected.name}</em>}
          </>
        )}
        {errors.institution && <em className="auth-field-error">{errors.institution}</em>}
      </fieldset>

      <label className="auth-field">
        <span>Phone number</span>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 415 555 2671"
          autoComplete="tel"
          disabled={disabled}
          required
        />
        {errors.phone && <em className="auth-field-error">{errors.phone}</em>}
        <em className="identity-field-hint">Not verified yet — stored so we can support future account recovery.</em>
      </label>
    </div>
  );
});
