import type { SourceDiscoveryProvider } from "./discovery-providers";
import { createCrossrefDiscoveryProvider, type CrossrefProviderConfig } from "./discovery-crossref-provider";
import type { SourceContentRetriever } from "./retrieval-types";
import { createHttpContentRetriever, type HttpContentRetrieverConfig } from "./http-content-retriever";

/**
 * Phase E6D: small, explicit registries resolving provider/retriever IDs to
 * implementations — this phase's task description, sections 3/4: "Do NOT
 * hard-code the workflow directly to Crossref... Future providers must be
 * addable without rewriting orchestration." lib/source-discovery-workflow.ts
 * never imports lib/discovery-crossref-provider.ts or
 * lib/http-content-retriever.ts directly for its default behavior — only
 * this file does, and only inside the two "default registry" factories
 * below. Adding a new provider/retriever later means registering it here
 * (or passing a custom registry into the workflow, which tests already do),
 * not editing the orchestration logic itself.
 */

export type DiscoveryProviderRegistry = ReadonlyMap<string, SourceDiscoveryProvider>;

export function createDiscoveryProviderRegistry(providers: SourceDiscoveryProvider[]): DiscoveryProviderRegistry {
  const registry = new Map<string, SourceDiscoveryProvider>();
  for (const provider of providers) registry.set(provider.id, provider);
  return registry;
}

export function resolveDiscoveryProviders(registry: DiscoveryProviderRegistry, ids: string[]): SourceDiscoveryProvider[] {
  return ids.map((id) => {
    const provider = registry.get(id);
    if (!provider) throw new Error(`resolveDiscoveryProviders: no discovery provider registered under id "${id}"`);
    return provider;
  });
}

/** The only place this project wires up the real Crossref provider by default — see this file's own header comment. */
export function createDefaultDiscoveryProviderRegistry(crossrefConfig: Partial<CrossrefProviderConfig> = {}): DiscoveryProviderRegistry {
  return createDiscoveryProviderRegistry([createCrossrefDiscoveryProvider(crossrefConfig)]);
}

export type ContentRetrieverRegistry = ReadonlyMap<string, SourceContentRetriever>;

export function createContentRetrieverRegistry(retrievers: SourceContentRetriever[]): ContentRetrieverRegistry {
  const registry = new Map<string, SourceContentRetriever>();
  for (const retriever of retrievers) registry.set(retriever.id, retriever);
  return registry;
}

export function resolveContentRetriever(registry: ContentRetrieverRegistry, id: string): SourceContentRetriever {
  const retriever = registry.get(id);
  if (!retriever) throw new Error(`resolveContentRetriever: no content retriever registered under id "${id}"`);
  return retriever;
}

/** The only place this project wires up the real HTTP retriever by default — see this file's own header comment. */
export function createDefaultContentRetrieverRegistry(httpConfig: Partial<HttpContentRetrieverConfig> = {}): ContentRetrieverRegistry {
  const retriever = createHttpContentRetriever(httpConfig);
  return createContentRetrieverRegistry([{ ...retriever, id: "http" }]);
}
