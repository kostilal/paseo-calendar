import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
// Node's own URL: with the DOM lib in tsconfig, the global one is not a path readFileSync takes.
import { URL } from "node:url";

const ROOT = new URL("..", import.meta.url);

test("the overview follows the registry's listing rules and says what it reads and where it goes", () => {
  const overview = readFileSync(new URL("OVERVIEW.md", ROOT), "utf8");
  assert.doesNotMatch(overview, /paseo plugin add|npm install|npm i\b/); // the publication validator rejects these
  assert.doesNotMatch(overview, /^#{1,6}\s*(install|installation|license|contributing|changelog)\b/im);
  for (const fact of ["~/.jobby-jobs/calendar.json", "JobbyJobs Calendar Helper", "Xcode Command Line Tools", "God Mode", "OpenAI"])
    assert.ok(overview.includes(fact), fact);
});

test("no file carries a real person's address", () => {
  // docs/superpowers/ and .superpowers/ are local working notes, never published, so they are
  // the only places a real address may appear.
  const allowed = /^(?:[^@\s]+@(?:example\.(?:com|org|net)|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.example|shop\.example\.co\.uk|users\.noreply\.github\.com)|someone@gmail\.com)$/i;
  const found: string[] = [];
  const walk = (dir: URL, rel: string) => {
    for (const name of readdirSync(dir)) {
      const path = rel ? `${rel}/${name}` : name;
      if (["node_modules", ".git", ".superpowers", "package-lock.json"].includes(name) || path === "docs/superpowers") continue;
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) { walk(new URL(`${name}/`, dir), path); continue; }
      for (const [address] of readFileSync(url, "utf8").matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g))
        if (!allowed.test(address)) found.push(`${path}: ${address}`);
    }
  };
  walk(ROOT, "");
  assert.deepEqual(found, []);
});
