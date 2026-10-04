import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_POSITIONS_FORMAT,
  COMPACT_POSITIONS_FORMAT_VERSION,
  MAX_COMPACT_POSITION_COUNT,
  compactPositionsForPersistence,
  expandPositionsFromPersistence,
  isCompactPositions,
  isFormatMarkedPositions,
} from "../lib/position-runs-persistence.ts";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "../lib/report-transport-limits.ts";
import { tokens } from "../lib/similarity-core.ts";
import { runWithScoringNormalization } from "../lib/scoring-normalization-scope.ts";

/**
 * The compact (run-length) persisted form of a matched-word position array.
 *
 * What must hold for it to be allowed anywhere near a score:
 *   EXACT       expand(compact(x)) is x — the same numbers in the same order — for every array it accepts;
 *   NEVER LOSSY an array it cannot represent exactly is returned untouched (the same reference), never altered;
 *   FAIL CLOSED a compact value that is unknown, damaged or inconsistent is `unreadable`, never a shorter or guessed array;
 *   BOUNDED     a damaged value cannot make a reader allocate more than it declares, and never more than a report can hold.
 */

const compact = (count, runs, extra = {}) => ({ format: COMPACT_POSITIONS_FORMAT, formatVersion: COMPACT_POSITIONS_FORMAT_VERSION, count, runs, ...extra });
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
/** Sorted union of inclusive [start, end] ranges — how a scorer's union of overlapping source passages comes out. */
function unionOf(ranges) {
  const set = new Set();
  for (const [start, end] of ranges) for (let p = start; p <= end; p += 1) set.add(p);
  return [...set].sort((a, b) => a - b);
}
/** deepEqual for a long position list that fails FAST, naming the first difference (assert's own diff of a 300,000-element array takes minutes to render). */
function assertSamePositions(actual, expected, message = "positions") {
  assert.ok(Array.isArray(actual), message + ": an array");
  for (let i = 0; i < Math.min(actual.length, expected.length); i += 1) {
    if (actual[i] !== expected[i]) assert.fail(message + ": first difference at index " + i + ": " + actual[i] + " !== " + expected[i]);
  }
  assert.equal(actual.length, expected.length, message + ": length");
}
/** The persisted value is the compact form with exactly this count and these runs (the shape is checked first, so a failure never has to render a huge array). */
function assertCompact(persisted, count, runs, message = "persisted value") {
  assert.ok(isCompactPositions(persisted), message + ": persisted in the compact form");
  assert.deepEqual(persisted, compact(count, runs), message);
}
function assertUnreadable(value, reason, message) {
  const expansion = expandPositionsFromPersistence(value);
  assert.equal(expansion.status, "unreadable", message);
  assert.equal(expansion.reason, reason, message);
}
function roundTrip(positions) {
  const persisted = compactPositionsForPersistence(positions);
  const viaJson = JSON.parse(JSON.stringify(persisted));
  const expansion = expandPositionsFromPersistence(viaJson);
  assert.equal(expansion.status, "expanded");
  assertSamePositions(expansion.value, positions);
  return persisted;
}

test("FORMAT: maximal runs as flat `gap, length` pairs from a cursor at 0, with the position count", () => {
  assertCompact(compactPositionsForPersistence(range(0, 99)), 100, [0, 100]);
  assertCompact(compactPositionsForPersistence([...range(3, 40), ...range(43, 43), ...range(50, 90)]), 80, [3, 38, 2, 1, 6, 41]);
  // the doc example, as an explicit value (too short for the writer to choose it — see the size rule below)
  assert.deepEqual(expandPositionsFromPersistence(compact(5, [3, 4, 3, 1])), { status: "expanded", value: [3, 4, 5, 6, 10] });
});

test("EXACT: every subset of a 12-word document round-trips, compact or not", () => {
  for (let mask = 0; mask < 1 << 12; mask += 1) {
    const positions = [];
    for (let bit = 0; bit < 12; bit += 1) if (mask & (1 << bit)) positions.push(bit);
    roundTrip(positions);
  }
});

