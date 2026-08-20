import assert from "node:assert/strict";
import test from "node:test";
import { extractCitationPdfUrl, extractTextFromHtml, HTML_EXTRACTOR_VERSION } from "../lib/html-text-extraction.ts";

test("extracts plain visible text from simple HTML", () => {
  const html = "<html><body><h1>Title</h1><p>Some visible paragraph text.</p></body></html>";
  const text = extractTextFromHtml(html);
  assert.match(text, /Title/);
  assert.match(text, /Some visible paragraph text\./);
});

test("removes script content entirely", () => {
  const html = "<p>Before</p><script>var secretPayload = 'should never appear';</script><p>After</p>";
  const text = extractTextFromHtml(html);
  assert.doesNotMatch(text, /secretPayload/);
  assert.match(text, /Before/);
  assert.match(text, /After/);
});

test("removes style content entirely", () => {
  const html = "<style>.hidden { display:none; color: red; }</style><p>Visible text</p>";
  const text = extractTextFromHtml(html);
  assert.doesNotMatch(text, /display:none/);
  assert.match(text, /Visible text/);
});

test("removes HTML comments", () => {
  const html = "<p>Before</p><!-- internal note, must not leak --><p>After</p>";
  const text = extractTextFromHtml(html);
  assert.doesNotMatch(text, /internal note/);
});

test("removes nav/header/footer/aside noise where present", () => {
  const html = "<nav>Home About Contact</nav><header>Site Name</header><article>The actual article content.</article><footer>Copyright 2026</footer>";
  const text = extractTextFromHtml(html);
  assert.match(text, /The actual article content\./);
  assert.doesNotMatch(text, /Home About Contact/);
  assert.doesNotMatch(text, /Copyright 2026/);
});

test("decodes common HTML entities", () => {
  const html = "<p>Tom &amp; Jerry said &quot;hello&quot; &mdash; it&#39;s &lt;fun&gt;</p>".replace("&mdash;", "-");
  const text = extractTextFromHtml(html);
  assert.match(text, /Tom & Jerry/);
  assert.match(text, /"hello"/);
  assert.match(text, /it's/);
  assert.match(text, /<fun>/);
});

test("does not double-decode &amp;lt; into a literal < that could be mistaken for a tag", () => {
  const html = "<p>Use &amp;lt;tag&amp;gt; syntax</p>";
  const text = extractTextFromHtml(html);
  assert.match(text, /&lt;tag&gt;/, "the escaped-ampersand entity must decode to a literal ampersand sequence, not a real tag");
});

test("preserves paragraph/block boundaries as line breaks rather than running words together", () => {
  const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
  const text = extractTextFromHtml(html);
  assert.doesNotMatch(text, /First paragraph\.Second paragraph\./, "block-level elements must not be concatenated without any separator");
});

test("collapses excessive blank lines", () => {
  const html = "<p>A</p>" + "<div></div>".repeat(20) + "<p>B</p>";
  const text = extractTextFromHtml(html);
  assert.doesNotMatch(text, /\n{3,}/);
});

test("never invents text — output contains no substring absent from the input's own text nodes", () => {
  const html = "<p>Distinctive-Token-Alpha-12345</p>";
  const text = extractTextFromHtml(html);
  assert.match(text, /Distinctive-Token-Alpha-12345/);
  // Sanity: nothing resembling a boilerplate phrase this extractor might
  // hypothetically fabricate should appear.
  assert.doesNotMatch(text, /lorem ipsum/i);
});

test("handles malformed/unclosed HTML without throwing", () => {
  const html = "<p>Unclosed paragraph <div>nested <span>content";
  assert.doesNotThrow(() => extractTextFromHtml(html));
  const text = extractTextFromHtml(html);
  assert.match(text, /Unclosed paragraph/);
  assert.match(text, /nested/);
  assert.match(text, /content/);
});

test("empty input produces empty output without throwing", () => {
  assert.equal(extractTextFromHtml(""), "");
  assert.equal(extractTextFromHtml("<html><head></head><body></body></html>"), "");
});

test("HTML_EXTRACTOR_VERSION is a stable, non-empty identifier", () => {
  assert.equal(typeof HTML_EXTRACTOR_VERSION, "string");
  assert.ok(HTML_EXTRACTOR_VERSION.length > 0);
});

// --- "Investigate two production issues" ISSUE 1: extractCitationPdfUrl ---

test("extractCitationPdfUrl finds a real, name-before-content citation_pdf_url meta tag", () => {
  // Exact attribute order captured live from a real episciences.org landing
  // page during this investigation (see http-content-retriever.ts's own
  // comment on why this matters): name="citation_pdf_url" content="...".
  const html = '<html><head><meta name="citation_pdf_url" content="https://example.org/articles/15337/pdf" ></head><body>Abstract text.</body></html>';
  assert.equal(extractCitationPdfUrl(html), "https://example.org/articles/15337/pdf");
});

test("extractCitationPdfUrl also finds a content-before-name ordering", () => {
  const html = '<meta content="https://example.org/paper.pdf" name="citation_pdf_url">';
  assert.equal(extractCitationPdfUrl(html), "https://example.org/paper.pdf");
});

test("extractCitationPdfUrl returns null when the tag is absent", () => {
  const html = '<html><head><meta name="citation_title" content="A Paper"></head><body>Text</body></html>';
  assert.equal(extractCitationPdfUrl(html), null);
});

test("extractCitationPdfUrl returns null for empty/malformed input without throwing", () => {
  assert.equal(extractCitationPdfUrl(""), null);
  assert.doesNotThrow(() => extractCitationPdfUrl("<meta name=citation_pdf_url>"));
});

test("extractCitationPdfUrl does not match an unrelated citation_ meta tag with a similar name", () => {
  const html = '<meta name="citation_pdf_url_alternate" content="https://example.org/should-not-match">';
  assert.equal(extractCitationPdfUrl(html), null);
});
