import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Corpus Engine v1 — shared plumbing for the checkpoint scripts.
 *
 * These scripts are engineering tooling: they build and measure a local
 * corpus on D:. They never touch a database, a Blob store, Production or
 * Preview, and none of them is imported by the application.
 */

/** `--name value` and bare `--flag` arguments. */
export function parseArguments(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) result[token.slice(2)] = "true";
    else {
      result[token.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

export function requireArgument(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (value === undefined || value === "true") throw new Error(`missing required argument --${name}`);
  return value;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** JSON with bigints as decimal strings (the document-id JSON contract). */
export function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString(10) : item), 2)}\n`);
}

/** Nearest-rank percentile of an unsorted sample; NaN for an empty one. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((total, value) => total + value, 0) / values.length;
}

export function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** mulberry32 — the deterministic PRNG every generated artifact of the checkpoint uses. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

export function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function logLine(message: string) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}
