import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login/signup drives its loading UI from a real request, not a fixed timer", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /const \[isAuthenticating, setIsAuthenticating\] = useState\(false\)/);
  assert.match(page, /if \(isAuthenticating\) return/);

  // The request actually gates the loading state — not a setTimeout chain.
  assert.match(page, /fetch\(completedMode === "login" \? "\/api\/auth\/login" : "\/api\/auth\/signup"/);
  assert.match(page, /const minimumAuthMs = 1_800/);
  assert.match(page, /window\.setInterval\(\(\) => \{[\s\S]*?setAuthProgress/);

  // On failure the loading UI must stop and surface the server's message,
  // not silently navigate to "welcome" the way the old fake flow always did.
  assert.match(page, /setAuthError/);
  assert.match(page, /if \(!response\.ok \|\| !data\?\.user\)/);

  // The loading UI itself (stage labels, ring, progress bar) is preserved.
  assert.match(page, /Preparing your private workspace/);
  assert.match(page, /Loading your report history/);
  assert.match(page, /Almost ready/);
  assert.match(page, /role="status"/);
  assert.match(page, /disabled=\{isAuthenticating\}/);
  assert.match(styles, /\.auth-loading-ring/);
  assert.match(styles, /@keyframes auth-ring-spin/);
  assert.match(styles, /\.auth-loading-progress span/);
});

test("signup/login send the device key so anonymous reports can be claimed", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ getDeviceKey \} from "@\/lib\/device-key";/);
  assert.match(page, /deviceKey: getDeviceKey\(\)/);
});
