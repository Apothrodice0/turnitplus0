import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceDocumentFromText } from '../../lib/corpus-engine/source-adapter.ts';

/**
 * Shared fixtures for the Corpus Engine tests: a scratch directory and
 * deterministic synthetic text. Nothing here reads a real corpus.
 *
 * Scratch space is TURNITPLUS_TEST_TMP when set, else D:\tmp\turnitplus-tests
 * when that exists (this project keeps test artifacts off the system drive),
 * else the OS temp directory.
 */

export function corpusEngineScratch(name) {
  const base = process.env.TURNITPLUS_TEST_TMP
    ?? (fs.existsSync('D:/tmp/turnitplus-tests') ? 'D:/tmp/turnitplus-tests' : os.tmpdir());
  const directory = path.join(base, `corpus-engine-${name}-${process.pid}`);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function removeScratch(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** mulberry32 — a small deterministic PRNG. */
export function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSETS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'br', 'dr', 'kl', 'st', 'tr', 'pl'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ou'];

/** A pronounceable invented word of at least five letters (so every 5-gram of them is "informative"). */
function inventedWord(random) {
  let word = '';
  const syllables = 3 + Math.floor(random() * 2);
  for (let index = 0; index < syllables; index += 1) {
    word += ONSETS[Math.floor(random() * ONSETS.length)] + VOWELS[Math.floor(random() * VOWELS.length)];
  }
  return word;
}

/** `wordCount` invented words; two different seeds share no 5-gram in practice. */
export function inventedText(seed, wordCount) {
  const random = prng(seed);
  const words = [];
  for (let index = 0; index < wordCount; index += 1) words.push(inventedWord(random));
  return words.join(' ');
}

export function wordsOf(text) {
  return text.split(/\s+/).filter(Boolean);
}

export function sliceWords(text, start, count) {
  return wordsOf(text).slice(start, start + count).join(' ');
}

/** A source document with the given text; every provenance field the test does not set is null. */
export function fixtureSource(externalId, text, fields = {}) {
  return sourceDocumentFromText({ provider: 'fixture-provider', dataset: 'fixture-set', externalId, text, sourceType: 'fixture', ...fields });
}

/** Flips one byte of a file in place and returns a function that restores it. */
export function flipByte(file, offset) {
  const descriptor = fs.openSync(file, 'r+');
  const byte = Buffer.alloc(1);
  fs.readSync(descriptor, byte, 0, 1, offset);
  const original = byte[0];
  byte[0] = original ^ 0x5a;
  fs.writeSync(descriptor, byte, 0, 1, offset);
  fs.closeSync(descriptor);
  return () => {
    const restore = fs.openSync(file, 'r+');
    fs.writeSync(restore, Buffer.from([original]), 0, 1, offset);
    fs.closeSync(restore);
  };
}

/** sha256 of every file under a directory, keyed by relative path — for byte-for-byte comparisons. */
export function hashTree(directory) {
  const result = {};
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else result[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(directory, '');
  return result;
}
