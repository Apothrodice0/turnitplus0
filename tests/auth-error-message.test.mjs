import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { authErrorMessage } from "../lib/auth-error-message.ts";

test("rate limit: the sign-in / sign-up form says how long to wait (Retry-After seconds -> minutes)", () => {
  assert.equal(authErrorMessage(429, { error: "Too many requests" }, "45"), "Too many attempts. Please wait about 1 minute, then try again.");
  assert.equal(authErrorMessage(429, { error: "Too many requests" }, "600"), "Too many attempts. Please wait about 10 minutes, then try again.");
  assert.equal(authErrorMessage(429, null, null), "Too many attempts. Please wait a few minutes, then try again.");
});

test("signup identity rejection: the failing fields are named (the form has no server-error highlighting)", () => {
  const data = { error: "Some of your details could not be verified. Please review the highlighted fields.", fields: [{ field: "city", code: "UNKNOWN_CITY" }, { field: "phone", code: "PHONE_INVALID" }, { field: "city", code: "CITY_COUNTRY_MISMATCH" }] };
  assert.equal(authErrorMessage(400, data, null), "Some of your details could not be verified: City, Phone number. Please check them and try again.");
});

test("every other failure keeps the server's own message (generic login error, duplicate email, password rule) or a safe default", () => {
  assert.equal(authErrorMessage(401, { error: "Invalid email or password." }, null), "Invalid email or password.");
  assert.equal(authErrorMessage(409, { error: "An account with this email already exists." }, null), "An account with this email already exists.");
  assert.equal(authErrorMessage(400, { error: "Password must be at least 8 characters." }, null), "Password must be at least 8 characters.");
  assert.equal(authErrorMessage(500, null, null), "Something went wrong. Please try again.");
  assert.equal(authErrorMessage(400, { error: "x", fields: [{ field: "unknown" }] }, null), "x", "unknown field names are never invented");
});

test("the home page's auth form uses the helper with the response status and Retry-After header", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /setAuthError\(authErrorMessage\(response\.status, data, response\.headers\.get\("Retry-After"\)\)\)/);
});