test("EXACT: overlapping ranges, adjacent ranges, and many sources sharing the same positions collapse to the same union the array held", () => {
  const overlapping = unionOf([[100, 180], [150, 260], [255, 300], [1000, 1040]]);
  assertCompact(roundTrip(overlapping), overlapping.length, [100, 201, 699, 41]);

  // [10..59] then [60..129]: adjacent, so ONE run — the canonical form never splits a contiguous stretch
  const adjacent = unionOf([[10, 59], [60, 129], [131, 200]]);
  assertCompact(roundTrip(adjacent), adjacent.length, [10, 120, 1, 70]);

  // 480 sources each crediting one of 12 shared 40-word slices: the union is 12 runs, however many sources share them
  const shared = unionOf(Array.from({ length: 480 }, (_, source) => [200 + (source % 12) * 60, 239 + (source % 12) * 60]));
  const persisted = roundTrip(shared);
  assert.ok(isCompactPositions(persisted));
  assert.equal(persisted.count, 12 * 40);
  assert.equal(persisted.runs.length, 24);
});

test("EXACT: ten displayed passages plus additional ranges (a source's 11th+ passages) keep every credited position", () => {
  const displayed = Array.from({ length: 10 }, (_, i) => [i * 500, i * 500 + 89]);
  const additional = Array.from({ length: 7 }, (_, i) => [5200 + i * 300, 5200 + i * 300 + 44]);
  const positions = unionOf([...displayed, ...additional]);
  const persisted = roundTrip(positions);
  assert.ok(isCompactPositions(persisted));
  assert.equal(persisted.count, 10 * 90 + 7 * 45);
  assert.equal(persisted.runs.length, 2 * 17);
});

test("EXACT: large token indexes — the end of the largest possible document, and far beyond 32 bits", () => {
  roundTrip(range(MAX_REPORT_SAVE_REQUEST_BYTES - 500, MAX_REPORT_SAVE_REQUEST_BYTES - 1));
  roundTrip([...range(0, 40), ...range(1_999_000, 1_999_400)]);
  const beyond32 = [...range(2 ** 33, 2 ** 33 + 60), ...range(2 ** 40 + 7, 2 ** 40 + 90)];
  assertCompact(roundTrip(beyond32), 145, [2 ** 33, 61, 2 ** 40 + 7 - (2 ** 33 + 61), 84]);
  const top = range(Number.MAX_SAFE_INTEGER - 64, Number.MAX_SAFE_INTEGER - 1);
  roundTrip(top);
  // a run that would END past the safe-integer range is not representable exactly: left as the array
  const overflowing = range(Number.MAX_SAFE_INTEGER - 63, Number.MAX_SAFE_INTEGER);
  assert.equal(compactPositionsForPersistence(overflowing), overflowing);
});

test("EXACT: a full-document match of a 300,000-word document is one run, and a fragmented one is still exact", () => {
  const whole = range(0, 299_999);
  const persisted = roundTrip(whole);
  assertCompact(persisted, 300_000, [0, 300_000]);
  assert.ok(JSON.stringify(persisted).length < 80, "a whole-document match costs a few dozen characters, not ~2 MB");

  // 5 matched / 1 unmatched, the densest fragmentation a 5-word shingle can produce
  const fragmented = [];
  for (let start = 0; start + 5 <= 120_000; start += 6) for (let p = start; p < start + 5; p += 1) fragmented.push(p);
  const compactFragmented = roundTrip(fragmented);
  assert.ok(JSON.stringify(compactFragmented).length * 5 < JSON.stringify(fragmented).length, "even the densest fragmentation is several times smaller");
});

test("EXACT: multilingual manuscripts under both scoring-normalization contracts — positions are plain word indexes of that contract's own token sequence", () => {
  const manuscript = [
    "The court reviewed the constitutional framework. المحكمة الدستورية تراجع القوانين الأساسية للدولة.",
    "法院审查了宪法框架和基本法律。 Le tribunal examine le cadre constitutionnel français.",
    "ﬁnal ligature test with soft­hyphen and zero​width join, Ａｌｐｈａ full-width, naïve café.",
  ].join(" ").repeat(40);
  for (const version of [1, 2]) {
    runWithScoringNormalization(version, () => {
      const wordCount = tokens(manuscript).length;
      assert.ok(wordCount > 500);
      // every third 9-word window, the whole document, and the last word
      const windows = [];
      for (let start = 0; start + 9 <= wordCount; start += 27) for (let p = start; p < start + 9; p += 1) windows.push(p);
      roundTrip(windows);
      roundTrip(range(0, wordCount - 1));
      roundTrip([...range(0, 30), wordCount - 1]);
    });
  }
});

test("EXACT: deterministic pseudo-random arrays of every density", () => {
  let seed = 20261004;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const density of [0.01, 0.2, 0.5, 0.8, 0.99]) {
    const positions = [];
    for (let p = 0; p < 60_000; p += 1) if (next() < density) positions.push(p);
    roundTrip(positions);
  }
});

