"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Activity, GitBranch, TableProperties } from "lucide-react";
import type { ArchiveExplorerDetail, ArchiveExplorerListResult, ArchiveExplorerSummary } from "./archive-types";
import { ArchiveActivityFeed } from "./archive-activity-feed";
import { ArchiveGrowthChart } from "./archive-growth-chart";
import { ArchiveSourceExplorer } from "./archive-source-explorer";
import { ArchiveSourceDetail } from "./archive-source-detail";

const SOURCE_PARAM = "source";

/**
 * The interactive half of /admin/archive: lifecycle + growth, recent
 * activity, and the source table with its detail panel — one shared
 * selection, so an activity event and a table row open the same panel.
 * Read-only: every request is a GET to an admin-gated route.
 */
export function AdminArchiveWorkspace({
  summary,
  lifecycle,
  initialList,
}: {
  summary: ArchiveExplorerSummary | null;
  lifecycle: ReactNode;
  initialList: ArchiveExplorerListResult | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveExplorerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const cache = useRef(new Map<string, ArchiveExplorerDetail>());
  const sourcesRef = useRef<HTMLElement | null>(null);
  const previousSelectedId = useRef<string | null>(null);

  // Deep link: /admin/archive?source=<id> reopens the same panel.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get(SOURCE_PARAM);
    if (fromUrl) setSelectedId(fromUrl);
  }, []);

  useEffect(() => {
    // Only a real selection change touches the URL — never the initial null
    // render, which would otherwise strip a ?source= deep link before it loads.
    if (previousSelectedId.current !== selectedId) {
      const url = new URL(window.location.href);
      if (selectedId) url.searchParams.set(SOURCE_PARAM, selectedId);
      else url.searchParams.delete(SOURCE_PARAM);
      window.history.replaceState(window.history.state, "", url.toString());
    }
    previousSelectedId.current = selectedId;

    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const cached = cache.current.get(selectedId);
    if (cached) {
      setDetail(cached);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    fetch(`/api/admin/archive/${encodeURIComponent(selectedId)}`)
      .then((response) => {
        if (response.status === 404) throw new Error("This source no longer exists.");
        if (!response.ok) throw new Error(`Could not load this source (${response.status}).`);
        return response.json() as Promise<ArchiveExplorerDetail>;
      })
      .then((data) => {
        if (cancelled) return;
        cache.current.set(data.sourceId, data);
        setDetail(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : "Could not load this source.");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const selectFromActivity = useCallback((sourceId: string) => {
    setSelectedId(sourceId);
    sourcesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const shownDetail = detail && detail.sourceId === selectedId ? detail : null;

  return (
    <>
      {summary && (
        <div className="admin-archive-band">
          <section className="admin-card admin-archive-panel">
            <h2>
              <GitBranch size={17} className="admin-card-title-icon" aria-hidden="true" />
              Admission lifecycle
            </h2>
            {lifecycle}
            <h3 className="admin-archive-subhead">Intake · last 30 days (UTC)</h3>
            <ArchiveGrowthChart growth={summary.growth} />
          </section>
          <section className="admin-card admin-archive-panel">
            <h2>
              <Activity size={17} className="admin-card-title-icon" aria-hidden="true" />
              Recent corpus activity
            </h2>
            <ArchiveActivityFeed events={summary.activity} referenceIso={summary.generatedAt} onSelect={selectFromActivity} />
          </section>
        </div>
      )}

      <section className="admin-card admin-archive-sources" id="archive-sources" ref={sourcesRef}>
        <h2>
          <TableProperties size={17} className="admin-card-title-icon" aria-hidden="true" />
          Sources
        </h2>
        <div className={`admin-archive-explorer${selectedId ? " has-selection" : ""}`}>
          <ArchiveSourceExplorer initialList={initialList} selectedId={selectedId} onSelect={setSelectedId} />
          <aside className="admin-archive-detail-pane" aria-label="Source details">
            <ArchiveSourceDetail
              sourceId={selectedId}
              detail={shownDetail}
              loading={detailLoading}
              error={detailError}
              onClose={() => setSelectedId(null)}
            />
          </aside>
          {selectedId && <button type="button" className="admin-archive-scrim" aria-label="Close source details" onClick={() => setSelectedId(null)} />}
        </div>
      </section>
    </>
  );
}
