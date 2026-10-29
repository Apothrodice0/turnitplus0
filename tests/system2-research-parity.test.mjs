import assert from "node:assert/strict";
import { unifySimilarity } from "../lib/system2-unified.ts";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { resetAuthRateForTest } from "../lib/rate-limit.js";
import { withTestIdentity } from "./helpers/test-signup.mjs";

// OPT-IN parity check (skipped unless both paths are set; the private backend and its model are NOT in this repo):
//   S2_PARITY_BACKEND_DIR = local copy of the protected inference service (folder containing api/analyze.py + s2_artifacts/)
//   S2_PARITY_V2_DIR      = the accepted local System 2 v2 tester (folder containing s2_local_test.py + tests/fixtures/)
// Every synthetic fixture is sent through THIS product route (owner session, consent) to the backend running on
// 127.0.0.1, and the returned fields must equal the local v2 tester's output exactly.

const BACKEND_DIR = process.env.S2_PARITY_BACKEND_DIR;
const V2_DIR = process.env.S2_PARITY_V2_DIR;
const EXTRA_FIXTURES = (process.env.S2_PARITY_EXTRA_FIXTURES ?? "").split(path.delimiter).filter(Boolean);
const enabled = Boolean(BACKEND_DIR && V2_DIR && fs.existsSync(path.join(BACKEND_DIR, "api", "analyze.py")) && fs.existsSync(path.join(V2_DIR, "s2_local_test.py")));

test("System 2 product route reproduces the accepted local v2 tester exactly", { skip: !enabled && "set S2_PARITY_BACKEND_DIR and S2_PARITY_V2_DIR to run" }, async () => {
  const repo = path.resolve(".");
  const dbFile = path.join(repo, "test_system2_parity.db");
  for (const s of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbFile}${s}`)) fs.unlinkSync(`${dbFile}${s}`);
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
  const setup = createClient({ url: `file:${dbFile}` }); await applyMigrationsLibsql(setup, path.join(repo, "drizzle")); setup.close();

  const KEY = "p".repeat(40);
  const server = `import sys, os, importlib.util\nsys.dont_write_bytecode = True\nfrom http.server import HTTPServer\nspec = importlib.util.spec_from_file_location("fn", os.path.join(sys.argv[1], "api", "analyze.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nsrv = HTTPServer(("127.0.0.1", 0), m.handler); print(srv.server_address[1], flush=True); srv.serve_forever()\n`;
  const py = spawn("python", ["-I", "-B", "-c", server, BACKEND_DIR], { env: { ...process.env, S2_TEST_KEY: KEY, VERCEL_ENV: "preview" }, stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => { py.stdout.once("data", (d) => resolve(Number(String(d).trim()))); py.once("exit", (c) => reject(new Error(`backend exited ${c}`))); });
  try {
    Object.assign(process.env, { S2_RESEARCH_ENABLED: "1", S2_RESEARCH_OWNER_EMAILS: "parity-owner@example.test", S2_INFERENCE_URL: `http://127.0.0.1:${port}/api/analyze`, S2_INFERENCE_KEY: KEY, VERCEL_ENV: "preview" });
    delete process.env.S2_INFERENCE_BYPASS;
    const route = await import("../app/api/reports/[id]/system2/route.ts");
    const signupRoute = await import("../app/api/auth/signup/route.ts");
    await resetAuthRateForTest("s2-parity");
    const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "s2-parity" },
      body: JSON.stringify(withTestIdentity({ email: "parity-owner@example.test", password: "s2-parity-fixture-pw", username: "s2parity", deviceKey: "s2-parity-device" })) }));
    const cookie = res.headers.get("set-cookie").match(/tp_session_v1=([^;]*)/)[1];
    const client = createClient({ url: `file:${dbFile}` });
    const userId = (await client.execute("SELECT id FROM users WHERE email = 'parity-owner@example.test'")).rows[0].id;
    await client.execute({ sql: "INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id) VALUES ('parity-report', 'd', 's', 't', '2026-10-28', 500, 3, 'low', '{}', ?)", args: [userId] });
    client.close();

    const fixtureDir = path.join(V2_DIR, "tests", "fixtures");
    const fixtures = [...fs.readdirSync(fixtureDir).filter((f) => f.endsWith(".docx")).map((f) => path.join(fixtureDir, f)), ...EXTRA_FIXTURES];
    const expectedScript = `import sys, json, importlib.util\nsys.dont_write_bytecode = True\nspec = importlib.util.spec_from_file_location("h", sys.argv[1]); h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)\nsys.stdout.reconfigure(encoding="utf-8")\nprint(json.dumps({p: h.estimate(p) for p in sys.argv[2:]}, ensure_ascii=False))\n`;
    const v2 = spawnSync("python", ["-I", "-B", "-c", expectedScript, path.join(V2_DIR, "s2_local_test.py"), ...fixtures], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(v2.status, 0, v2.stderr);
    const expected = JSON.parse(v2.stdout);
    const KEYS = ["state", "estimate_shown", "conservative_estimate_percent", "final_text", "warnings", "language_check", "report_category", "report_signals", "analyzable_words"];
    let matched = 0;
    let unifiedChecked = 0;
    for (const f of fixtures) {
      const body = fs.readFileSync(f);
      const r = await route.POST(new Request("http://localhost/api/reports/parity-report/system2", { method: "POST",
        headers: { cookie: `tp_session_v1=${cookie}`, "x-s2-consent": "granted", "x-file-extension": path.extname(f), "content-type": "application/octet-stream" }, body }), { params: Promise.resolve({ id: "parity-report" }) });
      const got = await r.json(); const exp = expected[f];
      for (const k of KEYS) assert.deepEqual(got[k], exp[k], `${path.basename(f)}: field ${k}`);
      const strip = (d) => { if (!d) return d; const { frozen_files_verified, ...rest } = d; return rest; };
      assert.deepEqual(strip(got.diagnostics), strip(exp.diagnostics), `${path.basename(f)}: diagnostics`);
      // Provisional unified score on the REAL model output: max(System 1, System 2) when shown, else System 1 unchanged.
      for (const s1 of [0, 10, 25]) {
        const u = unifySimilarity(s1, got);
        assert.equal(u.percent, exp.estimate_shown ? Math.max(s1, exp.conservative_estimate_percent) : s1, `${path.basename(f)}: unified @ S1=${s1}`);
        if (exp.estimate_shown) unifiedChecked += 1;
      }
      matched += 1;
    }
    console.log(`parity: ${matched}/${fixtures.length} fixtures identical; unified max-rule checks on real estimates: ${unifiedChecked}`);
    assert.equal(matched, fixtures.length);
  } finally {
    py.kill();
    for (const s of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbFile}${s}`)) try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* still open */ }
  }
});