test("SIZE RULE: the compact form is used only when it is smaller as JSON; otherwise the very same array is returned", () => {
  const empty = [];
  assert.equal(compactPositionsForPersistence(empty), empty);
  const tiny = [3, 4, 5, 6, 10];
  assert.equal(compactPositionsForPersistence(tiny), tiny, "the marker outweighs a five-position array");
  const isolated = Array.from({ length: 40 }, (_, i) => i * 2);
  const persisted = compactPositionsForPersistence(isolated);
  assert.ok(JSON.stringify(persisted).length <= JSON.stringify(isolated).length, "whatever is chosen is never larger than the array");
  const worthwhile = range(1000, 1100);
  assert.ok(isCompactPositions(compactPositionsForPersistence(worthwhile)));
});

test("NEVER LOSSY: an array that is not strictly ascending non-negative safe integers is returned untouched (the same reference)", () => {
  const unrepresentable = {
    unsorted: [...range(50, 120), ...range(0, 40)],
    duplicate: [...range(0, 60), 60, ...range(61, 120)],
    descendingTail: [...range(0, 100), 99],
    negative: [-1, ...range(0, 100)],
    fractional: [...range(0, 100), 100.5],
    nan: [...range(0, 100), Number.NaN],
    infinite: [...range(0, 100), Number.POSITIVE_INFINITY],
    stringMember: [...range(0, 100), "101"],
    nullMember: [...range(0, 100), null],
    unsafeInteger: [...range(0, 100), 2 ** 53],
  };
  for (const [name, positions] of Object.entries(unrepresentable)) {
    const before = JSON.stringify(positions);
    assert.equal(compactPositionsForPersistence(positions), positions, `${name}: persisted as it was`);
    assert.equal(JSON.stringify(positions), before, `${name}: not mutated`);
  }
  // a sparse array is not a position list either
  const sparse = range(0, 100);
  delete sparse[40];
  assert.equal(compactPositionsForPersistence(sparse), sparse);
  // not an array at all
  for (const value of [undefined, null, "0,1,2", 7, { 0: 1 }]) assert.equal(compactPositionsForPersistence(value), value);
});

test("NEVER LOSSY: the input array is never mutated and the result shares nothing mutable with it", () => {
  const positions = range(10, 400);
  const snapshot = [...positions];
  const persisted = compactPositionsForPersistence(positions);
  assert.deepEqual(positions, snapshot);
  const expanded = expandPositionsFromPersistence(persisted).value;
  expanded[0] = -999;
  assert.deepEqual(positions, snapshot);
  assertSamePositions(expandPositionsFromPersistence(persisted).value, snapshot, "each expansion is a fresh array");
});

test("BOUNDED: an array longer than a report can hold is not compacted, and a compact value declaring more is unreadable", () => {
  assert.equal(MAX_COMPACT_POSITION_COUNT, MAX_REPORT_SAVE_REQUEST_BYTES);
  const atLimit = range(0, MAX_COMPACT_POSITION_COUNT - 1);
  assertCompact(compactPositionsForPersistence(atLimit), MAX_COMPACT_POSITION_COUNT, [0, MAX_COMPACT_POSITION_COUNT]);
  const overLimit = range(0, MAX_COMPACT_POSITION_COUNT);
  assert.equal(compactPositionsForPersistence(overLimit), overLimit);
  assertUnreadable(compact(MAX_COMPACT_POSITION_COUNT + 1, [0, MAX_COMPACT_POSITION_COUNT + 1]), "MALFORMED", "one more than a report can hold");
});

test("LEGACY: a plain array is returned as it is — the same reference, unvalidated, exactly as before the codec existed", () => {
  for (const legacy of [[], [0, 1, 2], [5, 3, 3, -1], range(0, 5000)]) {
    const expansion = expandPositionsFromPersistence(legacy);
    assert.equal(expansion.status, "expanded");
    assert.equal(expansion.value, legacy);
  }
});

