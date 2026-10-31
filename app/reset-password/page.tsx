"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { authErrorMessage } from "@/lib/auth-error-message";

/**
 * Customer password recovery: Forgot password -> email sent -> reset password -> sign in.
 *
 * Without a token this page asks for the sign-in email (POST /api/auth/password-reset/request). The emailed link opens it
 * as /reset-password#token=<raw>: the token lives in the URL FRAGMENT, so it never reaches a server log or a Referer, and
 * the page removes it from the address bar as soon as it has read it. The link is checked first (expired / used links
 * say so before anything is typed), then the new password is set (POST /api/auth/password-reset/confirm), which signs
 * every device out; the customer then signs in with the new password.
 */
type Stage =
  | { kind: "request" }
  | { kind: "requested"; message: string }
  | { kind: "checking" }
  | { kind: "choose"; token: string }
  | { kind: "done"; message: string }
  | { kind: "link-problem"; message: string };

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as { status?: string; message?: string; error?: string; fields?: unknown } | null;
  return { response, data };
}

export default function ResetPasswordPage() {
  const [stage, setStage] = useState<Stage>({ kind: "checking" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const match = window.location.hash.match(/(?:^#|&)token=([^&]+)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    if (match) window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setStage({ kind: "request" });
      return;
    }
    if (!TOKEN_PATTERN.test(token)) {
      setStage({ kind: "link-problem", message: "This reset link is not valid. Request a new link from the sign-in page." });
      return;
    }
    void postJson("/api/auth/password-reset/confirm", { token, checkOnly: true })
      .then(({ response, data }) => {
        if (response.ok && data?.status === "VALID") setStage({ kind: "choose", token });
        else setStage({ kind: "link-problem", message: authErrorMessage(response.status, data, response.headers.get("Retry-After")) });
      })
      .catch(() => setStage({ kind: "link-problem", message: "Could not reach TurnitPlus. Check your connection and try again." }));
  }, []);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const { response, data } = await postJson("/api/auth/password-reset/request", { email });
      if (response.ok && data?.status === "requested") setStage({ kind: "requested", message: data.message ?? "" });
      else setError(authErrorMessage(response.status, data, response.headers.get("Retry-After")));
    } catch {
      setError("Could not reach TurnitPlus. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function choosePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || stage.kind !== "choose") return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirmPassword") ?? "")) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, data } = await postJson("/api/auth/password-reset/confirm", { token: stage.token, password });
      if (response.ok && data?.status === "reset") setStage({ kind: "done", message: data.message ?? "" });
      else if (data?.status === "INVALID" || data?.status === "EXPIRED" || data?.status === "USED") setStage({ kind: "link-problem", message: data.error ?? "" });
      else setError(authErrorMessage(response.status, data, response.headers.get("Retry-After")));
    } catch {
      setError("Could not reach TurnitPlus. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="reset-password-page">
      <section className="auth-page-card surface-card" aria-labelledby="reset-password-title">
        <div className="auth-dialog-brand">
          <div className="brand-mark">T+</div>
          <div><strong>TurnitPlus</strong><span>AI & similarity detection</span></div>
        </div>

        {stage.kind === "checking" && <p className="auth-dialog-intro" role="status">Checking your reset link…</p>}

        {stage.kind === "request" && (
          <>
            <p className="section-label">FORGOT PASSWORD</p>
            <h2 id="reset-password-title">Reset your password</h2>
            <p className="auth-dialog-intro">Enter the email address you use to sign in. We&apos;ll email you a link to choose a new password.</p>
            <form className="auth-form" onSubmit={requestLink}>
              <label>
                <span>Email address</span>
                <input type="email" name="email" autoComplete="email" placeholder="you@example.com" autoFocus required disabled={busy} />
              </label>
              {error && <p className="auth-form-error" role="alert">{error}</p>}
              <button className="button primary full auth-submit" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
            </form>
            <p className="auth-dialog-intro"><Link href="/#account">Back to sign in</Link></p>
          </>
        )}

        {stage.kind === "requested" && (
          <>
            <p className="section-label">CHECK YOUR EMAIL</p>
            <h2 id="reset-password-title">Reset link requested</h2>
            <p className="auth-dialog-intro" role="status">{stage.message}</p>
            <p className="auth-dialog-intro"><Link href="/#account">Back to sign in</Link></p>
          </>
        )}

        {stage.kind === "choose" && (
          <>
            <p className="section-label">NEW PASSWORD</p>
            <h2 id="reset-password-title">Choose a new password</h2>
            <p className="auth-dialog-intro">Use at least 8 characters. Changing your password signs you out on every device.</p>
            <form className="auth-form" onSubmit={choosePassword}>
              <label>
                <span>New password</span>
                <input type="password" name="password" autoComplete="new-password" minLength={8} maxLength={200} autoFocus required disabled={busy} />
              </label>
              <label>
                <span>Confirm new password</span>
                <input type="password" name="confirmPassword" autoComplete="new-password" minLength={8} maxLength={200} required disabled={busy} />
              </label>
              {error && <p className="auth-form-error" role="alert">{error}</p>}
              <button className="button primary full auth-submit" type="submit" disabled={busy}>{busy ? "Saving…" : "Set new password"}</button>
            </form>
          </>
        )}

        {stage.kind === "done" && (
          <>
            <p className="section-label">PASSWORD CHANGED</p>
            <h2 id="reset-password-title">You&apos;re all set</h2>
            <p className="auth-dialog-intro" role="status">{stage.message}</p>
            <Link className="button primary full auth-submit" href="/#account">Sign in</Link>
          </>
        )}

        {stage.kind === "link-problem" && (
          <>
            <p className="section-label">RESET LINK</p>
            <h2 id="reset-password-title">This link can&apos;t be used</h2>
            <p className="auth-form-error" role="alert">{stage.message}</p>
            <button className="button primary full auth-submit" type="button" onClick={() => { setError(null); setStage({ kind: "request" }); }}>Request a new link</button>
            <p className="auth-dialog-intro"><Link href="/#account">Back to sign in</Link></p>
          </>
        )}
      </section>
    </main>
  );
}
