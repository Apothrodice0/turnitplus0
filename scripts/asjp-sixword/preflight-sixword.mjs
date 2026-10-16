// SIX-WORD PREFLIGHT (PREPARED; the Vercel part is NOT RUN without the owner's separate approval). READ-ONLY.
// Prints names, counts and PASS / FAIL only — never a variable value, token or URL credential.
//
// A) Vercel environment (where the app's flags live). Either:
//      --listing-file <json>   OFFLINE: [{ key, target: [..], gitBranch }] (e.g. saved from the Vercel API by the owner)
//      --project <prj_…> --team <team_…>   LIVE: GET /v10/projects/<id>/env?decrypt=false (paginated) with
//                                          VERCEL_TOKEN from the owner's shell; values are never requested
//    plus --branch <preview branch>. Checks:
//      V1 no ASJP_SIXWORD_* variable targets Production
//      V2 ASJP_SIXWORD_SELF_PROVISION is absent everywhere (the Preview uses the formal migration)
//      V3 ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED, if present, targets Preview ONLY and only the given branch
//      V4 the service-side variables (ASJP_SIXWORD_OVERLAP_ENABLED / _INDEX_DIR) are not in Vercel (they belong to the PC)
// B) The PC service (where the index lives): --service-env <file> --generation <generation.json>
//      S1 if ASJP_SIXWORD_OVERLAP_ENABLED=true: ASJP_SIXWORD_INDEX_DIR and ASJP_WORD_DF_PATH are set and exist
//      S2 the index identity names the generation's generationId and logicalManifestSha256
//      S3 the index was built from the generation's laneTokensDir: the same directory, index.json digest, tokens.bin size
//      S4 every path lies inside ASJP_ALLOWED_ROOTS
// usage: node scripts/asjp-sixword/preflight-sixword.mjs [A options] [B options]   (exit 1 on any FAIL)
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass: !!pass, detail });

async function vercelEntries() {
  const file = arg("--listing-file");
  if (file) return JSON.parse(readFileSync(file, "utf8")).map((e) => ({ key: e.key, target: e.target ?? [], gitBranch: e.gitBranch ?? null }));
  const project = arg("--project"), team = arg("--team"), token = process.env.VERCEL_TOKEN ?? "";
  if (!project || !team) return null;
  if (!token) { console.error("VERCEL_TOKEN is not set in this shell"); process.exit(2); }
  const raw = [];
  for (let until = null, page = 0; page < 50; page += 1) {
    const r = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/env?decrypt=false&limit=100${until ? `&until=${until}` : ""}&teamId=${encodeURIComponent(team)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) { console.error(`Vercel API ${r.status}`); process.exit(2); }
    const listing = await r.json();
    raw.push(...(listing.envs ?? []));
    until = listing.pagination?.next ?? null;
    if (!until) break;
  }
  return raw.map((e) => ({ key: e.key, target: e.target ?? [], gitBranch: e.gitBranch ?? null }));
}

const entries = await vercelEntries();
if (entries) {
  const branch = arg("--branch");
  if (!branch) { console.error("--branch <preview branch> is required with a Vercel listing"); process.exit(2); }
  const six = entries.filter((e) => /^ASJP_SIXWORD_/.test(e.key));
  check("V1 no ASJP_SIXWORD_* targets Production", !six.some((e) => e.target.includes("production")), `${six.filter((e) => e.target.includes("production")).length} production entries`);
  check("V2 ASJP_SIXWORD_SELF_PROVISION absent", !entries.some((e) => e.key === "ASJP_SIXWORD_SELF_PROVISION"));
  const display = entries.filter((e) => e.key === "ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED");
  check("V3 display flag only on the Preview branch", display.every((e) => e.target.length === 1 && e.target[0] === "preview" && e.gitBranch === branch), `${display.length} entries`);
  check("V4 service-side variables not in Vercel", !entries.some((e) => ["ASJP_SIXWORD_OVERLAP_ENABLED", "ASJP_SIXWORD_INDEX_DIR"].includes(e.key)));
}

const serviceEnvFile = arg("--service-env");
if (serviceEnvFile) {
  // both files may start with a BOM (Windows PowerShell 5.1 `Set-Content -Encoding utf8`, as 198 writes them)
  const text = (file) => readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const env = Object.fromEntries(text(serviceEnvFile).split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  const generation = JSON.parse(text(arg("--generation") ?? env.ASJP_GENERATION_CONFIG ?? ""));
  const roots = (env.ASJP_ALLOWED_ROOTS ?? "").split(";").filter(Boolean);
  const inside = (p) => !!p && roots.some((r) => path.resolve(p).toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep));
  if (env.ASJP_SIXWORD_OVERLAP_ENABLED !== "true") check("S0 six-word disabled on the service (nothing else to check)", true);
  else {
    const dir = env.ASJP_SIXWORD_INDEX_DIR, df = env.ASJP_WORD_DF_PATH;
    check("S1 index dir and word-df set and present", !!dir && !!df && existsSync(path.join(dir, "identity.json")) && existsSync(df));
    let identity = null; try { identity = JSON.parse(readFileSync(path.join(dir, "identity.json"), "utf8")); } catch { /* reported below */ }
    check("S2 index pinned to the service generation", identity?.generation?.generationId === generation.generationId && identity?.generation?.logicalManifestSha256 === generation.logicalManifestSha256);
    let sameStore = false;
    try { sameStore = createHash("sha256").update(readFileSync(path.join(generation.laneTokensDir, "index.json"))).digest("hex") === identity?.laneTokens?.indexJsonSha256 && statSync(path.join(generation.laneTokensDir, "tokens.bin")).size === identity?.laneTokens?.tokensBinBytes; } catch { sameStore = false; }
    // final review L-A: the SAME directory (the service opens only that one), not just equal content
    const fold = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p)); // as the service compares
    const samePath = !!identity?.laneTokens?.dir && fold(identity.laneTokens.dir) === fold(generation.laneTokensDir ?? "");
    check("S3 index built from the generation's lane token store (same directory, same content)", sameStore && samePath);
    check("S4 every path inside ASJP_ALLOWED_ROOTS", inside(dir) && inside(df) && inside(identity?.laneTokens?.dir) && inside(generation.laneTokensDir));
  }
}
if (!results.length) { console.error("nothing to check: give a Vercel listing (--listing-file or --project/--team) and/or --service-env"); process.exit(2); }
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
