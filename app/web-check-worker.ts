/// <reference lib="webworker" />

import { runWikipediaCheck } from "@/lib/wikipedia-check";

type WebCheckRequest = {
  id: number;
  text: string;
  title?: string;
  count?: number;
};

self.addEventListener("message", async (event: MessageEvent<WebCheckRequest>) => {
  const { id, text, title, count } = event.data;
  try {
    const result = await runWikipediaCheck(text, {
      count,
      submissionTitle: title,
      onProgress: (current, total, label) => {
        self.postMessage({ id, type: "progress", current, total, label });
      },
    });
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Wikipedia check failed.",
    });
  }
});

export {};
