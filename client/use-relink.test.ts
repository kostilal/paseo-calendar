import { test } from "node:test";
import assert from "node:assert/strict";
import type { SettingsView } from "../shared/calendar.ts";
import { landRelink } from "./use-relink.ts";

function fakeCache() {
  const written: { key: readonly unknown[]; data: SettingsView }[] = [];
  const invalidated: string[] = [];
  return {
    written,
    invalidated,
    setQueryData(key: readonly unknown[], data: SettingsView) {
      written.push({ key, data });
    },
    async invalidateQueries(filters: { queryKey: readonly unknown[] }) {
      invalidated.push(filters.queryKey.join("/"));
    },
  };
}

const view = { accounts: [], access: "granted", pillLeadMinutes: 30, defaultView: "day", connect: null, found: [], foundFailed: false, storeBroken: false, storeAside: "", accessError: "" } satisfies SettingsView;

test("a relink that moved the row writes its settings and reads the events again", () => {
  const cache = fakeCache();
  landRelink(cache, { error: "", settings: view });
  assert.deepEqual(cache.written, [{ key: ["calendar", "settings"], data: view }]);
  assert.deepEqual(cache.invalidated, ["calendar/events", "calendar/range"]);
});

test("a refused relink reads the settings again, so the stale offer does not invite another tap", () => {
  const cache = fakeCache();
  landRelink(cache, { error: "that account is no longer the one this row moved to", settings: null });
  assert.deepEqual(cache.written, []);
  assert.deepEqual(cache.invalidated, ["calendar/settings"], "nothing moved, so the events stay as read");
});

test("a relink that never got an answer reads the settings again too", () => {
  const cache = fakeCache();
  landRelink(cache, undefined);
  assert.deepEqual(cache.written, []);
  assert.deepEqual(cache.invalidated, ["calendar/settings"]);
});