test("FAIL CLOSED: an unknown version, a damaged table or an inconsistent count is unreadable — never a shorter or guessed array", () => {
  const cases = [
    ["a newer format version", compact(3, [0, 3], { formatVersion: 2 }), "UNSUPPORTED_FORMAT_VERSION"],
    ["no format version", { format: "compact", count: 3, runs: [0, 3] }, "UNSUPPORTED_FORMAT_VERSION"],
    ["another compact family", { format: "delta-v9", count: 3, runs: [0, 3] }, "UNSUPPORTED_FORMAT"],
    ["runs missing", { format: "compact", formatVersion: 1, count: 3 }, "MALFORMED"],
    ["runs not an array", compact(3, "0,3"), "MALFORMED"],
    ["an unpaired run entry", compact(3, [0, 3, 5]), "MALFORMED"],
    ["count missing", { format: "compact", formatVersion: 1, runs: [0, 3] }, "MALFORMED"],
    ["count negative", compact(-1, []), "MALFORMED"],
    ["count fractional", compact(2.5, [0, 3]), "MALFORMED"],
    ["count a string", compact("3", [0, 3]), "MALFORMED"],
    ["a zero-length run", compact(3, [0, 3, 4, 0]), "BAD_RUN"],
    ["a negative gap", compact(6, [0, 3, -1, 3]), "BAD_RUN"],
    ["a negative length", compact(3, [0, -3]), "BAD_RUN"],
    ["a fractional gap", compact(3, [0.5, 3]), "BAD_RUN"],
    ["a fractional length", compact(3, [0, 3.5]), "BAD_RUN"],
    ["a string entry", compact(3, ["0", 3]), "BAD_RUN"],
    ["a null entry", compact(3, [0, null]), "BAD_RUN"],
    ["a NaN entry (JSON null)", JSON.parse(JSON.stringify(compact(3, [0, Number.NaN]))), "BAD_RUN"],
    ["two runs that touch (gap 0) — not the canonical form", compact(6, [0, 3, 0, 3]), "NON_CANONICAL"],
    ["fewer positions than declared", compact(10, [0, 3, 2, 4]), "COUNT_MISMATCH"],
    ["more positions than declared", compact(5, [0, 3, 2, 4]), "COUNT_MISMATCH"],
    ["declared count with no runs", compact(4, []), "COUNT_MISMATCH"],
    ["positions past the safe-integer range", compact(4, [Number.MAX_SAFE_INTEGER - 1, 4]), "BAD_RUN"],
  ];
  for (const [name, value, reason] of cases) {
    assertUnreadable(value, reason, name);
  }
  // an empty compact list is self-consistent (the writer never produces it — an empty array stays an array)
  assert.deepEqual(expandPositionsFromPersistence(compact(0, [])), { status: "expanded", value: [] });
  // not an array, not a marked object
  for (const value of [undefined, null, 5, "[0,1]", { count: 3, runs: [0, 3] }]) {
    assertUnreadable(value, "MALFORMED", "not a position list at all");
  }
});

test("FAIL CLOSED WITHOUT WORK: a tiny damaged value that claims an enormous run is refused before anything is allocated", () => {
  const started = performance.now();
  for (const value of [
    compact(10, [0, Number.MAX_SAFE_INTEGER]),
    compact(10, [0, 1_000_000_000_000]),
    compact(MAX_COMPACT_POSITION_COUNT, [0, MAX_COMPACT_POSITION_COUNT + 1]),
    compact(Number.MAX_SAFE_INTEGER, [0, Number.MAX_SAFE_INTEGER]),
  ]) {
    assert.equal(expandPositionsFromPersistence(value).status, "unreadable");
  }
  assert.ok(performance.now() - started < 250, "refusing them costs nothing");
});

test("MARKERS: a compact value is recognised by its `format` key; arrays and unmarked objects are not", () => {
  assert.equal(isCompactPositions(compact(1, [0, 1])), true);
  assert.equal(isFormatMarkedPositions(compact(1, [0, 1])), true);
  assert.equal(isCompactPositions({ format: "something-newer" }), false);
  assert.equal(isFormatMarkedPositions({ format: "something-newer" }), true, "a later family is still marked — a reader must refuse it, not treat it as legacy");
  for (const value of [[0, 1], [], undefined, null, 3, "compact", { count: 1, runs: [0, 1] }]) {
    assert.equal(isCompactPositions(value), false);
    assert.equal(isFormatMarkedPositions(value), false);
  }
});

test("DETERMINISTIC: the same positions always produce the same bytes, and the compact form is plain JSON", () => {
  const positions = unionOf([[12, 400], [900, 1200], [5000, 5005]]);
  const a = JSON.stringify(compactPositionsForPersistence(positions));
  const b = JSON.stringify(compactPositionsForPersistence([...positions]));
  assert.equal(a, b);
  assert.equal(a, '{"format":"compact","formatVersion":1,"count":696,"runs":[12,389,499,301,3799,6]}');
});
