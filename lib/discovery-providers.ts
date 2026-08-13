import type { DiscoveryProviderType, DiscoveryQuery, DiscoverySignals, RawProviderResult } from "./discovery-types";
import { isDiscoveryProviderType } from "./discovery-types";
import { isSourceClass } from "./source-class";

/**
 * Phase E6A: the provider abstraction. This file defines the interface real
 * providers will eventually implement (E6B+) and, for THIS phase, only
 * deterministic, in-memory test doubles — see this phase's own task
 * description, section 19: "If a provider class exists, its discover()
 * implementation must not call the internet." No implementation in this
 * file, or anywhere else in this phase, performs a `fetch`, opens a socket,
 * or otherwise reaches outside the process — see
 * tests/discovery-orchestrator.test.mjs's structural "no network" test.
 */

export type DiscoveryProviderRequest = {
  requestId: string;
  queries: DiscoveryQuery[];
  signals: DiscoverySignals;
};

export interface SourceDiscoveryProvider {
  id: string;
  type: DiscoveryProviderType;
  discover(request: DiscoveryProviderRequest): Promise<RawProviderResult[]>;
}

/**
 * A minimal, defensive check on what a provider returned. This phase does
 * not trust provider output to be well-formed — a "malformed result" here
 * means the entry carries literally no identifying information at all (no
 * URL, no external identifier, no title): nothing a human or a later stage
 * could use to say what was even found. Such entries are dropped rather
 * than raised as an error, matching this phase's own task description,
 * section 13's framing that a bad/empty result is a normal, expected
 * outcome to handle gracefully, not a crash.
 */
export function isUsableProviderResult(result: unknown): result is RawProviderResult {
  if (!result || typeof result !== "object") return false;
  const candidate = result as Partial<RawProviderResult>;
  if (typeof candidate.querySignalUsed !== "string" || !candidate.querySignalUsed) return false;
  if (typeof candidate.discoveredAt !== "string" || !candidate.discoveredAt) return false;
  if (candidate.sourceClass != null && !isSourceClass(candidate.sourceClass)) return false;
  const hasUrl = typeof candidate.url === "string" && candidate.url.trim().length > 0;
  const hasIdentifier = typeof candidate.externalIdentifier === "string" && candidate.externalIdentifier.trim().length > 0;
  const hasTitle = typeof candidate.title === "string" && candidate.title.trim().length > 0;
  return hasUrl || hasIdentifier || hasTitle;
}

/** Filters a raw, possibly-malformed provider response down to usable results — never throws on bad input. */
export function sanitizeProviderResults(results: unknown[]): RawProviderResult[] {
  if (!Array.isArray(results)) return [];
  return results.filter(isUsableProviderResult);
}

/**
 * Classifies an error thrown by provider.discover() into one of this
 * phase's controlled attempt statuses (lib/discovery-types.ts). Recognizes
 * only explicit, deliberate signals a test double (or, later, a real
 * provider adapter) can set on the thrown error — `error.name` — rather
 * than guessing from message text, which would be fragile and
 * provider-specific.
 */
export function classifyProviderError(error: unknown): "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "ERROR" {
  const name = error instanceof Error ? error.name : "";
  if (name === "DiscoveryTimeoutError") return "TIMEOUT";
  if (name === "DiscoveryRateLimitError") return "RATE_LIMITED";
  if (name === "DiscoveryProviderUnavailableError") return "PROVIDER_UNAVAILABLE";
  return "ERROR";
}

export class DiscoveryTimeoutError extends Error {
  constructor(message = "discovery provider timed out") {
    super(message);
    this.name = "DiscoveryTimeoutError";
  }
}

export class DiscoveryRateLimitError extends Error {
  constructor(message = "discovery provider rate limit exceeded") {
    super(message);
    this.name = "DiscoveryRateLimitError";
  }
}

export class DiscoveryProviderUnavailableError extends Error {
  constructor(message = "discovery provider unavailable") {
    super(message);
    this.name = "DiscoveryProviderUnavailableError";
  }
}

export type FixtureDiscoveryProviderConfig = {
  id: string;
  type: DiscoveryProviderType;
  /** Either a fixed result list, or a pure function of the request — never a network call. May also throw one of this module's error classes (or any Error) to exercise failure handling deterministically. */
  results: RawProviderResult[] | ((request: DiscoveryProviderRequest) => RawProviderResult[]);
};

/**
 * Builds a deterministic, in-memory, no-network provider for tests (and,
 * later, for local development without live credentials). This is
 * explicitly NOT a real provider — see this file's own header comment.
 */
export function createFixtureDiscoveryProvider(config: FixtureDiscoveryProviderConfig): SourceDiscoveryProvider {
  if (!isDiscoveryProviderType(config.type)) {
    throw new Error(`createFixtureDiscoveryProvider: "${config.type}" is not a recognized discovery provider type`);
  }
  return {
    id: config.id,
    type: config.type,
    async discover(request) {
      return typeof config.results === "function" ? config.results(request) : config.results;
    },
  };
}
