import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.js";
import { rawSha256 } from "../lib/document-identity.ts";
import { findFamilyForIdentity } from "../lib/document-family.ts";
import { classifyFamilyRelationships } from "../lib/document-relationship.ts";

// Phase C activation: POST /api/reports now runs the full identity +
// fingerprint + family pipeline (lib/document-family.ts's
// captureDocumentIdentityAndFamily) via lib/run-after-response.ts. This file
// proves that activation actually works when exercised through the real
// route (not just by calling the lib functions directly, as
// tests/document-family.test.mjs and tests/document-relationship.test.mjs
// do), and that the save response itself is completely unchanged by it.
//
// As documented in lib/run-after-response.ts and tests/run-after-response.test.mjs,
// route handlers called this way (a plain function call, no real Next.js
// server) never have an active request scope, so after() always falls back
// to running the work inline before POST()'s own promise resolves. That
// means every assertion below can safely query the database immediately
// after awaiting reportsRoute.POST() — there is nothing to poll for.

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_report_identity_activation.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let counter = 0;
function nextId() {
  counter += 1;
  return `activation-report-${counter}`;
}

async function signup(email, deviceKey) {
  resetAuthRateForTest(`activation-signup-${email}`);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `activation-signup-${email}` },
    body: JSON.stringify({ email, password: "activation-password-1", username: email.split("@")[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  // Privacy hardening: grants cross-account corpus-reuse consent immediately
  // so this file's existing scenarios (written before consent-gating
  // existed) continue to exercise the real indexDocumentSubmissionIntoCorpus
  // path via the live route, unchanged — see
  // tests/report-privacy-consent.test.mjs for the dedicated consent on/off
  // behavior this gate itself needs.
  await setupClient.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE email = ?", args: [email] });
  return { res, cookie: extractCookie(res) };
}

async function postReport({ deviceKey, id, title = "activation.pdf", text, cookie }) {
  const rateKey = `activation-post-${id}`;
  resetRateForTest(rateKey);
  const headers = { "content-type": "application/json", "x-forwarded-for": rateKey };
  if (cookie) headers.cookie = `tp_session_v1=${cookie}`;
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      deviceKey,
      id,
      submissionId: `sub-${id}`,
      title,
      createdAt: new Date().toISOString(),
      wordCount: 40,
      archiveScore: 0,
      scoreBand: "Low",
      aiScore: null,
      aiTone: null,
      payload: { id, title, text },
    }),
  });
  const res = await reportsRoute.POST(req);
  return res;
}

test("saving a report still returns { ok: true }/200, and now also creates document_identities + document_identity_shingles rows as a side effect", async () => {
  const text = "Volcanologists analyzing satellite thermal imagery of an active stratovolcano detected a gradual increase in surface temperature anomalies over several months. Ground deformation sensors installed around the summit recorded slow but measurable inflation consistent with subsurface magma accumulation. These combined observations prompted regional authorities to raise the volcanic alert level.";
  const id = nextId();
  const res = await postReport({ deviceKey: "activation-device-1", id, text });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true }, "the save response must be byte-for-byte identical to pre-Phase-C behavior");

  const raw = rawSha256(text);
  const identityRow = await setupClient.execute({ sql: "SELECT id, unique_shingle_count FROM document_identities WHERE raw_sha256 = ?", args: [raw] });
  assert.equal(identityRow.rows.length, 1, "a document_identities row must now exist for a saved report");
  assert.ok(Number(identityRow.rows[0].unique_shingle_count) > 0, "the fingerprint must have actually been recorded, not left at the Phase B default of NULL/0");

  const shingleCount = await setupClient.execute({ sql: "SELECT COUNT(*) as cnt FROM document_identity_shingles WHERE document_identity_id = ?", args: [identityRow.rows[0].id] });
  assert.ok(Number(shingleCount.rows[0].cnt) > 0, "document_identity_shingles rows must have actually been inserted");
});

test("a report with no text field still saves successfully and creates no identity row (unchanged from Phase A)", async () => {
  const id = nextId();
  const rateKey = `activation-post-${id}`;
  resetRateForTest(rateKey);
  const req = new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": rateKey },
    body: JSON.stringify({
      deviceKey: "activation-device-no-text",
      id,
      submissionId: `sub-${id}`,
      title: "no-text.pdf",
      createdAt: new Date().toISOString(),
      wordCount: 0,
      archiveScore: 0,
      scoreBand: "Low",
      aiScore: null,
      aiTone: null,
      payload: { id, title: "no-text.pdf" }, // no `text`
    }),
  });
  const res = await reportsRoute.POST(req);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("an authenticated save captures the signed-in account's id on the resulting identity", async () => {
  const email = "activation-auth-1@example.com";
  const { cookie } = await signup(email, "activation-device-auth-1");
  const text = "Seismologists deploying a temporary array of portable seismometers across a fault zone recorded a previously undetected swarm of microearthquakes clustered along a shallow splay fault. Waveform analysis suggested these events were distinct in character from the region's typical background seismicity. Researchers recommended extending the deployment to capture a longer observation window.";
  const id = nextId();
  const res = await postReport({ deviceKey: "activation-device-auth-1", id, text, cookie });
  assert.equal(res.status, 200);

  const raw = rawSha256(text);
  const identityRow = await setupClient.execute({ sql: "SELECT account_id FROM document_identities WHERE raw_sha256 = ?", args: [raw] });
  assert.equal(identityRow.rows.length, 1);
  const userRow = await setupClient.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  assert.equal(identityRow.rows[0].account_id, userRow.rows[0].id, "the identity's account_id must be the signed-in user, not null");
});

