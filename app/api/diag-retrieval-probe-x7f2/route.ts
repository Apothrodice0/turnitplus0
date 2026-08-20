import { NextResponse } from 'next/server';
import { createHttpContentRetriever } from '../../../lib/http-content-retriever';

/**
 * TEMPORARY diagnostic-only endpoint. Not part of the product. Added to
 * capture the exact, authoritative hop-by-hop outcome of the academic
 * content retriever running in the real Vercel production runtime, for two
 * real candidate URLs, after production reported COMPLETE_NO_MATCHES for
 * documents that succeed locally. To be deleted once that investigation is
 * done — see the commit that adds this file.
 *
 * Deliberately reuses lib/http-content-retriever.ts's own
 * createHttpContentRetriever() — same allowedContentTypes as
 * lib/academic-search/text-retriever.ts's createAcademicSearchContentRetriever(),
 * same default timeout/size/safety config, same real fetch() calls with the
 * same real User-Agent header the retriever itself sets — only the
 * `fetcher` injection point (already existing, test-only elsewhere) is used
 * here to observe each hop without altering any request the retriever
 * makes. No retry logic is added; a failing hop is reported exactly as the
 * retriever produced it.
 *
 * Gated on a header secret read from process.env.DIAG_PROBE_SECRET (never
 * hardcoded, never logged, never a query param) so this cannot be
 * discovered or hit as public infrastructure while it exists; requests
 * without the correct header — including when the env var itself is unset
 * — get a plain 404, identical to a route that does not exist.
 */

const TARGET_URLS = [
  'https://doi.org/10.1016/j.ihe.2014.04.001',
  'https://doi.org/10.46298/jodakiss.15337',
];

type HopLogEntry = {
  url: string;
  status?: number;
  contentType?: string | null;
  location?: string | null;
  elapsedMs: number;
  byteLength?: number | 'unreadable' | null;
  error?: string;
};

function makeDiagnosticFetcher(log: HopLogEntry[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = Date.now();
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      log.push({ url: String(input), elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const elapsedMs = Date.now() - start;
    const entry: HopLogEntry = {
      url: String(input),
      status: response.status,
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      elapsedMs,
      byteLength: null,
    };
    log.push(entry);
    try {
      const bytes = await response.clone().arrayBuffer();
      entry.byteLength = bytes.byteLength;
    } catch {
      entry.byteLength = 'unreadable';
    }
    return response;
  }) as typeof fetch;
}

export async function GET(request: Request) {
  const expected = process.env.DIAG_PROBE_SECRET;
  const provided = request.headers.get('x-diag-secret');
  if (!expected || provided !== expected) {
    return new NextResponse('Not found', { status: 404 });
  }

  const results = [];
  for (const url of TARGET_URLS) {
    const log: HopLogEntry[] = [];
    const retriever = createHttpContentRetriever({
      allowedContentTypes: ['text/html', 'application/pdf'],
      fetcher: makeDiagnosticFetcher(log),
    });
    const start = Date.now();
    const retrieval = await retriever.retrieve({ url });
    const totalElapsedMs = Date.now() - start;
    results.push({
      url,
      hops: log,
      finalStatus: retrieval.status,
      finalUrl: retrieval.finalUrl,
      httpStatus: retrieval.httpStatus,
      contentType: retrieval.contentType,
      errorMessage: retrieval.errorMessage,
      extractedTextLength: retrieval.extractedText?.length ?? 0,
      totalElapsedMs,
    });
  }

  return NextResponse.json({
    results,
    runtime: {
      region: process.env.VERCEL_REGION ?? null,
      vercelEnv: process.env.VERCEL_ENV ?? null,
    },
  });
}
