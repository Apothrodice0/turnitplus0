"use client";

import Link from "next/link";
import {
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Download,
  FileCheck2,
  FileText,
  FolderClock,
  Globe2,
  GraduationCap,
  LayoutDashboard,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Printer,
  Search,
  Save,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  UploadCloud,
  UserRound,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { getDeviceKey } from "@/lib/device-key";
import { clearStoredReports, loadStoredReports, storeReport, storeReportBestEffort } from "@/lib/report-store";
import { deleteRemoteReport, fetchAllReportSummariesAcrossRooms, fetchRemoteReport, fetchUploadLimitStatus, listRemoteReportSummaries, saveReportRemote, type ReportSummary, type UploadLimitStatus } from "@/lib/reports-remote";
import { persistAiCompletion } from "@/lib/report-ai-completion";
import { clearAllReportRoomCaches } from "@/lib/report-rooms-cache";
import { ReportRoomsBrowser } from "@/components/reports/report-rooms";
import { ReportHistoryRow } from "@/components/reports/report-history-row";
import { DocumentUploadPanel } from "@/components/reports/document-upload-panel";
import { IdentityFields, type IdentityFieldsHandle, type CollectedIdentity } from "@/components/auth/identity-fields";
import { EmailVerificationStatus } from "@/components/account/email-verification-status";
import {
  analyzeAcademicEvidence,
  analyzeText,
  analyzeWikipediaText,
  attachUnifiedSimilarity,
  downloadReceipt,
  enrichReportWithAcademicEvidence,
  enrichReportWithWikipedia,
  extractFileText,
} from "@/lib/document-check-pipeline";
import { normalizeExtractedText } from "@/lib/extracted-text-normalization";
import {
  AI_MODEL_VERSION,
  AI_PASSAGE_LOG_ODDS_THRESHOLD,
  AI_PASSAGE_THRESHOLD,
} from "@/lib/ai-core";
import {
  aiPrepDetailLabel,
  describeAiAnalysisError,
  type AiPrepStage,
  type AiPrepUpdate,
} from "@/lib/ai-model-prep";
import {
  buildReportSummary,
  type AiAnalysis,
  type SimilarityReport,
} from "@/lib/report-types";

// This page is prerendered on the server (see the static "/" build output),
// and useLayoutEffect warns there ("useLayoutEffect does nothing on the
// server") since there's no DOM to schedule it against — harmless (React
// already no-ops it server-side), but avoidable with the standard fallback:
// useEffect during any server-side render pass, useLayoutEffect once a real
// DOM exists on the client.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type View = "home" | "dashboard" | "reports" | "about" | "account" | "welcome" | "legal" | "processing";
type AuthMode = "login" | "signup";

// Must match lib/account-deletion.ts's ACCOUNT_DELETION_CONFIRMATION_PHRASE
// exactly. Duplicated here rather than imported: that file pulls in
// @libsql/client, a Node-only dependency that must never reach this
// client-side bundle.
const ACCOUNT_DELETION_CONFIRMATION_PHRASE = "DELETE MY ACCOUNT";
// Production audit fix: a same-origin localStorage write under this key
// broadcasts sign-out to every OTHER open tab via the browser's "storage"
// event (see signOutAccount/the storage listener below) — without it, a
// second tab kept showing the previous account's name/room list until
// manually refreshed, even though the session cookie was already cleared.
const SIGNED_OUT_BROADCAST_KEY = "tp_signed_out_broadcast";
type LegalTab = "privacy" | "terms";
type LocalAccount = { username: string; email: string; corpusReuseConsent: boolean };
// Structured identity is collected once, at signup, and is not re-shown or
// re-editable on the Account page (product decision) — so no identity view
// type is kept here. /api/auth/me still returns it (untouched, unread by this
// page); nothing about the stored data changes.
// A3 — the plain email-verification state /api/auth/me returns, from the
// authoritative users.email_verified_at. Never a challenge id, token, or digest.
type EmailVerificationView = { status: "verified" | "unverified" };

// The shape lib/report-store.ts's loadStoredReports() actually returns since
// it started reading from IndexedDB's own lightweight summary store rather
// than full report bodies — a subset of SimilarityReport's fields, not the
// real thing (text/sources/aiAnalysis/etc. are never present here).
type LocalReportHistoryEntry = {
  id: number;
  submissionId: string;
  title: string;
  created: string;
  score: number;
  archiveScore?: number;
  aiScore: number | null;
  wordCount: number;
  scoreBand: "Low" | "Moderate" | "High";
};

/** Mirrors aiSignalDisplay's own value->tone thresholds (lib/report-types.ts) so a local-only summary's tone label matches exactly what the full computation would have produced, without needing the full report just to derive it. */
function aiToneForScore(aiScore: number | null): string | null {
  if (aiScore === null) return null;
  if (aiScore < 20) return "low";
  if (aiScore <= 50) return "review";
  return "high";
}

function localHistoryEntryToSummary(entry: LocalReportHistoryEntry): ReportSummary {
  return {
    id: String(entry.id),
    submissionId: entry.submissionId,
    title: entry.title,
    createdAt: entry.created,
    wordCount: entry.wordCount,
    archiveScore: entry.archiveScore ?? entry.score,
    scoreBand: entry.scoreBand,
    aiScore: entry.aiScore,
    aiTone: aiToneForScore(entry.aiScore),
  };
}

const VIEW_HASH: Record<Exclude<View, "processing">, string> = {
  home: "#home",
  dashboard: "#dashboard",
  reports: "#reports",
  about: "#how-it-works",
  account: "#account",
  welcome: "#welcome",
  legal: "#privacy-terms",
};

export function viewFromHash(hash: string): View {
  if (hash === "#home") return "home";
  if (hash === "#reports") return "reports";
  if (hash === "#how-it-works") return "about";
  if (hash === "#account") return "account";
  if (hash === "#welcome") return "welcome";
  if (hash === "#privacy-terms") return "legal";
  return "home";
}

let aiDetectorWorker: Worker | null = null;
let aiWorkerRequestId = 0;

let pendingAiReject: ((error: Error) => void) | null = null;

async function analyzeAiText(
  text: string,
  detectedLanguage: SimilarityReport["features"]["detectedLanguage"],
  onProgress: (update: AiPrepUpdate) => void,
): Promise<AiAnalysis> {
  aiDetectorWorker ??= new Worker(
    new URL("./ai-detector-worker.ts", import.meta.url),
    { type: "module" },
  );
  const id = ++aiWorkerRequestId;
  return new Promise<AiAnalysis>((resolve, reject) => {
    pendingAiReject = reject;
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "prep") {
        onProgress({
          stage: event.data.stage,
          label: event.data.label,
          cached: event.data.cached,
          progress: event.data.progress ?? null,
        });
        return;
      }
      if (event.data.type === "progress") {
        if (event.data.id === id) {
          onProgress({ stage: "analyzing", label: event.data.label, cached: false, progress: null });
        }
        return;
      }
      if (event.data.id !== id) return;
      aiDetectorWorker?.removeEventListener("message", handleMessage);
      if (pendingAiReject === reject) pendingAiReject = null;
      if (event.data.ok) resolve(event.data.result as AiAnalysis);
      else reject(new Error(event.data.error));
    };
    aiDetectorWorker?.addEventListener("message", handleMessage);
    aiDetectorWorker?.postMessage({ id, text, detectedLanguage });
  });
}

