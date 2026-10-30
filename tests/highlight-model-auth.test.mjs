import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { forgetServiceIdentityToken } from "../lib/highlight-model-auth.ts";
import { highlightModelConfig, requestPredictedHighlights } from "../lib/highlight-model.ts";

/**
 * HIGHLIGHT MODEL SERVICE IDENTITY: a private Cloud Run service gets a Google ID token in X-Serverless-Authorization
 * while our own key stays in Authorization; a half-configured identity keeps the model off; tokens are reused.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = { client_email: "invoker@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token" };
const AUDIENCE = "https://highlight-v1-abc123-ew.a.run.app";
const BASE = { HIGHLIGHT_MODEL_ENABLED: "1", HIGHLIGHT_MODEL_URL: `${AUDIENCE}/predict`, HIGHLIGHT_MODEL_KEY: "k".repeat(32), HIGHLIGHT_MODEL_VERSION: "v1-test" };
const TEXT = "A sentence the model reads. Another sentence after it.";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.c2ln";

function fakeGoogle() {
  const calls = { token: 0, predict: [] };
  const fetchImpl = async (url, init) => {
    if (url === SA.token_uri) {
      calls.token += 1;
      const assertion = new URLSearchParams(init.body).get("assertion");
      const [header, claims, signature] = assertion.split(".");
      assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")), "signed with the account key");
      const body = JSON.parse(Buffer.from(claims, "base64url").toString());
      assert.equal(body.target_audience, AUDIENCE);
      assert.equal(body.iss, SA.client_email);
      assert.equal(body.aud, SA.token_uri);
      return new Response(JSON.stringify({ id_token: ID_TOKEN }), { status: 200 });
    }
    calls.predict.push(init.headers);
    return new Response(JSON.stringify({ ranges: [{ start: 0, end: 27 }], modelVersion: "v1-test" }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test("no identity configured: no Google header, the local sidecar keeps working", async () => {
  const config = highlightModelConfig(BASE);
  assert.equal(config.enabled, true);
  const { calls, fetchImpl } = fakeGoogle();
  await requestPredictedHighlights(TEXT, config, fetchImpl);
  assert.equal(calls.token, 0);
  assert.equal(calls.predict[0]["X-Serverless-Authorization"], undefined);
});

test("a half-configured or unreadable identity keeps the model off", () => {
  assert.equal(highlightModelConfig({ ...BASE, HIGHLIGHT_MODEL_AUDIENCE: AUDIENCE }).enabled, false);
  assert.equal(highlightModelConfig({ ...BASE, HIGHLIGHT_MODEL_SERVICE_ACCOUNT: JSON.stringify(SA) }).enabled, false);
  assert.equal(highlightModelConfig({ ...BASE, HIGHLIGHT_MODEL_AUDIENCE: `${AUDIENCE}/predict`, HIGHLIGHT_MODEL_SERVICE_ACCOUNT: JSON.stringify(SA) }).enabled, false, "the audience is the service URL without a path");
  assert.equal(highlightModelConfig({ ...BASE, HIGHLIGHT_MODEL_AUDIENCE: AUDIENCE, HIGHLIGHT_MODEL_SERVICE_ACCOUNT: "not json" }).enabled, false);
});

test("with an identity: ID token in X-Serverless-Authorization, our key untouched in Authorization, token reused", async () => {
  forgetServiceIdentityToken();
  for (const raw of [JSON.stringify(SA), Buffer.from(JSON.stringify(SA)).toString("base64")]) {
    forgetServiceIdentityToken();
    const config = highlightModelConfig({ ...BASE, HIGHLIGHT_MODEL_AUDIENCE: AUDIENCE, HIGHLIGHT_MODEL_SERVICE_ACCOUNT: raw });
    assert.equal(config.enabled, true);
    const { calls, fetchImpl } = fakeGoogle();
    const ranges = await requestPredictedHighlights(TEXT, config, fetchImpl);
    await requestPredictedHighlights(TEXT, config, fetchImpl);
    assert.deepEqual(ranges, [{ start: 0, end: 27 }]);
    assert.equal(calls.token, 1, "one token for both requests");
    for (const headers of calls.predict) {
      assert.equal(headers["X-Serverless-Authorization"], `Bearer ${ID_TOKEN}`);
      assert.equal(headers.Authorization, `Bearer ${"k".repeat(32)}`);
    }
  }
});

test("Google refusing the account is not retried; its token endpoint failing is; a 401 from the service forgets the token", async () => {
  const config = highlightModelConfig({ ...BASE, HIGHLIGHT_MODEL_AUDIENCE: AUDIENCE, HIGHLIGHT_MODEL_SERVICE_ACCOUNT: JSON.stringify(SA) });
  for (const [status, retryable] of [[400, false], [503, true]]) {
    forgetServiceIdentityToken();
    const err = await requestPredictedHighlights(TEXT, config, async () => new Response("{}", { status })).catch((e) => e);
    assert.equal(err.retryable, retryable, String(status));
  }
  forgetServiceIdentityToken();
  const { calls, fetchImpl } = fakeGoogle();
  let refuse = true;
  const flaky = async (url, init) => (url === SA.token_uri || !refuse ? fetchImpl(url, init) : ((refuse = false), new Response("", { status: 401 })));
  const first = await requestPredictedHighlights(TEXT, config, flaky).catch((e) => e);
  assert.equal(first.retryable, false);
  await requestPredictedHighlights(TEXT, config, flaky);
  assert.equal(calls.token, 2, "a fresh token after the 401");
});
