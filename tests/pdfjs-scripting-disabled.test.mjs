import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

/**
 * Release-hardening audit finding DEP-01: pdfjs-dist carried a High-severity
 * advisory (GHSA-hq66-cqwq-w95j — arbitrary JavaScript execution upon
 * opening a malicious PDF, "provided enableScripting is true ... and no CSP
 * blocks script execution"). The primary fix is the version pin itself
 * (package.json now requires >=6.2.108, the patched release — see
 * npm audit, which no longer lists pdfjs-dist).
 *
 * The task also asked for an explicit enableScripting: false at every
 * getDocument() call site. That could not be done as literally specified:
 * in this pdfjs-dist version, `enableScripting` is not a getDocument()/
 * DocumentInitParameters option at all — TypeScript's own compiler rejects
 * it there (confirmed: `npm run build` fails with TS2353 on all four call
 * sites when the property is added). It exists only on
 * AnnotationLayerBuilder (web/annotation_layer_builder.d.ts) and PDFViewer
 * (web/pdf_viewer.d.ts) — pdfjs's interactive, DOM-rendering subsystem for
 * clickable form widgets/annotations. Forcing the property through with a
 * type-cast would compile but do nothing at runtime (getDocument()'s own
 * parsing/worker-message code never reads it), which would be a fake fix,
 * not a real one.
 *
 * This suite instead proves the property that's actually true and
 * meaningful here: PDF-embedded-JavaScript execution requires the
 * scripting-capable rendering subsystem to be wired up at all (an
 * AnnotationLayerBuilder or a full PDFViewer, rendered against a live DOM).
 * This application only ever calls getDocument() to extract text content
 * (see lib/pdf-text-extraction.ts's extractPdfTextDocument) — it never
 * imports either module, anywhere, so there is no code path through which
 * embedded PDF JavaScript could ever run, independent of any flag.
 */

const UNTRUSTED_PDF_CALL_SITES = [
  {
    path: 'lib/corpus-extraction-worker.ts',
    label: 'server corpus-extraction worker (user uploads, bulk import)',
  },
  {
    path: 'lib/document-check-pipeline.ts',
    label: 'browser document-check pipeline (the file the user just chose)',
  },
  {
    path: 'lib/http-content-retriever.ts',
    label: 'academic-search source retrieval (arbitrary third-party URLs)',
  },
  {
    path: 'lib/e7-asjp-client.ts',
    label: 'ASJP pilot client (external PDFs from asjp.cerist.dz; not currently wired into the live discovery workflow, still untrusted external content)',
  },
];

const SCRIPTING_CAPABLE_MODULES = [
  'annotation_layer_builder',
  'pdf_viewer',
  'AnnotationLayerBuilder',
  'PDFViewer',
  'PDFScriptingManager',
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function listAppSourceFiles() {
  const roots = ['lib', 'app', 'components'];
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(path.join(process.cwd(), dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(rel);
      }
    }
  }
  for (const root of roots) await walk(root);
  return files;
}

test('none of the four getDocument() call sites request enableScripting — the option does not exist on DocumentInitParameters in this pdfjs-dist version', async () => {
  for (const { path: filePath } of UNTRUSTED_PDF_CALL_SITES) {
    const source = stripComments(await readFile(new URL(`../${filePath}`, import.meta.url), 'utf8'));
    const callMatch = source.match(/pdfjs\.getDocument\(\{[^}]*\}\)/s);
    assert.ok(callMatch, `${filePath} must call pdfjs.getDocument({...}) — the call site itself was not found; has it moved or been refactored?`);
    assert.doesNotMatch(
      callMatch[0],
      /enableScripting/,
      `${filePath} must not pass enableScripting to getDocument() — it is not a valid option there (see this file's own header comment) and would only create a false sense of protection`,
    );
  }
});

test('the real guarantee: no application source file anywhere imports pdfjs-dist\'s scripting-capable rendering subsystem (AnnotationLayerBuilder, pdf_viewer, PDFScriptingManager)', async () => {
  const files = await listAppSourceFiles();
  assert.ok(files.length > 50, `expected to scan many source files, only found ${files.length} — the scan itself may be broken`);

  const offenders = [];
  for (const relPath of files) {
    // Strip comments first — several of the exact files this test checks
    // legitimately NARRATE these module names by name, in prose, explaining
    // why enableScripting doesn't apply (see this test file's own header
    // comment and lib/corpus-extraction-worker.ts's). Only executable code
    // (an actual import/reference) may fail this check.
    const source = stripComments(await readFile(path.join(process.cwd(), relPath), 'utf8'));
    for (const moduleName of SCRIPTING_CAPABLE_MODULES) {
      if (source.includes(moduleName)) {
        offenders.push(`${relPath} references "${moduleName}"`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these files reference pdfjs's interactive-rendering/scripting subsystem, which would need its own explicit review before this test's "embedded PDF JS can never execute" guarantee still holds: ${offenders.join('; ')}`,
  );
});

test('every getDocument() call site only extracts text content (extractPdfTextDocument), never renders a PDFViewer or annotation layer', async () => {
  for (const { path: filePath, label } of UNTRUSTED_PDF_CALL_SITES) {
    const source = await readFile(new URL(`../${filePath}`, import.meta.url), 'utf8');
    assert.match(
      source,
      /extractPdfTextDocument/,
      `${filePath} (${label}) must route its parsed document through extractPdfTextDocument — a different consumer here would need its own review`,
    );
  }
});

test('exactly the known untrusted-PDF call sites exist in application code — a new getDocument() call site elsewhere would silently miss this review', async () => {
  // Deliberately excludes tools/*.ts (offline calibration/benchmark scripts
  // over a developer-curated, non-adversarial corpus) and tests/fixtures/*
  // (test-only harnesses) — see this file's own header comment for why
  // those are out of scope for "untrusted PDF" hardening.
  const { execSync } = await import('node:child_process');
  const grep = execSync('grep -rl "pdfjs.getDocument(" lib/ app/ 2>&1 || true', { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const files = grep.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  const expected = UNTRUSTED_PDF_CALL_SITES.map((s) => s.path).sort();
  assert.deepEqual(
    files,
    expected,
    `expected exactly these lib/app files to call pdfjs.getDocument(): ${expected.join(', ')} — found: ${files.join(', ')}. ` +
    'A new call site must be reviewed against this file\'s own findings and added to UNTRUSTED_PDF_CALL_SITES above.',
  );
});

test('package.json pins pdfjs-dist to the patched release line (>=6.2.108, fixes GHSA-hq66-cqwq-w95j)', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const range = pkg.dependencies['pdfjs-dist'];
  assert.ok(range, 'pdfjs-dist must be a direct dependency');
  const versionMatch = range.match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(versionMatch, `pdfjs-dist range "${range}" must contain a parseable version`);
  const [, major, minor, patch] = versionMatch.map(Number);
  const atLeast6_2_108 = major > 6 || (major === 6 && (minor > 2 || (minor === 2 && patch >= 108)));
  assert.ok(atLeast6_2_108, `pdfjs-dist range "${range}" must be at least 6.2.108`);
});
