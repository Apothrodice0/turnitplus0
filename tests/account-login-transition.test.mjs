import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login uses a five-second locked progress transition", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /const \[isAuthenticating, setIsAuthenticating\] = useState\(false\)/);
  assert.match(page, /if \(isAuthenticating\) return/);
  assert.match(page, /await pause\(1200\)[\s\S]*await pause\(1300\)[\s\S]*await pause\(1300\)[\s\S]*await pause\(1200\)/);
  assert.match(page, /Signing you in/);
  assert.match(page, /Preparing your private workspace/);
  assert.match(page, /Loading your report history/);
  assert.match(page, /role="status"/);
  assert.match(page, /disabled=\{isAuthenticating\}/);
  assert.match(styles, /\.auth-loading-ring/);
  assert.match(styles, /@keyframes auth-ring-spin/);
  assert.match(styles, /\.auth-loading-progress span/);
});
