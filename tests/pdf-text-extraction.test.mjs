import assert from "node:assert/strict";
import test from "node:test";
import { extractPdfTextDocument } from "../lib/pdf-text-extraction.ts";

test("shared PDF text extraction preserves page order and browser spacing", async () => {
  const progress = [];
  const document = {
    numPages: 2,
    async getPage(pageNumber) {
      return {
        async getTextContent() {
          return pageNumber === 1
            ? { items: [{ str: "First" }, { str: "page" }, { type: "marker" }] }
            : { items: [{ str: "Second" }, { str: "page" }] };
        },
      };
    },
  };

  const text = await extractPdfTextDocument(document, (page, total) => progress.push([page, total]));
  assert.equal(text, "First page \n\nSecond page\n\n");
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});
