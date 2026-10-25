import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Node's own URL: with the DOM lib in tsconfig, the global one is not a path readFileSync takes.
import { URL } from "node:url";

// Read as text rather than imported, since tsconfig has no resolveJsonModule.
const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("the manifest says what the plugin is in one sentence and asks for the Paseo the code needs", () => {
  assert.equal(manifest.id, "calendar");
  assert.equal(manifest.description, "Every calendar on this Mac on one board, a composer pill before the next meeting, and one tap to join.");
  assert.deepEqual(manifest.requirements, { paseo: ">=0.8.0" }); // measured by typechecking against SDK 0.8.0 to 0.13.0; see the README's Requirements
  // name, icon and media make a daemon older than 0.11.0 refuse the install (Paseo's manifest reference).
  for (const key of ["name", "icon", "media"]) assert.ok(!(key in manifest), key);
});
