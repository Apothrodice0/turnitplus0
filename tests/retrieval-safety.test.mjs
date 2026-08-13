import assert from "node:assert/strict";
import test from "node:test";
import {
  checkUrlStructure,
  resolveAndValidateHostname,
  validateUrlForRetrieval,
  isBlockedIpAddress,
  DEFAULT_RETRIEVAL_SAFETY_CONFIG,
} from "../lib/retrieval-safety.ts";

function fakeLookup(map) {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`fakeLookup: no entry configured for ${hostname}`);
    return addresses;
  };
}

// --- CASE A-G: structural checks (no DNS needed) ------------------------------

test("CASE A: a localhost URL is blocked", () => {
  const result = checkUrlStructure("http://localhost/some-page");
  assert.equal(result.safe, false);
});

test("CASE A (variant): *.localhost is blocked per RFC 6761", () => {
  assert.equal(checkUrlStructure("http://anything.localhost/x").safe, false);
});

test("CASE B: a literal 127.0.0.1 URL is blocked", () => {
  assert.equal(checkUrlStructure("http://127.0.0.1/x").safe, false);
});

test("CASE B (variant): the whole 127.0.0.0/8 loopback range is blocked, not just 127.0.0.1", () => {
  assert.equal(isBlockedIpAddress("127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("127.255.255.254"), true);
});

test("CASE C: private IPv4 ranges (10.x, 172.16-31.x, 192.168.x) are blocked", () => {
  for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"]) {
    assert.equal(isBlockedIpAddress(ip), true, `${ip} must be blocked`);
  }
  // 172.15.x/172.32.x are outside the private /12 and must NOT be blocked by this rule.
  assert.equal(isBlockedIpAddress("172.15.0.1"), false);
  assert.equal(isBlockedIpAddress("172.32.0.1"), false);
});

test("CASE D: loopback IPv6 (::1) is blocked", () => {
  assert.equal(checkUrlStructure("http://[::1]/x").safe, false);
  assert.equal(isBlockedIpAddress("::1"), true);
});

test("CASE D (variant): IPv6 link-local (fe80::/10) and unique-local (fc00::/7) are blocked", () => {
  assert.equal(isBlockedIpAddress("fe80::1"), true);
  assert.equal(isBlockedIpAddress("fc00::1"), true);
  assert.equal(isBlockedIpAddress("fd12:3456:789a::1"), true);
});

test("CASE D (variant): an IPv4-mapped IPv6 address is unwrapped and checked against the IPv4 rules — cannot be used to bypass IPv4 blocking", () => {
  assert.equal(isBlockedIpAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("::ffff:169.254.169.254"), true);
  assert.equal(isBlockedIpAddress("::ffff:8.8.8.8"), false);
});

test("CASE E: the cloud metadata-service address (169.254.169.254) is blocked as link-local", () => {
  assert.equal(isBlockedIpAddress("169.254.169.254"), true);
  assert.equal(checkUrlStructure("http://169.254.169.254/latest/meta-data/").safe, false);
});

test("CASE E (variant): known cloud metadata hostnames are explicitly denied", () => {
  assert.equal(checkUrlStructure("http://metadata.google.internal/").safe, false);
});

test("CASE F: non-http(s) protocols are blocked", () => {
  for (const url of ["ftp://example.org/file", "file:///etc/passwd", "gopher://example.org/", "data:text/html,hi"]) {
    assert.equal(checkUrlStructure(url).safe, false, `${url} must be blocked`);
  }
});

test("CASE G: embedded credentials in the URL are blocked", () => {
  assert.equal(checkUrlStructure("http://user:pass@example.org/x").safe, false);
  assert.equal(checkUrlStructure("http://user@example.org/x").safe, false);
});

test("a malformed URL is blocked, not thrown", () => {
  assert.doesNotThrow(() => checkUrlStructure("not a url at all"));
  assert.equal(checkUrlStructure("not a url at all").safe, false);
});

test("an ordinary public https URL passes structural checks", () => {
  assert.equal(checkUrlStructure("https://example.org/article").safe, true);
});

// --- DNS-resolution-based validation (the hostname-looks-fine-but-resolves-badly case) --

test("a hostname that resolves to a private address is blocked, even though the hostname itself looks public", () => {
  const lookup = fakeLookup({ "internal.example.org": [{ address: "10.0.0.5", family: 4 }] });
  return resolveAndValidateHostname("internal.example.org", lookup).then((result) => {
    assert.equal(result.safe, false);
  });
});

test("a hostname that resolves only to public addresses passes", async () => {
  const lookup = fakeLookup({ "example.org": [{ address: "93.184.216.34", family: 4 }] });
  const result = await resolveAndValidateHostname("example.org", lookup);
  assert.equal(result.safe, true);
});

test("a hostname with ANY blocked address among multiple DNS answers is blocked (conservative — no picking-and-choosing)", async () => {
  const lookup = fakeLookup({ "mixed.example.org": [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
  const result = await resolveAndValidateHostname("mixed.example.org", lookup);
  assert.equal(result.safe, false);
});

test("DNS resolution failure is reported as unsafe, not silently allowed", async () => {
  const lookup = async () => { throw new Error("ENOTFOUND"); };
  const result = await resolveAndValidateHostname("does-not-resolve.example.org", lookup);
  assert.equal(result.safe, false);
});

test("validateUrlForRetrieval runs the structural check BEFORE ever attempting DNS resolution", async () => {
  let lookupCalled = false;
  const lookup = async () => { lookupCalled = true; return [{ address: "93.184.216.34", family: 4 }]; };
  const result = await validateUrlForRetrieval("ftp://example.org/x", DEFAULT_RETRIEVAL_SAFETY_CONFIG, lookup);
  assert.equal(result.safe, false);
  assert.equal(lookupCalled, false, "an already-blocked protocol should never trigger a DNS lookup at all");
});

test("validateUrlForRetrieval passes for a fully valid public HTTPS URL with a fully public DNS answer", async () => {
  const lookup = fakeLookup({ "example.org": [{ address: "93.184.216.34", family: 4 }] });
  const result = await validateUrlForRetrieval("https://example.org/article", DEFAULT_RETRIEVAL_SAFETY_CONFIG, lookup);
  assert.equal(result.safe, true);
});

test("configurable: a denied-hostname list is respected and extensible", () => {
  const config = { ...DEFAULT_RETRIEVAL_SAFETY_CONFIG, deniedHostnames: [...DEFAULT_RETRIEVAL_SAFETY_CONFIG.deniedHostnames, "blocked-by-policy.example.org"] };
  assert.equal(checkUrlStructure("https://blocked-by-policy.example.org/x", config).safe, false);
  assert.equal(checkUrlStructure("https://not-blocked.example.org/x", config).safe, true);
});