export default function Home() {
  const [view, setView] = useState<View>("account");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [processingLabel, setProcessingLabel] = useState("Reading document content");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const aiPrepStageRef = useRef<AiPrepStage | null>(null);
  const [currentReport, setCurrentReport] = useState<SimilarityReport | null>(null);
  // Anonymous (device-scoped) report list only, from here on — lightweight
  // summaries, never full report bodies (see loadAnonymousReports). An
  // authenticated account's list is owned entirely by ReportRoomsBrowser
  // (the 10-room architecture) below, not this state.
  const [reports, setReports] = useState<ReportSummary[]>([]);
  // Mirrors ReportRoomsBrowser's own total-report count (summed across all
  // rooms) up to this component, for the sidebar badge and "Clear history"
  // visibility — see onTotalCountChange.
  const [accountReportCount, setAccountReportCount] = useState(0);
  // Bumped to force ReportRoomsBrowser to fully remount (discarding its own
  // in-memory room index/contents) after "Clear history" — that action
  // already invalidates its localStorage caches, but the currently-mounted
  // instance's React state wouldn't otherwise notice until the user
  // navigated away and back.
  const [roomsBrowserKey, setRoomsBrowserKey] = useState(0);
  const [toast, setToast] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [welcomeMode, setWelcomeMode] = useState<AuthMode | null>(null);
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [emailVerification, setEmailVerification] = useState<EmailVerificationView | null>(null);
  const [emailVerifySending, setEmailVerifySending] = useState(false);
  const [emailVerifyNotice, setEmailVerifyNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const signupIdentityRef = useRef<IdentityFieldsHandle>(null);
  const [uploadLimitStatus, setUploadLimitStatus] = useState<UploadLimitStatus | null>(null);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isSubmittingDeletion, setIsSubmittingDeletion] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authProgress, setAuthProgress] = useState(0);
  const [authLoadingLabel, setAuthLoadingLabel] = useState("Preparing your sign-in");
  const [authError, setAuthError] = useState<string | null>(null);
  const [profileEditError, setProfileEditError] = useState<string | null>(null);
  const [legalTab, setLegalTab] = useState<LegalTab>("privacy");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationLockRef = useRef(false);

  // Anonymous/device-scoped report loading (no authenticated session).
  // Unchanged from the pre-Phase-2A behavior: IndexedDB is the primary
  // source, with a one-time remote (device_key-scoped) fallback only when
  // local storage is genuinely empty. The 10-room architecture (see
  // ReportRoomsBrowser) is an authenticated-account concern only — an
  // anonymous device's history is already local-first and typically far
  // smaller, so this keeps loading the full local objects as before, only
  // converting to lightweight summaries at the very end for display.
  async function loadAnonymousReports() {
    try {
      // loadStoredReports now reads from IndexedDB's own lightweight summary
      // store (see lib/report-store.ts), not full report bodies — it
      // returns fields shaped like LocalReportHistoryEntry below, not a real
      // SimilarityReport, so this converts directly rather than calling
      // buildReportSummary() (which would read report.aiAnalysis — absent
      // here — and silently produce the wrong AI label despite a perfectly
      // good aiScore already being available).
      const localEntries = await loadStoredReports<LocalReportHistoryEntry>(11);
      setReports(localEntries.map(localHistoryEntryToSummary));
      if (localEntries.length > 0) return;
      const summaries = await listRemoteReportSummaries();
      if (summaries.length === 0) return;
      const restored: SimilarityReport[] = [];
      for (const summary of summaries) {
        const full = await fetchRemoteReport<SimilarityReport>(summary.id);
        if (full) restored.push(full);
      }
      if (restored.length === 0) return;
      setReports(restored.map(buildReportSummary));
      for (const report of restored) {
        await storeReport(report);
      }
    } catch {
      setReports([]);
    }
  }

  // Authenticated report loading. Room architecture: this account's own
  // report list is never eagerly hydrated here at all — ReportRoomsBrowser
  // (rendered only when `account` is set — see the "reports" view below)
  // owns fetching/caching its own room index directly from the
  // session-scoped, account-scoped API route, and each room's own page
  // (app/reports/rooms/[room]) owns fetching that one room's data when the
  // user opens it. This function's only remaining job is account-scoped
  // state that ISN'T report-list data: the upload quota, and clearing the
  // stale anonymous `reports` list left over from a previous auth state.
  async function loadAccountReports() {
    setReports([]);
    void fetchUploadLimitStatus().then(setUploadLimitStatus);
  }

  // /api/auth/me is the SINGLE source of truth for the signed-in account's
  // display state: `user` and the email-verification status. (It also returns
  // the stored identity profile — untouched, A2 signup remains mandatory and
  // unchanged — but the Account page no longer displays it, so this page never
  // reads that field.) The /api/auth/login and /api/auth/signup responses
  // carry only `user`, so after an in-page sign-in this must run too —
  // otherwise `emailVerification` stays at its logged-out `null` and the
  // account page renders without the "Email not verified / Verify email"
  // control until a manual refresh.
  //
  // On success it populates both; it NEVER clears them on a transient failure
  // (a caller that already set `account` from a fresh auth response must not
  // have it wiped by a flaky follow-up request).
  async function hydrateAccountFromServer(): Promise<"signed-in" | "signed-out" | "error"> {
    let result: {
      user?: LocalAccount | null;
      emailVerification?: EmailVerificationView | null;
    } | null;
    try {
      const response = await fetch("/api/auth/me");
      if (!response.ok) return "error";
      result = (await response.json()) as typeof result;
    } catch {
      return "error";
    }
    if (result && result.user) {
      setAccount(result.user);
      setEmailVerification(result.emailVerification ?? null);
      return "signed-in";
    }
    return "signed-out";
  }

  useEffect(() => {
    queueMicrotask(() => {
      setSidebarCollapsed(window.localStorage.getItem("tp_sidebar_collapsed") === "true");
    });
    // Authentication state is resolved first, then exactly one of the two
    // report sources is used — never both — so a previous session's
    // reports can never linger into a different auth state at hydration.
    (async () => {
      try {
        const state = await hydrateAccountFromServer();
        if (state === "signed-in") await loadAccountReports();
        else await loadAnonymousReports();
      } catch {
        await loadAnonymousReports();
      } finally {
        setAccountLoaded(true);
      }
    })();
  }, []);

  // Cross-tab sign-out (production audit fix): the "storage" event fires in
  // every OTHER same-origin tab (never the one that made the write) the
  // moment signOutAccount() writes SIGNED_OUT_BROADCAST_KEY — this is the
  // only way a tab that did NOT initiate the sign-out learns about it.
  // Deliberately does not repeat the /api/auth/logout network call (the
  // initiating tab's own call already cleared the session cookie for real)
  // and does not touch IndexedDB/Turso, matching clearAccountDisplayState's
  // own scope.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== SIGNED_OUT_BROADCAST_KEY || event.newValue === null) return;
      clearAccountDisplayState();
      window.history.replaceState({ turnitPlusView: "account" }, "", VIEW_HASH.account);
      setView("account");
      notify("You were signed out in another tab.");
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Deliberately independent of account/accountLoaded: which view the URL
  // hash requests (e.g. #reports) never depends on auth state — only the
  // *content* within a view does, and that already renders its own loading
  // state from `reports`/`account` directly. Gating this on accountLoaded
  // used to mean every mount (including a client-side "Back to reports" nav
  // from /reports/[id], which fully remounts this component) sat on the
  // useState("account") default — the signed-out account/login page — for
  // however long the session fetch below took, before ever reaching this
  // effect. The isomorphic layout effect runs synchronously after the DOM
  // commit but before the browser paints, so the correct view is what the
  // user actually sees on the very first frame instead of a flash of the
  // wrong one.
  useIsomorphicLayoutEffect(() => {
    const syncViewFromLocation = () => {
      const requestedView = viewFromHash(window.location.hash);
      if (generationLockRef.current && requestedView === "dashboard") {
        window.history.replaceState({ turnitPlusView: "reports" }, "", VIEW_HASH.reports);
        setView("reports");
      } else {
        setView(requestedView);
      }
      setMobileNavOpen(false);
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    syncViewFromLocation();
    window.addEventListener("popstate", syncViewFromLocation);
    window.addEventListener("hashchange", syncViewFromLocation);
    return () => {
      window.removeEventListener("popstate", syncViewFromLocation);
      window.removeEventListener("hashchange", syncViewFromLocation);
    };
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      window.localStorage.setItem("tp_sidebar_collapsed", String(next));
      return next;
    });
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }

  async function submitAuthInterface(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isAuthenticating) return;
    const completedMode = authMode ?? "login";
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const username = String(formData.get("username") ?? "").trim();
    const remember = formData.get("remember") === "on";

    let signupIdentity: CollectedIdentity | null = null;
    if (completedMode === "signup") {
      const confirmPassword = String(formData.get("confirmPassword") ?? "");
      const confirmInput = event.currentTarget.elements.namedItem("confirmPassword") as HTMLInputElement | null;
      if (password !== confirmPassword) {
        confirmInput?.setCustomValidity("The passwords do not match.");
        confirmInput?.reportValidity();
        return;
      }
      confirmInput?.setCustomValidity("");
      // The server re-resolves and re-validates all of this; the component just
      // shows its own inline errors and blocks submit until they're resolved.
      signupIdentity = signupIdentityRef.current?.collect() ?? null;
      if (!signupIdentity) return;
    }

    setAuthError(null);
    setIsAuthenticating(true);
    setAuthProgress(10);
    setAuthLoadingLabel(completedMode === "login" ? "Preparing your sign-in" : "Creating your workspace");

    // Real request, not a fixed timer: the progress bar animates toward a
    // minimum display duration while the request is in flight, and pads out
    // to that minimum if the response comes back faster, matching the
    // real-work-plus-minimum-animation pattern used for report generation.
    const minimumAuthMs = 1_800;
    const animationStartedAt = Date.now();
    const progressTimer = window.setInterval(() => {
      const elapsed = Date.now() - animationStartedAt;
      setAuthProgress(Math.min(90, 10 + Math.round((elapsed / minimumAuthMs) * 80)));
    }, 150);
    const labelTimers = [
      window.setTimeout(() => setAuthLoadingLabel("Preparing your private workspace"), 500),
      window.setTimeout(() => setAuthLoadingLabel("Loading your report history"), 1100),
    ];
    const stopAnimation = () => {
      window.clearInterval(progressTimer);
      labelTimers.forEach((timer) => window.clearTimeout(timer));
    };

    let response: Response;
    try {
      response = await fetch(completedMode === "login" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          completedMode === "signup"
            ? { email, password, username, deviceKey: getDeviceKey(), remember, identity: signupIdentity }
            : { email, password, username, deviceKey: getDeviceKey(), remember },
        ),
      });
    } catch {
      stopAnimation();
      setIsAuthenticating(false);
      setAuthError("Could not reach TurnitPlus. Check your connection and try again.");
      return;
    }

    const data = (await response.json().catch(() => null)) as { user?: LocalAccount; error?: string } | null;
    if (!response.ok || !data?.user) {
      stopAnimation();
      setIsAuthenticating(false);
      setAuthError((data && typeof data.error === "string" && data.error) || "Something went wrong. Please try again.");
      return;
    }

    setAccount(data.user as LocalAccount);
    // The login/signup response carries only `user`. Pull the email-
    // verification status from /api/auth/me so the account page is complete
    // immediately — without this, `emailVerification` would stay `null` (its
    // logged-out value) until the user manually refreshed, hiding the
    // "Verify email" control even though the server already has it.
    await hydrateAccountFromServer();
    setAuthLoadingLabel("Loading your report history");
    // Replaces (never merges with) whatever was previously displayed —
    // signing in as a different account, or into an account after browsing
    // anonymously, must not show the prior view's reports.
    await loadAccountReports();

    setAuthLoadingLabel("Almost ready");
    const remainingMs = Math.max(0, minimumAuthMs - (Date.now() - animationStartedAt));
    if (remainingMs > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
    stopAnimation();
    setAuthProgress(100);

    setIsAuthenticating(false);
    setAuthMode(null);
    setWelcomeMode(completedMode);
    navigate("welcome");
  }

  // Display-name / email / corpus-reuse-consent only. Structured identity is
  // collected once at signup (unchanged, still mandatory there) and is not
  // re-shown or re-editable from this form — the Account page never sends an
  // `identity` payload, so /api/auth/me's identity handling is simply unused
  // from here rather than removed.
  async function submitProfileEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    const data = new FormData(event.currentTarget);
    const username = String(data.get("profileUsername") ?? "").trim();
    const email = String(data.get("profileEmail") ?? "").trim();
    const corpusReuseConsent = data.get("corpusReuseConsent") === "on";

    setProfileEditError(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, corpusReuseConsent }),
      });
    } catch {
      setProfileEditError("Could not reach TurnitPlus. Check your connection and try again.");
      return;
    }

    const result = (await response.json().catch(() => null)) as {
      user?: LocalAccount;
      emailVerification?: EmailVerificationView | null;
      error?: string;
    } | null;
    if (!response.ok || !result?.user) {
      setProfileEditError((result && typeof result.error === "string" && result.error) || "Could not update your account information.");
      return;
    }

    setAccount(result.user as LocalAccount);
    setEmailVerification(result.emailVerification ?? null);
    setEmailVerifyNotice(null);
    setIsEditingProfile(false);
    notify("Your account information has been updated.");
  }

  // A3 — request (or resend) the verification email for the signed-in account.
  // The account UI never sees a token or challenge id; it only learns the
  // coarse outcome.
  async function sendEmailVerification() {
    if (emailVerifySending) return;
    setEmailVerifySending(true);
    setEmailVerifyNotice(null);
    try {
      const response = await fetch("/api/auth/email-verification/send", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
      if (response.ok && data.status === "sent") {
        setEmailVerifyNotice({ tone: "ok", text: "Verification email sent. Check your inbox and open the link within 30 minutes." });
      } else if (response.ok && data.status === "verified") {
        setEmailVerification({ status: "verified" });
        setEmailVerifyNotice({ tone: "ok", text: "Your email is already verified." });
      } else {
        setEmailVerifyNotice({
          tone: "error",
          text: typeof data.error === "string" && data.error ? data.error : "Could not send the verification email. Please try again shortly.",
        });
      }
    } catch {
      setEmailVerifyNotice({ tone: "error", text: "Could not reach TurnitPlus. Check your connection and try again." });
    } finally {
      setEmailVerifySending(false);
    }
  }

  // The account and every one of its sessions are already gone server-side
  // by the time this runs (DELETE /api/auth/me only returns 200 after both
  // succeed), so this just clears local state and returns to the logged-out
  // account view — unlike signOutAccount, there is no separate logout call
  // to make and nothing remote left to keep in sync with.
  function completeAccountDeletion() {
    if (account) clearAllReportRoomCaches(account.email);
    setReports([]);
    setCurrentReport(null);
    setAccount(null);
    setUploadLimitStatus(null);
    setAccountReportCount(0);
    setIsEditingProfile(false);
    setIsDeletingAccount(false);
    setDeleteAccountError(null);
    setIsSubmittingDeletion(false);
    setAuthMode("login");
    setWelcomeMode(null);
    window.history.replaceState({ turnitPlusView: "account" }, "", VIEW_HASH.account);
    setView("account");
    notify("Your account has been permanently deleted.");
  }

  async function submitAccountDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || isSubmittingDeletion) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get("deletePassword") ?? "");
    const confirm = String(data.get("deleteConfirm") ?? "");

    if (confirm !== ACCOUNT_DELETION_CONFIRMATION_PHRASE) {
      setDeleteAccountError(`Type "${ACCOUNT_DELETION_CONFIRMATION_PHRASE}" exactly to confirm.`);
      return;
    }
    if (!password) {
      setDeleteAccountError("Enter your password to confirm.");
      return;
    }

    setDeleteAccountError(null);
    setIsSubmittingDeletion(true);
    let response: Response;
    try {
      response = await fetch("/api/auth/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirm }),
      });
    } catch {
      setDeleteAccountError("Could not reach TurnitPlus. Check your connection and try again.");
      setIsSubmittingDeletion(false);
      return;
    }

    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      setDeleteAccountError((result && typeof result.error === "string" && result.error) || "Could not delete your account. Try again.");
      setIsSubmittingDeletion(false);
      return;
    }

    completeAccountDeletion();
  }

  function navigate(nextView: View) {
    if (generationLockRef.current && nextView === "dashboard") {
      if (window.location.hash !== VIEW_HASH.reports) {
        window.history.pushState({ turnitPlusView: "reports" }, "", VIEW_HASH.reports);
      }
      setView("reports");
      setMobileNavOpen(false);
      notify("Your current report must finish before another document can be uploaded.");
      return;
    }
    const nextHash = nextView === "processing"
      ? "#reports"
      : VIEW_HASH[nextView];
    if (window.location.hash !== nextHash) {
      window.history.pushState({ turnitPlusView: nextView }, "", nextHash);
    }
    setView(nextView);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAccountPage(mode: AuthMode = "login") {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      window.localStorage.setItem("tp_sidebar_collapsed", "false");
    }
    setAuthMode(mode);
    setMobileNavOpen(false);
    navigate("account");
  }

  function openLegalPage(tab: LegalTab) {
    setLegalTab(tab);
    navigate("legal");
  }

  // Shared by signOutAccount (this tab) and the cross-tab storage listener
  // below (production audit fix) — only the in-memory display state, never
  // IndexedDB/Turso; the account's remote reports and this device's local
  // cache are both left exactly as they were, so the same account signing
  // back in on this device still benefits from them.
  function clearAccountDisplayState() {
    setReports([]);
    setCurrentReport(null);
    setAccount(null);
    setEmailVerification(null);
    setEmailVerifyNotice(null);
    setUploadLimitStatus(null);
    setAccountReportCount(0);
    setIsEditingProfile(false);
    setAuthMode("login");
    setWelcomeMode(null);
  }

  function signOutAccount() {
    // Cleared immediately, before the network call even resolves, so the
    // sidebar badge and report list never keep showing the previous
    // account's data during (or after a failure of) the logout request.
    clearAccountDisplayState();
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // A same-origin localStorage write fires the "storage" event in every
    // OTHER open tab (never this one) — see the listener below. The value
    // itself carries no meaning beyond "changed"; only the key and the
    // fact of the write matter.
    try {
      window.localStorage.setItem(SIGNED_OUT_BROADCAST_KEY, String(Date.now()));
    } catch {
      // Storage unavailable/private-mode — this tab's own sign-out above is
      // already complete; only the cross-tab broadcast is lost.
    }
    window.history.replaceState({ turnitPlusView: "account" }, "", VIEW_HASH.account);
    setView("account");
    notify("You have signed out.");
  }

  function chooseFile(selected: File | undefined) {
    if (generationLockRef.current) {
      notify("Please wait for the current report to finish before choosing another document.");
      return;
    }
    if (!selected) return;
    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "docx", "txt", "md", "html", "csv"].includes(extension ?? "")) {
      notify("Choose a PDF, DOCX, TXT, MD, HTML, or CSV file.");
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      notify("The file must be 10 MB or smaller.");
      return;
    }
    setFile(selected);
  }

  // Anonymous-only from here on: an authenticated account's new check
  // always happens on its own dedicated room page
  // (app/reports/rooms/[room]/room-page-shell.tsx), which owns its own
  // save/room-threading logic — see that file's own header comment. The
  // Dashboard/generateReport() flow below is never reachable by a signed-in
  // account in normal use (goToNewCheck() routes them into My Reports
  // instead — see below), so it stays exactly as simple as a roomless,
  // account-less save actually is.
  async function saveReport(report: SimilarityReport, academicSearchDiagnosticsId?: number | null) {
    const summary = buildReportSummary(report);
    setReports((current) => [summary, ...current.filter((item) => item.id !== summary.id)].slice(0, 50));
    await storeReportBestEffort(report);
    return await saveReportRemote(report, summary, academicSearchDiagnosticsId);
  }

  async function generateReport() {
    if (generationLockRef.current) {
      notify("Your current document is still being analyzed.");
      return;
    }
    if (!file) {
      notify("Choose a document to generate the report.");
      return;
    }

    const submittedFile = file;
    generationLockRef.current = true;
    setIsGeneratingReport(true);
    navigate("reports");
    setProgress(4);
    setProcessingLabel("Reading document content");
    const minimumProcessingMs = 8_000 + Math.floor(Math.random() * 7_001);
    const animationStartedAt = Date.now();
    const progressTimer = window.setInterval(() => {
      const elapsed = Date.now() - animationStartedAt;
      setProgress(Math.min(95, 4 + Math.round((elapsed / minimumProcessingMs) * 91)));
    }, 250);

    let text = "";
    try {
      text = normalizeExtractedText(await extractFileText(submittedFile, (_value, label) => {
        setProcessingLabel(label);
      }));
    } catch {
      navigate("dashboard");
      notify("I could not read that document. Try another file.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    if (text.length < 80) {
      navigate("dashboard");
      notify("Add at least 80 characters to create a useful report.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    // "start the two fixes now" TASK 1: extract -> archive analysis +
    // academic search + Wikipedia -> wait for the required checks ->
    // dedupe -> compute unified similarity -> save the FINAL report -> show
    // it. Wikipedia and academic search are kicked off here (both only need
    // `text`) and AWAITED below, alongside archive analysis, before the
    // report is ever shown or saved — no more silent later re-save that
    // changes the similarity score after the user has already seen it.
    // Both stay best-effort (a Wikipedia/provider failure never aborts the
    // report, matching this subsystem's existing non-fatal discipline) but
    // "best-effort" no longer means "invisible": analyzeAcademicEvidence
    // resolves to an explicit COMPLETE_WITH_MATCHES/COMPLETE_NO_MATCHES/
    // FAILED status (TASK 2) that rides along with the report instead of
    // being silently swallowed.
    const wikipediaPromise = analyzeWikipediaText(
      text,
      submittedFile.name,
      () => undefined,
    ).catch((error) => {
      console.debug("Wikipedia check failed.", {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    const academicEvidencePromise = analyzeAcademicEvidence(text);

    let report: SimilarityReport;
    try {
      report = await analyzeText(text, submittedFile.name, submittedFile.size, (_value, label) => {
        setProcessingLabel(label);
      });
    } catch {
      navigate("dashboard");
      notify("The private document corpus could not be loaded. Please try again.");
      window.clearInterval(progressTimer);
      generationLockRef.current = false;
      setIsGeneratingReport(false);
      return;
    }

    // "start the two fixes now" TASK 4: the AI-writing model (fp16, ~286MB —
    // see lib/ai-core.ts's AI_MODEL_DTYPE) is kicked off now (it needs
    // report.features.detectedLanguage, only known once archive analysis
    // above resolves) but deliberately NOT awaited here — similarity
    // generation and academic verification stay independent of it, so a
    // cold model download can never delay the similarity report below. A
    // local (not component-ref) prep-stage variable is used for the error
    // label so a second, overlapping report generation can never corrupt
    // this one's — see aiPrepStageRef's own remaining use for why a shared
    // ref was no longer safe once this became a longer-lived background op.
    let aiPrepStage: AiPrepStage | null = "preparing";
    aiPrepStageRef.current = "preparing";
    const aiAnalysisPromise = analyzeAiText(text, report.features.detectedLanguage, (update) => {
      aiPrepStage = update.stage;
      aiPrepStageRef.current = update.stage;
    }).then((aiAnalysis) => ({ aiScore: aiAnalysis.score, aiAnalysis }))
      .catch((error) => ({
        aiScore: null,
        aiAnalysis: {
          status: "error" as const,
          score: null,
          model: AI_MODEL_VERSION,
          engine: null,
          threshold: AI_PASSAGE_THRESHOLD,
          thresholdLogOdds: AI_PASSAGE_LOG_ODDS_THRESHOLD,
          eligibleWordCount: 0,
          analyzedWordCount: 0,
          passages: [],
          error: describeAiAnalysisError(error, aiPrepStage),
        },
      }));

    setProcessingLabel("Checking external academic sources");
    const [webCheck, academicResult] = await Promise.all([wikipediaPromise, academicEvidencePromise]);
    if (webCheck) {
      console.debug("Wikipedia check completed.", {
        reportId: report.id,
        status: webCheck.status,
        outcomes: webCheck.outcomes,
        phrasesMatched: webCheck.phrasesMatched,
      });
      report = enrichReportWithWikipedia(report, webCheck);
    }
    console.debug("Academic evidence check completed.", {
      reportId: report.id,
      status: academicResult.status,
      sourceCount: academicResult.evidence.length,
    });
    report = enrichReportWithAcademicEvidence(report, academicResult);
    // TASK 1: computed once the required checks above have both resolved —
    // this is the FINAL unified similarity result, not a provisional one to
    // be silently revised by a later save.
    report = attachUnifiedSimilarity(report);

    setCurrentReport(report);
    const remainingAnimationMs = Math.max(0, minimumProcessingMs - (Date.now() - animationStartedAt));
    if (remainingAnimationMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, remainingAnimationMs));
    }
    window.clearInterval(progressTimer);
    setProgress(100);
    setProcessingLabel("Saving your report");
    try {
      const saveResult = await saveReport(report, academicResult.academicSearchDiagnosticsId);
      navigate("reports");
      // A network/DB hiccup here is silently tolerated since the local copy
      // already succeeded (see saveReport/saveReportRemote's own comments) —
      // there is no quota or room concept on this anonymous-only path.
      notify(
        !saveResult.ok
          ? "Your report is ready. It's saved on this device; syncing to the server will retry automatically."
          : academicResult.status === "FAILED"
            ? "Your report is ready. External academic verification was unavailable this time."
            : "Your report is ready. Choose AI or TurnitPlus Similarity.",
      );

      // TASK 4: the AI-writing score merges into the ALREADY-shown,
      // ALREADY-saved report whenever it finishes — a separate axis
      // (mode: "ai"), never touching score/archiveScore/unifiedSimilarity/
      // academicEvidenceStatus, and never gating the similarity report
      // above. Deliberately not awaited (mirrors the previous background-
      // enrichment pattern) so the generation lock releases as soon as the
      // similarity report is final, letting the user start a new check
      // immediately instead of waiting on a still-downloading AI model.
      // Release-hardening audit finding LIFECYCLE-01: this used to call
      // storeReport/saveReportRemote directly with no .catch() anywhere in
      // the chain, so an IndexedDB rejection here became an unhandled
      // promise rejection — see lib/report-ai-completion.ts's own header
      // comment (this is the anonymous-flow twin of room-page-shell.tsx's
      // saveEnrichedAiResult bug). This flow has no room/aiStatus concept
      // to strand, but the same "no unhandled rejection" guarantee applies
      // here too.
      void aiAnalysisPromise
        .then(async (aiResult) => {
          const enriched = { ...report, ...aiResult };
          const enrichedSummary = buildReportSummary(enriched);
          setCurrentReport((current) => current?.id === enriched.id ? { ...current, ...aiResult } : current);
          setReports((current) => current.map((item) => item.id === enrichedSummary.id ? enrichedSummary : item));
          await persistAiCompletion(enriched, enrichedSummary);
        })
        .catch((error) => {
          console.error("Unexpected failure finishing AI analysis (non-fatal):", error instanceof Error ? error.message : String(error));
        });
    } finally {
      generationLockRef.current = false;
      setIsGeneratingReport(false);
    }
  }

  function startNewCheck() {
    if (generationLockRef.current) {
      navigate("reports");
      notify("Please wait for the current report to finish before starting another check.");
      return;
    }
    setFile(null);
    setProgress(0);
    setCurrentReport(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    navigate("dashboard");
  }

  /**
   * Room/slot architecture: every "start a new check" entry point shared
   * between anonymous and signed-in visitors (nav Dashboard button, Home
   * hero/bottom CTAs) must route an authenticated account into My Reports
   * instead of the standalone Dashboard — that page has no room context,
   * and a new check always belongs to a specific room now (see
   * app/api/reports/route.ts, which rejects an authenticated first-save
   * with no room). Pure navigation only, exactly like the plain
   * navigate("dashboard") this replaces — anonymous visitors see no
   * behavior change at all.
   */
  function goToNewCheck() {
    navigate(account ? "reports" : "dashboard");
  }

  async function clearHistory() {
    // Authenticated accounts: the visible state here is only ever the room
    // directory's own lightweight index, never the account's full history —
    // so a full wipe needs its own explicit, full enumeration across every
    // room. This is the one deliberate exception to "never fetch across all
    // rooms at once": clearing history is a rare, explicit, destructive
    // action, not the browsing behavior this feature's lazy-loading
    // requirement is about. Still lightweight summaries, never full report
    // bodies.
    const idsToDelete = account
      ? (await fetchAllReportSummariesAcrossRooms()).map((report) => report.id)
      : reports.map((report) => report.id);
    setReports([]);
    setAccountReportCount(0);
    if (account) {
      clearAllReportRoomCaches(account.email);
      setRoomsBrowserKey((key) => key + 1);
    }
    await clearStoredReports();
    await Promise.all(idsToDelete.map((id) => deleteRemoteReport(id)));
    notify("Report history cleared.");
  }

  // "home" is deliberately excluded here: that view has its own nav button
  // ("Overview", highlighted via a direct view === "home" check below) — folding
  // it into "dashboard" too meant both "Overview" and "Dashboard" lit up
  // simultaneously while viewing the Overview page.
  const activeNavView = view === "processing" || view === "welcome" ? "dashboard" : view;

  return (
    <div className={`site-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark">T+</div>
          <div>
            <strong>TurnitPlus</strong>
            <span>AI & similarity detection</span>
          </div>
        </div>

        <button
          className="sidebar-collapse"
          type="button"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </button>

        <button
          className="mobile-menu"
          type="button"
          aria-label="Toggle navigation"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          {mobileNavOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>

        <nav aria-label="Main navigation">
          <div className={`account-nav ${account ? "has-account" : ""} ${!accountLoaded ? "account-pending" : ""} ${activeNavView === "account" ? "current" : ""}`}>
            <button
              className="account-trigger"
              type="button"
              onClick={() => openAccountPage()}
              aria-busy={!accountLoaded}
            >
              <span className={`account-avatar ${account ? "signed-in" : ""}`}>
                {!accountLoaded ? null : account ? account.username.slice(0, 1).toUpperCase() : <UserRound aria-hidden="true" />}
              </span>
              <span className="account-copy">
                <strong>{!accountLoaded ? "Account" : (account?.username ?? "Account")}</strong>
                {/* Unresolved auth is its own state, never the signed-out
                    copy — the session check hasn't answered yet, so "Log in
                    or create account" would be an outright wrong claim for
                    an already-authenticated user for as long as it's showing. */}
                <span>{!accountLoaded ? "Checking session…" : (account ? "Signed in" : "Log in or create account")}</span>
              </span>
              <ChevronRight className="account-nav-chevron" aria-hidden="true" />
            </button>
          </div>
          <button
            className={view === "home" ? "active" : ""}
            type="button"
            onClick={() => navigate("home")}
          >
            <ShieldCheck aria-hidden="true" />
            <span className="nav-label">Overview</span>
          </button>
          {/* Signed-in accounts have no distinct Dashboard destination left
              to go to — a new check only ever starts inside a room (see
              goToNewCheck's own comment), so for them this button would
              route to exactly the page "My reports" already does, doing
              nothing visible whenever that's already the current view.
              Anonymous visitors are unaffected: the standalone Dashboard is
              still their entire upload flow. */}
          {!account && (
            <button
              className={activeNavView === "dashboard" ? "active" : ""}
              type="button"
              disabled={isGeneratingReport}
              aria-label={isGeneratingReport ? "Dashboard unavailable while a report is processing" : "Dashboard"}
              onClick={goToNewCheck}
            >
              <LayoutDashboard aria-hidden="true" />
              <span className="nav-label">Dashboard</span>
            </button>
          )}
            <button
              className={activeNavView === "reports" ? "active" : ""}
              type="button"
              onClick={() => navigate("reports")}
            >
              <FolderClock aria-hidden="true" />
              <span className="nav-label">My reports</span>
              {(account ? accountReportCount : reports.length) > 0 && (
                <span className="nav-count">{account ? accountReportCount : reports.length}</span>
              )}
            </button>
            <button
              className={activeNavView === "about" ? "active" : ""}
              type="button"
              onClick={() => navigate("about")}
            >
              <CircleHelp aria-hidden="true" />
              <span className="nav-label">How it works</span>
            </button>
        </nav>

        <div className="sidebar-trust">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Private by design</strong>
            <span>Processing stays in your browser.</span>
          </div>
        </div>
      </aside>

      <main key={view} className="page-stage">
        {view !== "processing" && (
          <header className="topbar">
            <div>
              <p className="eyebrow">{view === "legal" ? "TRUST CENTER" : view === "account" && accountLoaded && !account ? "OPTIONAL ACCOUNT" : "AI & SIMILARITY CHECKER"}</p>
              <h1>
                {view === "home" && "Overview"}
                {view === "dashboard" && "Check AI writing and similarity"}
                {view === "reports" && "Your recent reports"}
                {view === "about" && "How the checker works"}
                {view === "account" && (!accountLoaded || account ? "Your account" : "Log in or create your account")}
                {view === "welcome" && "Welcome to TurnitPlus"}
                {view === "legal" && "Privacy, retention and terms"}
              </h1>
            </div>
            <div className="topbar-actions">
              {accountLoaded && !account && view !== "account" && (
                <button className="register-button" type="button" onClick={() => openAccountPage("signup")}>
                  <UserPlus aria-hidden="true" />
                  Register
                </button>
              )}
              <div className="ready-pill"><span /> Ready</div>
            </div>
          </header>
        )}

        {view === "home" && (
          <section className="landing-page" aria-labelledby="landing-title">
            <div className="landing-hero">
              <div className="landing-hero-copy">
                <span className="landing-badge"><ShieldCheck aria-hidden="true" /> Private by design</span>
                <h2 id="landing-title">Understand what is in your document—without sending the document away.</h2>
                <p className="landing-lede">TurnitPlus checks AI-writing signals and similarity in your browser — searching millions of scholarly records across major academic indexes — then gives you the passages and sources behind the result.</p>
                <div className="landing-actions">
                  <button className="button primary landing-cta" type="button" onClick={goToNewCheck}><UploadCloud aria-hidden="true" /> Check a document free</button>
                  <button className="button secondary" type="button" onClick={() => navigate("about")}><BookOpen aria-hidden="true" /> See how it works</button>
                </div>
                <div className="landing-proof">
                  <span><Check aria-hidden="true" /> No cloud upload</span>
                  <span><Check aria-hidden="true" /> PDF, DOCX, TXT & more</span>
                  <span><Check aria-hidden="true" /> Reports stay on this device</span>
                </div>
              </div>
              <div className="landing-product-card surface-card">
                <div className="landing-product-top">
                  <div><span className="section-label">SAMPLE REPORT</span><strong>Evidence, not just a score</strong></div>
                  <span className="landing-live-dot"><i /> Ready</span>
                </div>
                <div className="landing-score-grid">
                  <div><span>AI-writing signal</span><strong>Review</strong><small>Passages highlighted for inspection</small></div>
                  <div><span>Similarity</span><strong>19%</strong><small>Matched phrases linked to sources</small></div>
                </div>
                <div className="landing-match-preview">
                  <div className="landing-line wide" /><div className="landing-line" /><div className="landing-line match" /><div className="landing-line wide" /><div className="landing-line match short" />
                </div>
                <div className="landing-source-row"><span><FileCheck2 aria-hidden="true" /> Evidence attached</span><span>Verified academic sources</span></div>
              </div>
            </div>

            <div className="landing-section-heading">
              <p className="section-label">BUILT FOR REVIEW</p>
              <h2>Three things TurnitPlus does well</h2>
              <p>Keep the result useful, inspectable and honest about what the system can actually prove.</p>
            </div>
            <div className="landing-feature-grid">
              <article className="surface-card landing-feature-card"><span className="landing-feature-icon"><Search aria-hidden="true" /></span><h3>Find meaningful overlap</h3><p>Measure overlapping text and show the exact passages that matched.</p></article>
              <article className="surface-card landing-feature-card"><span className="landing-feature-icon"><GraduationCap aria-hidden="true" /></span><h3>Review AI-writing signals</h3><p>Surface calibrated signals and highlighted passages instead of pretending a score is proof of authorship.</p></article>
              <article className="surface-card landing-feature-card"><span className="landing-feature-icon"><ShieldCheck aria-hidden="true" /></span><h3>Keep documents local</h3><p>Extraction and analysis happen in your browser. You stay in control of locally stored reports.</p></article>
            </div>

            <div className="landing-how surface-card">
              <div><p className="section-label">HOW IT WORKS</p><h2>From document to evidence in three steps.</h2><p>There is no complicated setup. Choose a file, let the browser analyze it, then inspect the report.</p></div>
              <div className="landing-step-list">
                <div><span>01</span><strong>Choose a document</strong><p>Upload a supported file up to 10 MB.</p></div>
                <div><span>02</span><strong>Analyze privately</strong><p>Workers extract, compare and score the text locally.</p></div>
                <div><span>03</span><strong>Inspect the evidence</strong><p>Review scores, passages, sources and a downloadable report.</p></div>
              </div>
            </div>

            <div className="landing-bottom-cta">
              <div><p className="section-label">READY WHEN YOU ARE</p><h2>Start with one document.</h2><p>No account is required for the local checking workflow.</p></div>
              <button className="button primary" type="button" onClick={goToNewCheck}><UploadCloud aria-hidden="true" /> Check a document</button>
            </div>
          </section>
        )}

        {view === "dashboard" && (
          <section className="dashboard-grid">
            <section className="upload-card surface-card">
              <div className="card-heading">
                <div>
                  <p className="section-label">NEW CHECK</p>
                  <h2>Upload your document</h2>
                  <span>PDF, DOCX, TXT, MD, HTML, or CSV · up to 10 MB</span>
                </div>
                <span className="free-badge">FREE</span>
              </div>

              <DocumentUploadPanel
                file={file}
                isGeneratingReport={isGeneratingReport}
                progress={progress}
                processingLabel={processingLabel}
                fileInputRef={fileInputRef}
                onChooseFile={chooseFile}
                onGenerate={generateReport}
              />
            </section>

            <section className="dashboard-aside">
              <article className="surface-card report-preview-card">
                <p className="section-label">TWO REPORTS · ONE CHECK</p>
                <h2>AI detection and similarity with clear evidence</h2>
                <p>TurnitPlus checks AI-writing signals and measures similarity — searching millions of scholarly records across major academic indexes — then shows the passages behind each result.</p>
                <div className="mini-report">
                  <div>
                    <span>Similarity result</span>
                    <strong>19%</strong>
                    <small>Verified academic sources</small>
                  </div>
                  <div className="mini-lines">
                    <i /><i /><i />
                  </div>
                </div>
                <ul className="feature-checks">
                  <li><Check aria-hidden="true" /> AI-written content detection</li>
                  <li><Check aria-hidden="true" /> Source similarity detection</li>
                  <li><Check aria-hidden="true" /> Matched phrases highlighted in red</li>
                  <li><Check aria-hidden="true" /> Downloadable full reports and receipt</li>
                </ul>
              </article>

              <article className="surface-card privacy-card">
                <ShieldCheck aria-hidden="true" />
                <div>
                  <strong>Private by design</strong>
                  <p>No account is required to check a document. Reports stay on this device.</p>
                </div>
              </article>
            </section>
          </section>
        )}

        {view === "account" && (
          <section className="account-page">
            {!accountLoaded ? (
              // Reachable directly (the sidebar trigger isn't disabled while
              // pending) — must never show the login/signup form here before
              // knowing whether there's already a session, for the same
              // reason the sidebar/reports list can't assume signed-out.
              <div className="account-page-grid">
                <section className="auth-page-card surface-card" aria-labelledby="account-page-title">
                  <div className="auth-dialog-brand">
                    <div className="brand-mark">T+</div>
                    <div><strong>TurnitPlus</strong><span>AI & similarity detection</span></div>
                  </div>
                  <div className="ai-analysis-loading" aria-live="polite" aria-busy="true">
                    <span aria-hidden="true" />
                    <div>
                      <strong>Checking your session</strong>
                      <p>Resolving your account status…</p>
                    </div>
                  </div>
                </section>
              </div>
            ) : account ? (
              <div className="account-profile-layout">
                <div className="account-profile-card surface-card">
                  <div className="account-profile-hero">
                    <span className="account-profile-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
                    <div className="account-profile-details">
                      <p className="section-label">SIGNED IN</p>
                      <h2>{account.username}</h2>
                      <p>{account.email}</p>
                      <EmailVerificationStatus
                        status={emailVerification?.status ?? null}
                        onVerify={sendEmailVerification}
                        sending={emailVerifySending}
                        notice={emailVerifyNotice}
                      />
                    </div>
                    <button className="button secondary account-edit-button" type="button" onClick={() => setIsEditingProfile((editing) => !editing)}>
                      <Pencil aria-hidden="true" /> {isEditingProfile ? "Close editor" : "Edit information"}
                    </button>
                  </div>
                  {isEditingProfile && (
                    <form className="account-edit-form" onSubmit={submitProfileEdit}>
                      <div className="account-edit-heading">
                        <div>
                          <strong>Edit account information</strong>
                          <span>Update how your name and email appear in TurnitPlus.</span>
                        </div>
                      </div>
                      <div className="account-edit-fields">
                        <label>
                          <span>Display name</span>
                          <input name="profileUsername" type="text" defaultValue={account.username} minLength={2} maxLength={32} autoComplete="name" required />
                        </label>
                        <label>
                          <span>Email address</span>
                          <input name="profileEmail" type="email" defaultValue={account.email} autoComplete="email" required />
                        </label>
                      </div>
                      <label className="account-consent-toggle">
                        <input name="corpusReuseConsent" type="checkbox" defaultChecked={account.corpusReuseConsent} />
                        <span>
                          <strong>Check my uploads against other TurnitPlus users&apos; submissions</strong>
                          <small>Off by default. When on, future uploads you save may be compared against documents other signed-in users have submitted, and vice versa, to flag prior submissions. Your document text is never shown to another account &mdash; only that a prior submission exists. Turning this off stops future uploads from being added; it does not remove documents already indexed while it was on (delete the report to remove those).</small>
                        </span>
                      </label>
                      {profileEditError && <p className="auth-form-error" role="alert">{profileEditError}</p>}
                      <div className="account-edit-actions">
                        <button className="button subtle" type="button" onClick={() => setIsEditingProfile(false)}>Cancel</button>
                        <button className="button primary" type="submit"><Save aria-hidden="true" /> Save changes</button>
                      </div>
                    </form>
                  )}
                  <div className="account-profile-status"><Check aria-hidden="true" /> Your account session is active on this device.</div>
                  <div className="account-profile-status">
                    {account.corpusReuseConsent
                      ? "Cross-account prior-submission checking is ON for your uploads."
                      : "Cross-account prior-submission checking is OFF for your uploads (default)."}
                  </div>
                  {uploadLimitStatus && uploadLimitStatus.authenticated && (
                    <div className="account-profile-status">
                      {uploadLimitStatus.unlimited
                        ? "Unlimited uploads (developer account)."
                        : `${uploadLimitStatus.uploadsToday}/${uploadLimitStatus.limit} uploads today.`}
                    </div>
                  )}
                  <div className="account-profile-actions">
                    {/* Room/slot architecture: a signed-in account's new check
                        always starts from inside a room — see
                        components/reports/report-rooms.tsx's own header
                        comment — so this routes to My Reports rather than
                        the standalone (room-less) Dashboard. */}
                    <button className="button primary" type="button" disabled={isGeneratingReport} onClick={() => navigate("reports")}>
                      <UploadCloud aria-hidden="true" /> Start a new check
                    </button>
                    <button className="button secondary" type="button" onClick={() => navigate("reports")}>
                      <FolderClock aria-hidden="true" /> View my reports
                    </button>
                    <button className="button subtle account-signout" type="button" onClick={signOutAccount}>
                      <LogOut aria-hidden="true" /> Sign out
                    </button>
                  </div>
                  <p className="auth-preview-note"><LockKeyhole aria-hidden="true" /> Documents are analyzed in your browser and never uploaded. Your report history is saved securely so you can reach it from any device you sign in on.</p>

                  <div className="account-danger-zone">
                    <div className="account-danger-zone-header">
                      <div>
                        <strong>Delete account</strong>
                        <span>Permanently delete your account and your saved reports. This cannot be undone.</span>
                      </div>
                      <button
                        className="button subtle account-delete-toggle"
                        type="button"
                        onClick={() => {
                          setIsDeletingAccount((open) => !open);
                          setDeleteAccountError(null);
                        }}
                      >
                        <Trash2 aria-hidden="true" /> {isDeletingAccount ? "Cancel" : "Delete account"}
                      </button>
                    </div>
                    {isDeletingAccount && (
                      <form className="account-delete-form" onSubmit={submitAccountDeletion}>
                        <p className="account-delete-warning">
                          <TriangleAlert aria-hidden="true" />
                          This will permanently delete your account, sign you out of every device, and remove your saved reports. This action cannot be undone.
                        </p>
                        <div className="account-edit-fields">
                          <label>
                            <span>Confirm your password</span>
                            <input name="deletePassword" type="password" autoComplete="current-password" required disabled={isSubmittingDeletion} />
                          </label>
                          <label>
                            <span>Type &ldquo;{ACCOUNT_DELETION_CONFIRMATION_PHRASE}&rdquo; to confirm</span>
                            <input name="deleteConfirm" type="text" autoComplete="off" required disabled={isSubmittingDeletion} />
                          </label>
                        </div>
                        {deleteAccountError && <p className="auth-form-error" role="alert">{deleteAccountError}</p>}
                        <div className="account-edit-actions">
                          <button
                            className="button subtle"
                            type="button"
                            disabled={isSubmittingDeletion}
                            onClick={() => {
                              setIsDeletingAccount(false);
                              setDeleteAccountError(null);
                            }}
                          >
                            Cancel
                          </button>
                          <button className="button danger" type="submit" disabled={isSubmittingDeletion}>
                            <Trash2 aria-hidden="true" /> {isSubmittingDeletion ? "Deleting account…" : "Permanently delete my account"}
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>

                <section className="subscription-preview-card surface-card" aria-labelledby="unlimited-plan-title">
                  <div className="subscription-copy">
                    <div className="subscription-heading-row">
                      <span className="subscription-icon"><CreditCard aria-hidden="true" /></span>
                      <div>
                        <p className="section-label">MEMBERSHIP</p>
                        <span className="subscription-coming-soon">COMING SOON</span>
                      </div>
                    </div>
                    <h2 id="unlimited-plan-title">TurnitPlus Unlimited</h2>
                    <p>Unlock unlimited document checks for one simple monthly price.</p>
                    <ul className="subscription-features">
                      <li><Check aria-hidden="true" /> Unlimited similarity checks</li>
                      <li><Check aria-hidden="true" /> Unlimited AI writing reports</li>
                      <li><Check aria-hidden="true" /> Full report previews and downloads</li>
                    </ul>
                  </div>
                  <div className="subscription-price-panel">
                    <span className="subscription-plan-label">MONTHLY PLAN</span>
                    <div className="subscription-price"><strong>$20</strong><span>/ month</span></div>
                    <p>Cancel anytime once billing becomes available.</p>
                    <button className="button primary full" type="button" onClick={() => notify("TurnitPlus Unlimited is coming soon. No payment was taken.")}>Notify me at launch</button>
                    <small>Plan preview only · no payment will be collected.</small>
                  </div>
                </section>
              </div>
            ) : (
              <div className="account-page-grid">
                <section className="auth-page-card surface-card" aria-labelledby="account-page-title">
                  <div className="auth-dialog-brand">
                    <div className="brand-mark">T+</div>
                    <div><strong>TurnitPlus</strong><span>AI & similarity detection</span></div>
                  </div>
                  <div className="auth-mode-tabs" aria-label="Account action">
                    <button className={(authMode ?? "login") === "login" ? "active" : ""} type="button" disabled={isAuthenticating} onClick={() => { setAuthMode("login"); setAuthError(null); }}>Log in</button>
                    <button className={(authMode ?? "login") === "signup" ? "active" : ""} type="button" disabled={isAuthenticating} onClick={() => { setAuthMode("signup"); setAuthError(null); }}>Create account</button>
                  </div>
                  <p className="section-label">{(authMode ?? "login") === "login" ? "WELCOME BACK" : "CREATE YOUR ACCOUNT"}</p>
                  <h2 id="account-page-title">{(authMode ?? "login") === "login" ? "Log in to TurnitPlus" : "Start using TurnitPlus"}</h2>
                  <p className="auth-dialog-intro">
                    {(authMode ?? "login") === "login"
                      ? "Continue to your document checks and saved reports."
                      : "Create an account to keep your report workflow in one place."}
                  </p>
                  <form className="auth-form" onSubmit={submitAuthInterface}>
                    {isAuthenticating ? (
                      <div className="auth-loading-panel" role="status" aria-live="polite" aria-label={`${authLoadingLabel}, ${authProgress}% complete`}>
                        <div className="auth-loading-visual" aria-hidden="true">
                          <span className="auth-loading-ring" />
                          <span className="auth-loading-logo">T+</span>
                        </div>
                        <div className="auth-loading-copy">
                          <strong>{(authMode ?? "login") === "login" ? "Signing you in" : "Setting up your account"}</strong>
                          <p>{authLoadingLabel}</p>
                        </div>
                        <div className="auth-loading-progress" aria-hidden="true"><span style={{ width: `${authProgress}%` }} /></div>
                        <small>{authProgress}%</small>
                      </div>
                    ) : <>
                    {authError && <p className="auth-form-error" role="alert">{authError}</p>}
                    {(authMode ?? "login") === "signup" && (
                      <label>
                        <span>Username</span>
                        <input type="text" name="username" autoComplete="username" placeholder="Choose a username" minLength={2} maxLength={32} autoFocus required />
                      </label>
                    )}
                    <label>
                      <span>Email address</span>
                      <input type="email" name="email" autoComplete="email" placeholder="you@example.com" autoFocus={(authMode ?? "login") === "login"} required />
                    </label>
                    <label>
                      <span>Password</span>
                      <input
                        type="password"
                        name="password"
                        autoComplete={(authMode ?? "login") === "login" ? "current-password" : "new-password"}
                        placeholder="Enter your password"
                        minLength={8}
                        required
                      />
                    </label>
                    {(authMode ?? "login") === "signup" && (
                      <label>
                        <span>Confirm password</span>
                        <input
                          type="password"
                          name="confirmPassword"
                          autoComplete="new-password"
                          placeholder="Repeat your password"
                          minLength={8}
                          onInput={(event) => event.currentTarget.setCustomValidity("")}
                          required
                        />
                      </label>
                    )}
                    {(authMode ?? "login") === "signup" && (
                      <IdentityFields ref={signupIdentityRef} mode="signup" disabled={isAuthenticating} />
                    )}
                    {(authMode ?? "login") === "login" && (
                      <div className="auth-form-row">
                        <label className="auth-checkbox"><input type="checkbox" name="remember" /><span>Remember me</span></label>
                        <button type="button" onClick={() => notify("Password recovery will be added with the account service.")}>Forgot password?</button>
                      </div>
                    )}
                    <button className="button primary full auth-submit" type="submit">
                      {(authMode ?? "login") === "login" ? <><LogIn aria-hidden="true" /> Log in</> : <><UserPlus aria-hidden="true" /> Create account</>}
                    </button>
                    </>}
                  </form>
                  <p className="auth-switch">
                    {(authMode ?? "login") === "login" ? "New to TurnitPlus?" : "Already have an account?"}
                    <button type="button" disabled={isAuthenticating} onClick={() => { setAuthMode((authMode ?? "login") === "login" ? "signup" : "login"); setAuthError(null); }}>
                      {(authMode ?? "login") === "login" ? "Create account" : "Log in"}
                    </button>
                  </p>
                  <p className="auth-preview-note"><LockKeyhole aria-hidden="true" /> Your password is never stored — only a one-way cryptographic hash used to verify future sign-ins.</p>
                </section>

                <aside className="account-benefits surface-card">
                  <p className="section-label">YOUR PRIVATE WORKSPACE</p>
                  <h2>Everything stays organized</h2>
                  <div className="account-benefit-list">
                    <article><FolderClock aria-hidden="true" /><div><strong>Report history</strong><p>Return to your recent AI and similarity reports.</p></div></article>
                    <article><ShieldCheck aria-hidden="true" /><div><strong>Private processing</strong><p>Documents continue to be analyzed inside your browser.</p></div></article>
                    <article><FileCheck2 aria-hidden="true" /><div><strong>Clear evidence</strong><p>Open either report from its own dedicated screen.</p></div></article>
                  </div>
                </aside>
              </div>
            )}
          </section>
        )}

        {view === "welcome" && account && (
          <section className="welcome-page-card surface-card" aria-labelledby="welcome-page-title">
            <div className="welcome-identity">
              <span className="welcome-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
              <span className="welcome-check"><Check aria-hidden="true" /></span>
            </div>
            <p className="section-label">{welcomeMode === "signup" ? "ACCOUNT CREATED" : "WELCOME BACK"}</p>
            <h2 id="welcome-page-title">
              {welcomeMode === "signup" ? `You’re ready, ${account.username}` : `Good to see you, ${account.username}`}
            </h2>
            <p className="welcome-intro">Your private review workspace is ready. Here’s the quickest way to get useful evidence from a document.</p>
            <div className="welcome-steps" aria-label="How TurnitPlus works">
              <article><span>1</span><div className="welcome-step-icon"><UploadCloud aria-hidden="true" /></div><div><strong>Upload privately</strong><p>Choose a document. Processing stays inside this browser.</p></div></article>
              <article><span>2</span><div className="welcome-step-icon"><Search aria-hidden="true" /></div><div><strong>Review the evidence</strong><p>See the archive percentage and the exact passages behind it.</p></div></article>
              <article><span>3</span><div className="welcome-step-icon"><FolderClock aria-hidden="true" /></div><div><strong>Return anytime</strong><p>Your report history stays available on this device.</p></div></article>
            </div>
            <div className="welcome-actions">
              <button className="button primary" type="button" disabled={isGeneratingReport} onClick={() => navigate("reports")}><UploadCloud aria-hidden="true" /> Start a new check</button>
              <button className="button secondary" type="button" onClick={() => navigate("reports")}><FolderClock aria-hidden="true" /> View my reports</button>
            </div>
            <p className="welcome-privacy"><LockKeyhole aria-hidden="true" /> No document is uploaded to an account or cloud workspace.</p>
          </section>
        )}

        {view === "welcome" && !account && accountLoaded && (
          <section className="welcome-missing surface-card">
            <UserRound aria-hidden="true" />
            <h2>Log in to continue</h2>
            <p>Your welcome page belongs to an active account session.</p>
            <button className="button primary" type="button" onClick={() => openAccountPage("login")}><LogIn aria-hidden="true" /> Go to login</button>
          </section>
        )}

        {view === "processing" && (
          <section className="processing-screen">
            <div className="processing-card surface-card">
              <div className="scanner-document">
                <span className="scanner-line" />
                <FileText aria-hidden="true" />
              </div>
              <p className="section-label">DOCUMENT ANALYSIS</p>
              <h1>Building your archive-overlap report</h1>
              <p>{processingLabel}…</p>
              <div className="progress-track" aria-label={`${progress}% complete`}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <strong>{progress}%</strong>
            </div>
          </section>
        )}

        {view === "reports" && (
          <section className="reports-card surface-card">
            <div className="card-heading">
              <div>
                <p className="section-label">{account ? "YOUR ACCOUNT" : "ON THIS DEVICE"}</p>
                <h2>Recent reports</h2>
                <span>Open earlier checks or download their processing receipts.</span>
              </div>
              <div className="report-header-actions">
                {/* Room/slot architecture: "New check" is deliberately gone
                    from this page for a signed-in account — a new check
                    only ever starts inside an empty room (see
                    components/reports/report-rooms.tsx). Anonymous/local
                    history is unaffected — it has no room concept, so its
                    "New check" action (and the processing lock it shows
                    while a check runs) stays exactly as it was. */}
                {!account && (isGeneratingReport ? (
                  <div className="report-job-lock" role="status">
                    <LockKeyhole aria-hidden="true" />
                    <span><strong>Current report running</strong><small>{progress}% complete · one document at a time</small></span>
                  </div>
                ) : (
                  <button className="button primary" type="button" onClick={startNewCheck}>
                    <UploadCloud aria-hidden="true" /> New check
                  </button>
                ))}
                {!isGeneratingReport && (account ? accountReportCount : reports.length) > 0 && (
                  <button className="button subtle" type="button" onClick={clearHistory}>Clear history</button>
                )}
              </div>
            </div>

            {/* Anonymous/local history only — an authenticated account's
                new-check flow (and its own processing state) lives entirely
                on its room's own dedicated page, never here. */}
            {!account && isGeneratingReport && file && (
              <article className="history-processing" aria-live="polite">
                <div className="history-file-icon"><FileText aria-hidden="true" /></div>
                <div className="history-copy">
                  <strong>{file.name}</strong>
                  <p>{processingLabel}…</p>
                  <div className="history-progress" aria-label={`${progress}% complete`}>
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <div className="history-processing-value">
                  <strong>{progress}%</strong>
                  <span>Processing</span>
                </div>
              </article>
            )}

            {/* Room directory (see components/reports/report-rooms.tsx): an
                authenticated account's list is owned entirely by
                ReportRoomsBrowser, which fetches only the lightweight room
                index — status per room, never report content. Clicking a
                room navigates to its own dedicated page
                (app/reports/rooms/[room]), which fetches and owns that one
                room's data (and the upload flow, for an empty room) —
                nothing about a report, or the upload panel, is ever
                rendered here. The anonymous, device-scoped flat list below
                is unchanged in spirit from before rooms existed. */}
            {account ? (
              <ReportRoomsBrowser
                key={roomsBrowserKey}
                accountEmail={account.email}
                onTotalCountChange={setAccountReportCount}
              />
            ) : !accountLoaded ? (
              // reports.length === 0 is also true before the device report
              // list has loaded — without this branch, a device with
              // existing reports would see "No reports yet" flash before
              // its real list arrives.
              <div className="empty-reports" aria-live="polite" aria-busy="true">
                <FolderClock aria-hidden="true" />
                <h3>Loading your reports…</h3>
                <p>Checking this device for saved reports.</p>
              </div>
            ) : reports.length === 0 && !isGeneratingReport ? (
              <div className="empty-reports">
                <FolderClock aria-hidden="true" />
                <h3>No reports yet</h3>
                <p>Your reports will appear here after you check a document.</p>
                <button className="button primary" type="button" onClick={() => navigate("dashboard")}>Create a report</button>
              </div>
            ) : (
              <div className="report-history">
                {reports.map((report) => (
                  <ReportHistoryRow key={report.id} report={report} onDownloadReceipt={downloadReceipt} />
                ))}
              </div>
            )}
          </section>
        )}

        {view === "about" && (
          <section className="about-card surface-card">
            <p className="section-label">ONE CHECK · TWO CLEAR REPORTS</p>
            <h2>A stronger way to review every document</h2>
            <p className="about-intro">
              TurnitPlus detects AI-written content and source similarity while keeping the evidence easy to inspect.
              Upload once, open either report, and review the highlighted passages behind the result.
            </p>
            <div className="about-steps">
              <article><span>01</span><FileText aria-hidden="true" /><h3>Upload privately</h3><p>Your document is read and analyzed inside your browser.</p></article>
              <article><span>02</span><Search aria-hidden="true" /><h3>Measure</h3><p>Generate an AI-writing report and measure overlap against verified sources.</p></article>
              <article><span>03</span><FileCheck2 aria-hidden="true" /><h3>Review the evidence</h3><p>Open highlighted passages, sources and downloadable reports.</p></article>
            </div>
            <section className="methodology-boundary">
              <div>
                <p className="section-label">PUBLISHED CLAIM BOUNDARY</p>
                <h3>Evidence-based results, not a forecast of any other product&apos;s score</h3>
                <p>TurnitPlus reports only the text it can show you direct evidence for — identified overlapping passages and named, verifiable sources — rather than estimating what any other similarity-detection product might report.</p>
                <a href="/data/similarity-boundary-evaluation.json" download>
                  <Download aria-hidden="true" /> Download the evaluation summary
                </a>
              </div>
            </section>
          </section>
        )}

        {view === "legal" && (
          <section className="legal-center">
            <header className="legal-hero surface-card">
              <div>
                <p className="section-label">TURNITPLUS TRUST CENTER</p>
                <h2>Private analysis. Clear controls.</h2>
                <p>TurnitPlus provides AI-writing and similarity detection with evidence you can review. This page explains what information is used, where it stays, when it is removed and the rules for using the service.</p>
              </div>
              <div className="legal-effective-date"><ShieldCheck aria-hidden="true" /><span><strong>Effective 8 August 2026</strong><small>Current product policy</small></span></div>
            </header>

            <nav className="legal-tabs" aria-label="Privacy and terms">
              <button className={legalTab === "privacy" ? "active" : ""} type="button" onClick={() => setLegalTab("privacy")}>Privacy & retention</button>
              <button className={legalTab === "terms" ? "active" : ""} type="button" onClick={() => setLegalTab("terms")}>Terms of use</button>
            </nav>

            {legalTab === "privacy" ? (
              <div className="legal-document surface-card">
                <section>
                  <span className="legal-section-number">01</span>
                  <div><h3>What TurnitPlus processes</h3><p>When you choose a document, TurnitPlus reads its text to create AI-writing and similarity reports. The original file is used during the active check. The saved report may include the extracted text, highlighted passages, scores, sources, file name and document statistics.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">02</span>
                  <div><h3>Local processing and external requests</h3><p>Document extraction, AI analysis and archive comparison run in your browser; the original file itself is never uploaded during the check. Once a check finishes, the completed report is saved both on this device (IndexedDB) and to TurnitPlus's database, so it can still be retrieved if this device's local storage is cleared or evicted. As part of generating a report, up to 20 selected phrases may be sent to the English Wikipedia search service. Wikipedia receives those phrase queries—not the full document—and handles them under its own privacy practices. Ordinary network metadata may also be processed by the hosting infrastructure to deliver the site.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">03</span>
                  <div><h3>Account information</h3><p>Creating an account stores your email address, a display name and a securely hashed password on TurnitPlus's servers. Your password itself is never stored — only a one-way cryptographic hash used to verify future sign-ins. Signing in issues a session, held in a browser cookie, that keeps you signed in until you sign out or it expires. Signing out ends that session immediately. Using TurnitPlus without an account keeps your report history device-local, as described in the next section.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">04</span>
                  <div><h3>Report identification (no account required)</h3><p>Saving and retrieving reports does not require creating an account or signing in. Each browser is assigned a random identifier, stored locally, that TurnitPlus uses only to show you your own previously saved reports. This identifier is not a username or password and is not authentication — it behaves like an unlisted link: anyone who obtained the identifier or a specific report's address could retrieve that data. A future update may introduce real sign-in to replace it.</p></div>
                </section>

                <section className="legal-retention-section">
                  <span className="legal-section-number">05</span>
                  <div>
                    <h3>Retention rules</h3>
                    <p>Reports are kept both on your device and in TurnitPlus's database until you remove them. TurnitPlus does not apply a separate hidden retention period beyond what the table below describes.</p>
                    <div className="retention-table" role="table" aria-label="TurnitPlus retention rules">
                      <div className="retention-row retention-heading" role="row"><strong role="columnheader">Information</strong><strong role="columnheader">Where it stays</strong><strong role="columnheader">When it is removed</strong></div>
                      <div className="retention-row" role="row"><span role="cell">Original uploaded file</span><span role="cell">Browser memory during the check</span><span role="cell">When replaced, the page closes or the session ends</span></div>
                      <div className="retention-row" role="row"><span role="cell">Extracted text and reports</span><span role="cell">IndexedDB on this device, and TurnitPlus's database (linked to this browser's random identifier, not your identity)</span><span role="cell">Clear history removes both copies. Clearing this site's browser data alone removes only the local copy and this browser's identifier — the saved copy remains until removed with Clear history</span></div>
                      <div className="retention-row" role="row"><span role="cell">Random report identifier</span><span role="cell">Local browser storage</span><span role="cell">When you clear this site's browser data (after this, reports saved from this browser can no longer be retrieved or deleted through the interface)</span></div>
                      <div className="retention-row" role="row"><span role="cell">Display name and email</span><span role="cell">TurnitPlus's account database</span><span role="cell">For as long as your account exists — self-service account deletion is not yet available</span></div>
                      <div className="retention-row" role="row"><span role="cell">Password</span><span role="cell">A salted, irreversible hash is stored; the password itself is never stored or logged</span><span role="cell">For as long as your account exists</span></div>
                      <div className="retention-row" role="row"><span role="cell">Session (sign-in cookie)</span><span role="cell">An httpOnly cookie on this browser, matched to a session record in TurnitPlus's database</span><span role="cell">When you sign out, or automatically after 30 days</span></div>
                      <div className="retention-row" role="row"><span role="cell">Sidebar preference</span><span role="cell">Local browser storage</span><span role="cell">When you clear this site's browser data</span></div>
                      <div className="retention-row" role="row"><span role="cell">Wikipedia phrase results</span><span role="cell">Saved locally and remotely with the report</span><span role="cell">When you clear report history or browser site data</span></div>
                    </div>
                  </div>
                </section>

                <section>
                  <span className="legal-section-number">06</span>
                  <div><h3>Your controls</h3><p>Use Clear history to remove saved reports from both this browser and TurnitPlus's database. Use Sign out to end your active session on this device. You can also use your browser's site-data controls to remove all local TurnitPlus storage at once, though this does not reach reports already saved remotely — use Clear history first if you want both removed. The interface displays up to 50 recent reports.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">07</span>
                  <div><h3>Tracking, sale and training use</h3><p>TurnitPlus does not sell document content or account information. The product does not use advertising trackers. Documents checked in the browser are not added to a TurnitPlus training database.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">08</span>
                  <div><h3>Product stage and contact</h3><p>TurnitPlus is currently an independent university project. Paid subscriptions, server accounts and email verification are not active. A dedicated privacy contact and legal operator details will be published before public commercial billing begins.</p></div>
                </section>
              </div>
            ) : (
              <div className="legal-document surface-card">
                <section>
                  <span className="legal-section-number">01</span>
                  <div><h3>The service</h3><p>TurnitPlus provides automated AI-writing detection, similarity measurement against identified overlapping passages and, when available, live academic sources and your own prior submissions, highlighted passage evidence, source information, downloadable reports and device-local report history. This similarity result is based on identified overlapping passages and verified academic sources, and is not an estimate of any other provider&apos;s result.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">02</span>
                  <div><h3>Your responsibility</h3><p>You must have permission to process every document you upload. You are responsible for protecting confidential material, reviewing the evidence, checking citations and complying with your institution’s rules.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">03</span>
                  <div><h3>Responsible decisions</h3><p>Automated results should not be the sole basis for academic discipline, grading, employment or another decision with serious consequences. Human review of the highlighted text, sources and context is required.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">04</span>
                  <div><h3>Acceptable use</h3><p>Do not use TurnitPlus to violate privacy, copyright, access controls or applicable law; upload malicious files; interfere with the service; misrepresent a report; or use the product to harass or falsely accuse another person.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">05</span>
                  <div><h3>Reports and availability</h3><p>Results depend on the submitted text, supported file extraction, available comparison sources and successful browser processing. The service may change, pause or become unavailable. Keep copies of any report you need; local browser history can be deleted by you or your browser.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">06</span>
                  <div><h3>Subscriptions</h3><p>The displayed $20 monthly Unlimited plan is a coming-soon preview. No subscription, recurring payment or unlimited entitlement begins until a real checkout explicitly presents the price and you confirm payment.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">07</span>
                  <div><h3>Ownership</h3><p>You retain your rights in documents you are authorized to use. TurnitPlus branding, interface and software remain the property of their respective owner. Third-party source titles, links and content remain subject to their own rights and terms.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">08</span>
                  <div><h3>Warranty and liability</h3><p>TurnitPlus is provided on an “as available” basis. To the extent permitted by law, no guarantee is made that every source, AI-written passage or similarity will be detected. Liability is limited to the extent allowed by applicable law, and mandatory consumer rights are not excluded.</p></div>
                </section>
                <section>
                  <span className="legal-section-number">09</span>
                  <div><h3>Changes</h3><p>These terms may be updated as accounts, subscriptions and comparison coverage evolve. The effective date at the top of this page identifies the current version.</p></div>
                </section>
              </div>
            )}
          </section>
        )}

        {view !== "processing" && (
          <footer className="site-legal-footer">
            <div><strong>TurnitPlus</strong><span>Private AI & similarity detection</span></div>
            <nav aria-label="Legal information">
              <button type="button" onClick={() => openLegalPage("privacy")}>Privacy & retention</button>
              <button type="button" onClick={() => openLegalPage("terms")}>Terms of use</button>
            </nav>
          </footer>
        )}
      </main>

      <div className={`toast ${toast ? "show" : ""}`} role="status">{toast}</div>
    </div>
  );
}
