import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import {
  deriveReuseContextActionRef,
  isWellFormedActionRef,
  matchReuseContextActionRef,
  reuseContextSessionKey,
} from "../lib/reuse-context-action-ref.ts";
import { hashToken } from "../lib/auth-session.ts";

/**
 * Session-bound reuse-context action refs (lib/reuse-context-action-ref.ts).
 * Pure unit tests — no DB, no routes.
 */

const KEY_A = hashToken("raw-session-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const KEY_B = hashToken("raw-session-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

test("deterministic for the same session key + declaration id", () => {
  assert.equal(deriveReuseContextActionRef(KEY_A, 42), deriveReuseContextActionRef(KEY_A, 42));
  assert.equal(deriveReuseContextActionRef(KEY_A, 42n), deriveReuseContextActionRef(KEY_A, 42));
});

test("different session key -> different ref for the same declaration id", () => {
  assert.notEqual(deriveReuseContextActionRef(KEY_A, 42), deriveReuseContextActionRef(KEY_B, 42));
});

test("different declaration id -> different ref for the same session", () => {
  assert.notEqual(deriveReuseContextActionRef(KEY_A, 42), deriveReuseContextActionRef(KEY_A, 43));
});

test("output is exactly 64 lowercase hex", () => {
  const ref = deriveReuseContextActionRef(KEY_A, 7);
  assert.match(ref, /^[0-9a-f]{64}$/);
  assert.ok(isWellFormedActionRef(ref));
});

test("isWellFormedActionRef rejects malformed values", () => {
  for (const bad of [undefined, null, 42, "", "xyz", "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)} `, "ABCDEF" + "a".repeat(58)]) {
    assert.equal(isWellFormedActionRef(bad), false, `must reject: ${String(bad)}`);
  }
});

test("matchReuseContextActionRef: correct ref selects its candidate", () => {
  const candidateIds = [10, 20, 30];
  const ref = deriveReuseContextActionRef(KEY_A, 20);
  assert.equal(matchReuseContextActionRef(KEY_A, ref, candidateIds), 20);
});

test("matchReuseContextActionRef: a foreign-session ref matches nothing", () => {
  const candidateIds = [10, 20, 30];
  const foreign = deriveReuseContextActionRef(KEY_B, 20);
  assert.equal(matchReuseContextActionRef(KEY_A, foreign, candidateIds), null);
});

test("matchReuseContextActionRef: a ref for an id not in the candidate list matches nothing", () => {
  const ref = deriveReuseContextActionRef(KEY_A, 99);
  assert.equal(matchReuseContextActionRef(KEY_A, ref, [10, 20, 30]), null);
});

test("matchReuseContextActionRef: malformed submitted ref returns null without throwing", () => {
  assert.equal(matchReuseContextActionRef(KEY_A, "not-hex", [10, 20]), null);
  assert.equal(matchReuseContextActionRef(KEY_A, "a".repeat(63), [10, 20]), null);
});

test("matchReuseContextActionRef: empty candidate list returns null", () => {
  const ref = deriveReuseContextActionRef(KEY_A, 1);
  assert.equal(matchReuseContextActionRef(KEY_A, ref, []), null);
});

test("reuseContextSessionKey: requires both a valid session and a raw token", () => {
  assert.equal(reuseContextSessionKey(null, true), null);
  assert.equal(reuseContextSessionKey("raw", false), null);
  assert.equal(reuseContextSessionKey("", true), null);
  const key = reuseContextSessionKey("raw-token", true);
  assert.equal(key, hashToken("raw-token"));
});

test("STRUCTURAL: matching loop uses timingSafeEqual and never early-returns", () => {
  const src = fs.readFileSync(path.join(path.resolve("."), "lib/reuse-context-action-ref.ts"), "utf8");
  const fn = src.slice(src.indexOf("export function matchReuseContextActionRef"));
  assert.match(fn, /timingSafeEqual/, "must use crypto.timingSafeEqual");
  const loopBody = fn.slice(fn.indexOf("for ("), fn.indexOf("return matched"));
  assert.doesNotMatch(loopBody, /\breturn\b/, "the candidate loop must not early-return");
});

test("STRUCTURAL: no raw token / session hash is ever logged in the reuse-context server modules", () => {
  const repo = path.resolve(".");
  for (const rel of [
    "lib/reuse-context-action-ref.ts",
    "lib/reuse-context-report-binding.ts",
    "lib/reuse-context-mutation-guard.ts",
    "app/api/reuse-context/declare/route.ts",
    "app/api/reuse-context/withdraw/route.ts",
    "app/api/reuse-context/confirm/route.ts",
    "app/api/reuse-context/reject/route.ts",
  ]) {
    const src = fs.readFileSync(path.join(repo, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /console\.[a-z]+\([^)]*(sessionKey|sessionTokenHash|rawToken|rawSessionToken)/i, `${rel} must never log a session key/token`);
  }
});
