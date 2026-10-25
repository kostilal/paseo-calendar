import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Area = "client" | "server" | "shared";

/**
 * What Paseo hands each side at run time. A git install has no node_modules, so anything else
 * fails to build there even when it typechecks here.
 *
 * Two are left out on purpose. `@getpaseo/plugin/client/ui` has `Icon`, `Modal` and `TextInput`
 * only from 0.13 on (through 0.12 it exports the Settings components alone), and the manifest
 * asks for 0.8; the UI keeps coming from `/client/react-native`. `@getpaseo/client` is a peer of
 * the SDK, installed here for its types, and even a type import from it breaks a git install.
 */
const ALLOWED: Record<Area, (specifier: string) => boolean> = {
  client: (specifier) =>
    [
      "@getpaseo/plugin",
      "@getpaseo/plugin/client",
      "@getpaseo/plugin/client/react-native",
      "@tanstack/react-query",
      "react",
      "react/jsx-runtime",
      "react-native",
      "zod",
    ].includes(specifier),
  server: (specifier) =>
    ["@getpaseo/plugin", "@getpaseo/plugin/server", "zod"].includes(specifier) || specifier.startsWith("node:"),
  shared: (specifier) => ["@getpaseo/plugin", "zod"].includes(specifier),
};

/** Where a relative import from each area may land: its own directory, or shared/. */
const REACHES: Record<Area, Area[]> = { client: ["client", "shared"], server: ["server", "shared"], shared: ["shared"] };

const PATTERNS = [
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gms,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

function sources(): { path: string; area: Area }[] {
  return [
    ...(["client", "server", "shared"] as const).flatMap((area) => walk(join(ROOT, area)).map((path) => ({ path, area }))),
    { path: join(ROOT, "index.client.tsx"), area: "client" as const },
    { path: join(ROOT, "index.server.ts"), area: "server" as const },
  ];
}

/**
 * Template literals are emptied first. eventkit.swift.ts carries the helper's Swift source in one,
 * and from its `import EventKit` the first pattern would run on to a quoted word further down.
 */
function specifiersOf(text: string): string[] {
  const code = text.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
  return PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
}

test("every import is a module Paseo hosts on that side, so a git install builds", () => {
  const files = sources();
  assert.ok(files.length > 20, "the walk found the plugin's files");
  const wrong: string[] = [];
  for (const { path, area } of files) {
    const name = relative(ROOT, path);
    for (const specifier of specifiersOf(readFileSync(path, "utf8"))) {
      if (specifier.startsWith(".")) {
        const landsIn = relative(ROOT, resolve(dirname(path), specifier)).split(sep)[0];
        if (!REACHES[area].includes(landsIn as Area)) wrong.push(`${name}: ${specifier} (reaches ${landsIn})`);
      } else if (!ALLOWED[area](specifier)) {
        wrong.push(`${name}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});