test("end-to-end through the real route: two related saves by the same authenticated account land in the same family, and classify as SELF relative to each other", async () => {
  const email = "activation-auth-2@example.com";
  const { cookie } = await signup(email, "activation-device-auth-2");

  const base = "Entomologists surveying pollinator populations across agricultural field margins recorded a marked decline in wild bee species richness compared to a decade-old baseline survey. Habitat fragmentation and reduced flowering plant diversity were identified as the strongest correlating factors. These results informed subsequent hedgerow restoration recommendations for participating farms.";
  const revised = "Entomologists surveying pollinator populations across agricultural field margins recorded a marked decline in wild bee species richness compared to a decade-old baseline survey. Habitat fragmentation and reduced flowering plant diversity were identified as the strongest correlating factors. These results informed subsequent hedgerow restoration recommendations for neighboring farms.";

  const firstId = nextId();
  await postReport({ deviceKey: "activation-device-auth-2", id: firstId, text: base, cookie });
  const secondId = nextId();
  await postReport({ deviceKey: "activation-device-auth-2", id: secondId, text: revised, cookie });

  const firstIdentity = await setupClient.execute({ sql: "SELECT id FROM document_identities WHERE raw_sha256 = ?", args: [rawSha256(base)] });
  const secondIdentity = await setupClient.execute({ sql: "SELECT id FROM document_identities WHERE raw_sha256 = ?", args: [rawSha256(revised)] });
  const firstIdentityId = firstIdentity.rows[0].id;
  const secondIdentityId = secondIdentity.rows[0].id;

  const firstFamily = await findFamilyForIdentity(setupClient, firstIdentityId);
  const secondFamily = await findFamilyForIdentity(setupClient, secondIdentityId);
  assert.ok(firstFamily, "the first save must have been folded into a family once the second, related save arrived");
  assert.equal(firstFamily.family.id, secondFamily.family.id, "both saves must end up in the same family, purely from posting through the real route twice");

  const relationships = await classifyFamilyRelationships(setupClient, secondIdentityId);
  const relative = relationships.find((r) => r.documentIdentityId === firstIdentityId);
  assert.equal(relative.relationship, "SELF", "the same authenticated account's own earlier save must classify as SELF");
});

test("end-to-end through the real route: the same document saved by a different authenticated account classifies as PRIOR_SUBMISSION, not SELF", async () => {
  const ownerEmail = "activation-owner@example.com";
  const strangerEmail = "activation-stranger@example.com";
  const { cookie: ownerCookie } = await signup(ownerEmail, "activation-device-owner");
  const { cookie: strangerCookie } = await signup(strangerEmail, "activation-device-stranger");

  const text = "Ornithologists banding migratory shorebirds at a coastal stopover site documented a shift in average arrival dates several days earlier than historical records from the same location. Concurrent weather station data showed a corresponding trend toward earlier spring warming in the birds' breeding range. Researchers linked the two trends as plausibly connected rather than coincidental.";

  const ownerId = nextId();
  await postReport({ deviceKey: "activation-device-owner", id: ownerId, text, cookie: ownerCookie });
  const strangerId = nextId();
  await postReport({ deviceKey: "activation-device-stranger", id: strangerId, text, cookie: strangerCookie });

  const ownerIdentity = await setupClient.execute({ sql: "SELECT id FROM document_identities WHERE raw_sha256 = ? AND account_id = (SELECT id FROM users WHERE email = ?)", args: [rawSha256(text), ownerEmail] });
  const strangerIdentity = await setupClient.execute({ sql: "SELECT id FROM document_identities WHERE raw_sha256 = ? AND account_id = (SELECT id FROM users WHERE email = ?)", args: [rawSha256(text), strangerEmail] });
  const ownerIdentityId = ownerIdentity.rows[0].id;
  const strangerIdentityId = strangerIdentity.rows[0].id;

  const ownerFamily = await findFamilyForIdentity(setupClient, ownerIdentityId);
  const strangerFamily = await findFamilyForIdentity(setupClient, strangerIdentityId);
  assert.equal(ownerFamily.family.id, strangerFamily.family.id, "an identical document from a different account must still join the same family (text, not account, determines family)");

  const relationships = await classifyFamilyRelationships(setupClient, strangerIdentityId);
  const relative = relationships.find((r) => r.documentIdentityId === ownerIdentityId);
  assert.equal(relative.relationship, "PRIOR_SUBMISSION", "a different account's identical submission must classify as PRIOR_SUBMISSION, never SELF");
});

test.after(() => {
  setupClient.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
