import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiscoveryProviderRegistry,
  resolveDiscoveryProviders,
  createDefaultDiscoveryProviderRegistry,
  createContentRetrieverRegistry,
  resolveContentRetriever,
  createDefaultContentRetrieverRegistry,
} from "../lib/source-discovery-registries.ts";
import { createFixtureDiscoveryProvider } from "../lib/discovery-providers.ts";

test("PROVIDER REGISTRY: resolves a registered provider by id", () => {
  const provider = createFixtureDiscoveryProvider({ id: "test-provider", type: "WEB_SEARCH", results: [] });
  const registry = createDiscoveryProviderRegistry([provider]);
  const [resolved] = resolveDiscoveryProviders(registry, ["test-provider"]);
  assert.equal(resolved.id, "test-provider");
});

test("PROVIDER REGISTRY: resolves multiple providers in the requested order", () => {
  const a = createFixtureDiscoveryProvider({ id: "a", type: "WEB_SEARCH", results: [] });
  const b = createFixtureDiscoveryProvider({ id: "b", type: "ACADEMIC_INDEX", results: [] });
  const registry = createDiscoveryProviderRegistry([a, b]);
  const resolved = resolveDiscoveryProviders(registry, ["b", "a"]);
  assert.deepEqual(resolved.map((p) => p.id), ["b", "a"]);
});

test("PROVIDER REGISTRY: an unregistered id throws a clear error rather than silently resolving to nothing", () => {
  const registry = createDiscoveryProviderRegistry([]);
  assert.throws(() => resolveDiscoveryProviders(registry, ["not-registered"]), /no discovery provider registered/);
});

test("PROVIDER REGISTRY: new providers are addable without touching orchestration — a registry is just data", () => {
  const custom = createFixtureDiscoveryProvider({ id: "future-provider", type: "REPOSITORY", results: [] });
  const registry = createDiscoveryProviderRegistry([custom]);
  assert.equal(registry.get("future-provider").type, "REPOSITORY");
});

test("PROVIDER REGISTRY: createDefaultDiscoveryProviderRegistry registers the real Crossref provider under id \"crossref\"", () => {
  const registry = createDefaultDiscoveryProviderRegistry();
  const provider = registry.get("crossref");
  assert.ok(provider);
  assert.equal(provider.type, "ACADEMIC_INDEX");
});

test("RETRIEVER REGISTRY: resolves a registered retriever by id", () => {
  const retriever = { id: "test-retriever", async retrieve() { return null; } };
  const registry = createContentRetrieverRegistry([retriever]);
  assert.equal(resolveContentRetriever(registry, "test-retriever").id, "test-retriever");
});

test("RETRIEVER REGISTRY: an unregistered id throws a clear error", () => {
  const registry = createContentRetrieverRegistry([]);
  assert.throws(() => resolveContentRetriever(registry, "missing"), /no content retriever registered/);
});

test("RETRIEVER REGISTRY: createDefaultContentRetrieverRegistry registers the real HTTP retriever under id \"http\"", () => {
  const registry = createDefaultContentRetrieverRegistry();
  const retriever = resolveContentRetriever(registry, "http");
  assert.equal(typeof retriever.retrieve, "function");
});
