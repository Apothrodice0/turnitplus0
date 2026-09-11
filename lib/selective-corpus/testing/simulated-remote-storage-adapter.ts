import {
  SelectiveCorpusObjectNotFoundError,
  SelectiveCorpusTransientStorageError,
  type SelectiveCorpusStorageAdapter,
} from "../storage-adapter";

/**
 * Selective Corpus V1 SHADOW slice — SIMULATED remote-like storage adapter.
 *
 * TEST-ONLY. Never imported by shadow.ts, config.ts, artifact.ts's default
 * path, or any other production code — only test files import from
 * lib/selective-corpus/testing/. It implements the SAME
 * SelectiveCorpusStorageAdapter interface as the local-filesystem adapter, so
 * it is a legitimate way to exercise the storage boundary under genuinely
 * async, remote-like conditions (deliberate latency, one-shot and persistent
 * failures, per-key call counting) WITHOUT any real network, socket, fetch(),
 * vendor SDK, or credential of any kind.
 *
 * Bytes are served either from an explicit in-memory `objects` map (fully
 * hand-crafted, deterministic fixtures — the common case for unit tests) or
 * delegated to a `backing` SelectiveCorpusStorageAdapter (e.g. the real local
 * adapter pointed at an existing corpus directory, for an equivalence test
 * that must prove identical results over the SAME real bytes without loading
 * the whole corpus into memory). A key present in both is served from
 * `objects` — the explicit simulation always wins.
 */

export type SimulatedRemoteObjectSpec = {
  /** The exact bytes to serve once any per-key failure simulation below has
   *  been resolved for this call. Required unless the key is only meant to
   *  simulate a permanent failure (persistentlyMissing / persistentlyBroken),
   *  in which case it may be omitted. */
  bytes?: Uint8Array;
  /** Simulated latency before resolving/rejecting, in ms. 0/undefined still
   *  yields at least one microtask (readObject/objectExists are always
   *  genuinely async — never a synchronous same-tick resolution). */
  delayMs?: number;
  /** Fails exactly this many reads of this key with
   *  SelectiveCorpusTransientStorageError, then serves `bytes` normally
   *  thereafter (models a one-shot transient blip / "corrected backend"). */
  transientFailuresBeforeSuccess?: number;
  /** Every read/exists check for this key acts as though the object was
   *  never published — SelectiveCorpusObjectNotFoundError forever. */
  persistentlyMissing?: boolean;
  /** Every read of this key throws a plain, persistent (non-NotFound,
   *  non-Transient) Error forever — models a permanently broken object
   *  distinct from "was never there". */
  persistentlyBroken?: boolean;
};

export interface SelectiveCorpusSimulatedRemoteAdapter extends SelectiveCorpusStorageAdapter {
  /** Physical readObject() invocations observed for this key so far — lets a
   *  test assert exact dedup/retry counts deterministically. */
  callCount(key: string): number;
  /** Replace or add a key's simulation spec after construction (e.g. "heal"
   *  a transiently-failing key mid-test, or register a new object). Resets
   *  that key's one-shot transient-failure counter. */
  setSpec(key: string, spec: SimulatedRemoteObjectSpec): void;
}

export type CreateSimulatedRemoteStorageAdapterOptions = {
  /** Explicit, in-memory-simulated objects, keyed by artifact-relative key. */
  objects?: Record<string, SimulatedRemoteObjectSpec>;
  /** Optional real adapter to delegate byte-serving to for any key NOT
   *  present in `objects` — e.g. the local-filesystem adapter pointed at a
   *  real (read-only) corpus directory, so an equivalence test can reuse the
   *  SAME on-disk bytes without copying them into memory. */
  backing?: SelectiveCorpusStorageAdapter;
  /** Applied to every `backing`-delegated call (objects with their own
   *  `delayMs` use that instead). Default 0 (still async, no artificial wait). */
  backingDelayMs?: number;
};

async function delay(ms: number | undefined): Promise<void> {
  if (!ms) {
    await Promise.resolve(); // stay genuinely async even with no configured latency
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createSimulatedRemoteStorageAdapter(
  options: CreateSimulatedRemoteStorageAdapterOptions = {},
): SelectiveCorpusSimulatedRemoteAdapter {
  const specs = new Map<string, SimulatedRemoteObjectSpec>(Object.entries(options.objects ?? {}));
  const counts = new Map<string, number>();
  const transientRemaining = new Map<string, number>();
  const backing = options.backing;
  const backingDelayMs = options.backingDelayMs ?? 0;

  function bumpCount(key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    async readObject(key: string): Promise<Uint8Array> {
      bumpCount(key);
      const spec = specs.get(key);
      if (!spec) {
        if (backing) {
          await delay(backingDelayMs);
          return backing.readObject(key); // propagates SelectiveCorpusObjectNotFoundError naturally
        }
        await delay(undefined);
        throw new SelectiveCorpusObjectNotFoundError(key);
      }

      await delay(spec.delayMs);

      if (spec.persistentlyMissing) throw new SelectiveCorpusObjectNotFoundError(key);
      if (spec.persistentlyBroken) throw new Error(`simulated remote storage: object permanently unreadable: ${key}`);

      if (spec.transientFailuresBeforeSuccess && spec.transientFailuresBeforeSuccess > 0) {
        const remaining = transientRemaining.get(key) ?? spec.transientFailuresBeforeSuccess;
        if (remaining > 0) {
          transientRemaining.set(key, remaining - 1);
          throw new SelectiveCorpusTransientStorageError(key, `simulated one-shot transient failure for ${key}`);
        }
      }

      if (spec.bytes === undefined) throw new SelectiveCorpusObjectNotFoundError(key);
      return spec.bytes;
    },

    async objectExists(key: string): Promise<boolean> {
      const spec = specs.get(key);
      if (!spec) {
        if (backing) {
          await delay(backingDelayMs);
          return backing.objectExists(key);
        }
        await delay(undefined);
        return false;
      }
      await delay(spec.delayMs);
      if (spec.persistentlyMissing) return false;
      return spec.bytes !== undefined || spec.persistentlyBroken === true || Boolean(spec.transientFailuresBeforeSuccess);
    },

    callCount(key: string): number {
      return counts.get(key) ?? 0;
    },

    setSpec(key: string, spec: SimulatedRemoteObjectSpec): void {
      specs.set(key, spec);
      transientRemaining.delete(key);
    },
  };
}
