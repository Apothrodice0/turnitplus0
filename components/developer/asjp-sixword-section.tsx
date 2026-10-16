"use client";

import { useEffect, useMemo, useState } from "react";
import { tokenSpans } from "@/lib/similarity-core";

/**
 * Developer evidence section — INFORMATIONAL six-word overlap of a saved report (experiment, off by default).
 *
 * Nothing runs until the developer presses "Run six-word search": the search is never part of upload or save. What
 * is shown is kept visibly apart from scored evidence:
 *   - "Verified exact text overlap": the manuscript words shown are the report's own words at the stored positions;
 *   - "Informational — not included in the similarity score" on the section AND on every match;
 *   - "Multiple source holders" / "Original source not established" on every match (never an origin claim);
 *   - a stopped search (time / size limit) or an unavailable one is a warning with NO result — never "0 matches".
 * Words the scored ASJP lane already credits are marked (they count once, through the lane).
 */
type Holder = { sourceId: string; title: string | null; journal: string | null; date: string | null; url: string | null; sourceWords: [number, number]; sourceChars: [number, number] | null };
type Item = { words: [number, number]; length: number; band: string; held: string; multipleHolders: boolean; commonness: string; holdersInIndex: number; alreadyCountedThroughScoredLane: number; holders: Holder[]; holdersNotListed: number; notEligible: Record<string, number>; labels: { form: string | null; legal: boolean; religious: boolean } };
type View = {
  outcome: "NOT_RUN" | "COMPLETE" | "SEARCH_STOPPED_AT_LIMIT" | "SEARCH_UNAVAILABLE" | "RETRACTED" | "UNTRUSTED_RECORD";
  label?: string; message?: string; reason?: string | null; checkedAt?: string;
  pins?: { generationId: string; referenceDate: string | null; licencePolicy: string } | null;
  summary?: { matches: number; unique: number; shared: number; common: number; withoutEligibleHolder: number; wordsInEligibleMatch: number } | null;
  truncation?: { matchesOmitted: number; commonOmitted: number; matchesWithHoldersOmitted: number; holdersWithoutCharOffsets: number; recordTrimmedMatches: number } | null;
  staleGeneration?: boolean; currentGenerationId?: string | null; items?: Item[];
};
const LABEL = "Exact text overlap — not included in similarity score";
const safeUrl = (u: string | null) => (u && /^https:\/\/asjp\.cerist\.dz\//.test(u) ? u : null);

export function AsjpSixwordSection({ reportId, deviceKey, text }: { reportId: string; deviceKey: string; text: string }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const spans = useMemo(() => tokenSpans(text ?? "", 2), [text]);
  const excerpt = (s: number, e: number) => (spans[s] && spans[e] ? text.slice(spans[s].start, spans[e].end) : null);
  const endpoint = `/api/admin/reports/${encodeURIComponent(reportId)}/asjp-sixword`;

  useEffect(() => {
    let live = true;
    fetch(`${endpoint}?deviceKey=${encodeURIComponent(deviceKey)}`, { cache: "no-store" })
      .then(async (r) => { if (!live) return; if (r.status === 404) { setHidden(true); return; } const j = (await r.json()) as { view?: View }; setView(j.view ?? null); })
      .catch(() => live && setError("Could not load the stored result."));
    return () => { live = false; };
  }, [endpoint, deviceKey]);

  async function act(action: "run" | "retract") {
    setBusy(true); setError(null);
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey, action }) });
      if (r.status === 404) { setHidden(true); return; }
      const j = (await r.json()) as { view?: View; outcome?: string; reason?: string };
      if (j.view) setView(j.view); else setError(`Not stored: ${String(j.outcome ?? "error")}${j.reason ? ` (${j.reason})` : ""}`);
    } catch { setError("The request failed. No result is available — this does NOT mean zero matches."); }
    finally { setBusy(false); }
  }

  if (hidden) return null;
  return (
    <section className="admin-card" data-testid="asjp-sixword-section">
      <h2>{LABEL}</h2>
      <p>
        <span className="admin-status-badge admin-status-badge--info">Informational · unscored</span>{" "}
        Exact matches of six or more consecutive words with indexed English ASJP articles. They never change the similarity score,
        never appear as report highlights, and never name an original source.
      </p>
      <p>
        <button type="button" className="admin-btn-primary" disabled={busy} onClick={() => act("run")}>{busy ? "Searching…" : "Run six-word search"}</button>{" "}
        {view && view.outcome !== "NOT_RUN" && view.outcome !== "RETRACTED" ? <button type="button" className="admin-dialog-cancel" disabled={busy} onClick={() => act("retract")}>Retract result</button> : null}
      </p>
      {error ? <p className="admin-status-badge admin-status-badge--warning">{error}</p> : null}
      {!view || view.outcome === "NOT_RUN" ? <p>Not run. The six-word search runs only when you request it.</p> : null}
      {view && view.outcome === "UNTRUSTED_RECORD" ? <p className="admin-status-badge admin-status-badge--negative">The stored result could not be verified for this report and is not shown.</p> : null}
      {view && (view.outcome === "SEARCH_STOPPED_AT_LIMIT" || view.outcome === "SEARCH_UNAVAILABLE" || view.outcome === "RETRACTED") ? (
        <p className={`admin-status-badge admin-status-badge--${view.outcome === "RETRACTED" ? "neutral" : "warning"}`} data-testid="asjp-sixword-no-result">
          {view.message} {view.reason ? `(${view.reason})` : ""}
        </p>
      ) : null}
      {view && view.outcome === "COMPLETE" ? (
        <>
          {view.staleGeneration ? <p className="admin-status-badge admin-status-badge--warning">Computed on index generation {view.pins?.generationId}; the service now pins {view.currentGenerationId}. Re-run to refresh.</p> : null}
          <p>{view.message}</p>
          <p>
            Checked {view.checkedAt} · generation {view.pins?.generationId} · publication before {view.pins?.referenceDate ?? "(no date)"} · {view.pins?.licencePolicy} ·{" "}
            {view.summary?.matches ?? 0} matches found ({view.summary?.unique ?? 0} with one holder, {view.summary?.shared ?? 0} shared, {view.summary?.common ?? 0} common; {view.summary?.withoutEligibleHolder ?? 0} with no eligible holder) ·
            shown {view.items?.length ?? 0}{view.truncation?.matchesOmitted ? `, ${view.truncation.matchesOmitted} more not listed` : ""}
            {view.truncation?.recordTrimmedMatches ? `, ${view.truncation.recordTrimmedMatches} trimmed to fit the record` : ""}
          </p>
          <ol>
            {(view.items ?? []).map((m) => (
              <li key={`${m.words[0]}-${m.words[1]}`} data-testid="asjp-sixword-match">
                <span className="admin-status-badge admin-status-badge--positive">Verified exact text overlap</span>{" "}
                <span className="admin-status-badge admin-status-badge--info">Informational · unscored</span>{" "}
                {m.multipleHolders ? <span className="admin-status-badge admin-status-badge--warning">Multiple source holders</span> : null}{" "}
                <span className="admin-status-badge admin-status-badge--neutral">Original source not established</span>
                <div>
                  Manuscript words {m.words[0]}–{m.words[1]} ({m.length} words, {m.band}, {m.commonness.toLowerCase()} wording): <q>{excerpt(m.words[0], m.words[1]) ?? "(position outside the stored text)"}</q>
                </div>
                <div>{m.held}{m.holdersNotListed ? ` · ${m.holdersNotListed} more holders not listed` : ""}{m.alreadyCountedThroughScoredLane ? ` · ${m.alreadyCountedThroughScoredLane} of these words are already counted through the scored ASJP lane` : ""}</div>
                <ul>
                  {m.holders.map((h) => (
                    <li key={h.sourceId}>
                      {safeUrl(h.url) ? <a href={safeUrl(h.url)!} target="_blank" rel="noopener noreferrer">{h.title ?? h.sourceId}</a> : (h.title ?? h.sourceId)}
                      {h.journal ? ` · ${h.journal}` : ""}{h.date ? ` · ${h.date}` : ""} · article words {h.sourceWords[0]}–{h.sourceWords[1]}
                      {h.sourceChars ? ` · characters ${h.sourceChars[0]}–${h.sourceChars[1]}` : " · character offsets not computed (word positions verified)"}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
