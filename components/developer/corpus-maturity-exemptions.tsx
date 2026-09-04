"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Corpus workspace — "Maturity exemptions" (originally built for the
 * developer dashboard, now presented inside /admin/corpus's own card — see
 * app/admin/corpus/page.tsx). Lets an admin enter an account email and
 * exempt that account's corpus sources from the 7-day maturity gate
 * (lib/user-submission-corpus.ts's admissionEligibilitySql). Affects ONLY
 * maturity — same-Passport SELF, exact/strong matching, duplicate
 * suppression, archive/web/scholarly evidence, corpus admission, scoring,
 * and owner-link logic are all unaffected.
 *
 * The email is a lookup key only — POST /api/developer/corpus-maturity-
 * exemptions resolves it to users.id server-side and persists only that id;
 * Remove sends the id already shown in the list, never re-resolves an email.
 */

export type CorpusMaturityExemptionRow = {
  userId: string;
  email: string;
  createdAt: string;
  createdByUserId: string | null;
};

type AddResponse = { error?: string; found?: boolean; userId?: string; email?: string };

export function DeveloperCorpusMaturityExemptions({ initialExemptions }: { initialExemptions: CorpusMaturityExemptionRow[] }) {
  const router = useRouter();
  const [exemptions, setExemptions] = useState<CorpusMaturityExemptionRow[]>(initialExemptions);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refreshList() {
    const response = await fetch("/api/developer/corpus-maturity-exemptions", { method: "GET" });
    if (!response.ok) return;
    const data = (await response.json().catch(() => null)) as { exemptions?: CorpusMaturityExemptionRow[] } | null;
    if (data?.exemptions) setExemptions(data.exemptions);
  }

  async function addExemption() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/developer/corpus-maturity-exemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = (await response.json().catch(() => null)) as AddResponse | null;
      if (!response.ok) {
        throw new Error(data?.error || `Add failed (${response.status})`);
      }
      if (!data?.found) {
        setNotice(`No account found for ${trimmed}.`);
        return;
      }
      setEmail("");
      setNotice(`Exempted ${data.email}.`);
      await refreshList();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setAdding(false);
    }
  }

  async function removeExemption(userId: string) {
    setRemovingId(userId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/developer/corpus-maturity-exemptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `Remove failed (${response.status})`);
      }
      setExemptions((prev) => prev.filter((row) => row.userId !== userId));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="admin-corpus-maturity-exemptions">
      <p className="admin-card-description">
        Exempt an account&apos;s corpus sources from the 7-day maturity gate — they contribute plagiarism evidence
        immediately instead of waiting 7 days. Affects maturity only; same-account/Passport self-exclusion,
        matching, and duplicate suppression are unchanged.
      </p>

      <div className="admin-corpus-toolbar">
        <label>
          Account email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            aria-label="Account email"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="button" className="admin-btn-primary" onClick={addExemption} disabled={adding || email.trim().length === 0}>
          {adding ? "Adding…" : "Add exemption"}
        </button>
      </div>

      {notice && (
        <p aria-live="polite" className="admin-form-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="admin-form-error">
          {error}
        </p>
      )}

      {exemptions.length === 0 ? (
        <p className="admin-corpus-empty">No accounts are currently exempt from the maturity gate.</p>
      ) : (
        <div className="developer-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Exempt since</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {exemptions.map((row) => (
                <tr key={row.userId}>
                  <td>{row.email}</td>
                  <td>{row.createdAt}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-btn-danger-outline"
                      onClick={() => removeExemption(row.userId)}
                      disabled={removingId === row.userId}
                    >
                      {removingId === row.userId ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
