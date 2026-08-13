import { promises as dns } from "node:dns";
import net from "node:net";

/**
 * Phase E6C: SSRF protection for retrieving candidate source URLs.
 * Candidate URLs come from discovery providers (E6A/E6B) — untrusted input,
 * even when a provider like Crossref is generally reputable, since a
 * malicious or compromised metadata field could still point anywhere.
 *
 * Two layers, both required, per this phase's own instruction to validate
 * "1. initial URL 2. every redirect destination":
 *  1. checkUrlStructure — protocol/credentials/hostname-literal checks,
 *     synchronous, no I/O.
 *  2. resolveAndValidateHostname — actually resolves the hostname via DNS
 *     and validates every returned address, so a hostname that LOOKS
 *     innocuous but resolves to a private/internal address is still
 *     blocked (not just literal-IP URLs).
 * lib/http-content-retriever.ts calls both, for the initial URL AND again
 * for every redirect hop, via its own manual (non-auto-following) redirect
 * loop — see that file's header comment for why redirects are not
 * auto-followed.
 *
 * Known, accepted limitation (documented here rather than silently
 * assumed): this validates DNS resolution results at check time, but the
 * actual fetch() call performs its own, separate DNS resolution at connect
 * time. A adversary controlling DNS for a hostname could in principle swap
 * the answer between these two lookups (a "DNS rebinding" attack) to slip
 * past this check. Closing that gap fully requires pinning the connection
 * to the exact validated IP (e.g. a custom low-level connect hook), which
 * this phase deliberately does not build — see this phase's own task
 * description's preference for the smallest safe real implementation. This
 * is flagged as an explicit unresolved decision in the final report, not a
 * silent gap.
 */

export type RetrievalSafetyConfig = {
  allowedProtocols: string[];
  /** Exact-match hostnames, plus anything ending in ".localhost" (RFC 6761) is always denied regardless of this list. */
  deniedHostnames: string[];
  maxRedirects: number;
};

export const DEFAULT_RETRIEVAL_SAFETY_CONFIG: RetrievalSafetyConfig = {
  allowedProtocols: ["http:", "https:"],
  deniedHostnames: [
    "localhost",
    "localhost.localdomain",
    // Cloud instance-metadata hostnames — these resolve to the 169.254.169.254
    // link-local metadata address (already blocked below) on most providers,
    // but denying the hostname directly means the block does not depend on
    // that resolution behavior staying true.
    "metadata.google.internal",
    "metadata.internal",
    "metadata.azure.com",
  ],
  maxRedirects: 5,
};

export type UrlSafetyCheckResult = { safe: true } | { safe: false; reason: string };

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Explicit, fixed IPv4 ranges — loopback, RFC 1918 private space, link-local
 * (which includes the 169.254.169.254 cloud metadata address), CGNAT shared
 * space, documentation/benchmarking ranges, "this network" (0.0.0.0/8),
 * multicast, and reserved/broadcast. Listed explicitly rather than pulled
 * from a CIDR library — the fixed list is small, auditable, and easy to
 * test exhaustively.
 */
function isBlockedIPv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared space
  if (a === 0) return true; // "this network"
  if (a === 192 && b === 0 && octets[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && octets[2] === 2) return true; // documentation (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // documentation (TEST-NET-2)
  if (a === 203 && b === 0 && octets[2] === 113) return true; // documentation (TEST-NET-3)
  if (a >= 224) return true; // multicast (224-239) + reserved/broadcast (240-255)
  return false;
}

/** IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are unwrapped and checked against the IPv4 rules — otherwise an attacker could bypass IPv4 blocking simply by writing the address in its IPv6-mapped form. */
function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return isBlockedIPv4(mapped);
  }
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // fc00::/7 unique local (private)
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return true;
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return true; // not a recognizable IP at all — fail closed
}

/** Synchronous checks requiring no I/O: protocol, embedded credentials, denied/reserved hostnames, and literal (non-DNS) IP addresses. */
export function checkUrlStructure(rawUrl: string, config: RetrievalSafetyConfig = DEFAULT_RETRIEVAL_SAFETY_CONFIG): UrlSafetyCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "malformed URL" };
  }
  if (!config.allowedProtocols.includes(parsed.protocol)) {
    return { safe: false, reason: `protocol "${parsed.protocol}" is not allowed` };
  }
  if (parsed.username || parsed.password) {
    return { safe: false, reason: "URLs with embedded credentials are not allowed" };
  }
  const hostname = stripBrackets(parsed.hostname.toLowerCase());
  if (!hostname) return { safe: false, reason: "URL has no hostname" };
  if (config.deniedHostnames.includes(hostname) || hostname.endsWith(".localhost")) {
    return { safe: false, reason: `hostname "${hostname}" is denied` };
  }
  if (net.isIP(hostname) && isBlockedIpAddress(hostname)) {
    return { safe: false, reason: `literal IP address "${hostname}" is in a blocked range` };
  }
  return { safe: true };
}

export type DnsLookupFn = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>;

/** Actually resolves a hostname and validates every returned address — catches a hostname that structurally looks fine but resolves into a private/internal range. */
export async function resolveAndValidateHostname(
  hostname: string,
  lookup: DnsLookupFn = dns.lookup as unknown as DnsLookupFn,
): Promise<UrlSafetyCheckResult> {
  const literal = stripBrackets(hostname);
  if (net.isIP(literal)) {
    return isBlockedIpAddress(literal) ? { safe: false, reason: `literal IP address "${literal}" is in a blocked range` } : { safe: true };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    return { safe: false, reason: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!addresses || addresses.length === 0) {
    return { safe: false, reason: "DNS resolution returned no addresses" };
  }
  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) {
      return { safe: false, reason: `resolved address "${address}" is in a blocked range` };
    }
  }
  return { safe: true };
}

/** The full check a caller should run before connecting to any candidate/redirect URL: structural checks, then DNS-resolution validation. */
export async function validateUrlForRetrieval(
  rawUrl: string,
  config: RetrievalSafetyConfig = DEFAULT_RETRIEVAL_SAFETY_CONFIG,
  lookup?: DnsLookupFn,
): Promise<UrlSafetyCheckResult> {
  const structural = checkUrlStructure(rawUrl, config);
  if (!structural.safe) return structural;
  const parsed = new URL(rawUrl);
  return resolveAndValidateHostname(stripBrackets(parsed.hostname.toLowerCase()), lookup);
}
