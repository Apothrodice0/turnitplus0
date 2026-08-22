import fs from "node:fs";
import { createClient } from "@libsql/client";
import { evaluateCorpusAdmissionCandidate } from "../../lib/corpus-admission-gate.ts";

/**
 * Cross-process worker for tests/corpus-admission-cross-process.test.mjs.
 *
 * Launched via node:child_process.fork() with execArgv ["--import","tsx"] —
 * a genuinely independent OS process with its own V8 isolate and its own
 * fresh module registry: importing lib/corpus-admission-gate.ts here creates
 * a distinct instance of that module's file-private acceptSerializationQueue
 * (lib/corpus-admission-gate.ts's same-process critical-section
 * serialization), never shared with the parent test process or any sibling
 * worker. The only thing genuinely shared across every worker in a test run
 * is the on-disk SQLite database file itself, referenced by URL. This is
 * what makes a pass in that test file real cross-process evidence rather
 * than another same-process Promise.all with extra ceremony.
 *
 * Two-phase handshake with the parent, over the fork's IPC channel:
 *   1. parent sends {type:"start", config} -> worker opens its OWN client
 *      connection to the shared db file, then replies {type:"ready"}.
 *   2. once every sibling worker has replied ready, the parent broadcasts
 *      {type:"go", startAtEpochMs} to all of them at once. Each worker
 *      sleeps until that shared future timestamp (not "as soon as the go
 *      message arrives") before calling evaluateCorpusAdmissionCandidate —
 *      a real synchronization barrier that absorbs per-process
 *      spawn/import/connect jitter, so the race actually starts together
 *      rather than being smeared out by whichever process happened to boot
 *      fastest.
 */

process.once("message", (startMsg) => {
  if (startMsg.type !== "start") return;
  void run(startMsg.config);
});

async function run(config) {
  const client = createClient({ url: config.dbUrl });
  await client.execute("PRAGMA foreign_keys = ON");

  process.send({ type: "ready" });

  process.once("message", async (goMsg) => {
    if (goMsg.type !== "go") return;
    const waitMs = goMsg.startAtEpochMs - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // process.send() queues an async IPC write; calling process.exit()
    // right after it (without waiting for the callback) can truncate that
    // write before it flushes. Always exit from inside the send callback so
    // the parent is guaranteed to receive this final message.
    const sendThenExit = (message) => {
      client.close();
      process.send(message, () => process.exit(0));
    };

    try {
      const bytes = fs.readFileSync(config.bytesFilePath);
      const decision = await evaluateCorpusAdmissionCandidate(client, {
        sourceRef: config.sourceRef,
        filename: config.filename,
        bytes,
        consent: config.consent,
        dryRun: config.dryRun ?? false,
        openConnection: () => createClient({ url: config.dbUrl }),
      });
      sendThenExit({ type: "result", decision });
    } catch (err) {
      sendThenExit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? (err.stack ?? null) : null,
      });
    }
  });
}
