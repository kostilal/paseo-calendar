// Pinned away from Warsaw, the zone the fixtures use, so a test of the default
// zone cannot pass by coincidence.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SettingsView } from "../shared/calendar.ts";
import { readSchedule, type ScheduleSync } from "./schedule.ts";

const SETTINGS: SettingsView = {
  accounts: [{ id: "ex", sourceId: "s", title: "Exchange", owner: "", kind: "exchange", calendars: [], lastSyncAt: "", lastError: "", errorCode: "", missingSince: "", relinkTo: null }],
  access: "granted",
  pillLeadMinutes: 10,
  defaultView: "agenda",
  connect: null,
  found: [],
  foundFailed: false,
  storeBroken: false,
  storeAside: "",
  accessError: "",
};

function fakeSync() {
  const ranges: [string, string][] = [];
  const sync: ScheduleSync = {
    range: async (from, to) => {
      ranges.push([from.toISOString(), to.toISOString()]);
      return { events: [], clashes: [], syncedAt: new Date(Date.parse("2026-10-21T08:00:00.000Z")).toISOString(), errors: [], version: "", unchanged: false };
    },
    settings: async () => SETTINGS,
  };
  return { sync, ranges };
}

const INPUT = { date: "", from: "", to: "", time_zone: "", with_links: false, include_declined: false };

test("the asked day is what range() is asked for, midnight to midnight in the asked zone", async () => {
  const { sync, ranges } = fakeSync();
  await readSchedule(sync, { ...INPUT, time_zone: "Europe/Warsaw" }, Date.parse("2026-10-21T08:00:00.000Z"));
  await readSchedule(sync, { ...INPUT, date: "tomorrow", time_zone: "Europe/Warsaw" }, Date.parse("2026-10-21T08:00:00.000Z"));
  assert.deepEqual(ranges, [
    ["2026-10-20T22:00:00.000Z", "2026-10-21T22:00:00.000Z"],
    ["2026-10-21T22:00:00.000Z", "2026-10-22T22:00:00.000Z"],
  ]);
});

test("an empty zone means the Mac's own zone, not Warsaw", async () => {
  const { sync, ranges } = fakeSync();
  const result = await readSchedule(sync, INPUT, Date.parse("2026-10-21T08:00:00.000Z"));
  assert.equal(result.time_zone, "America/New_York");
  assert.deepEqual(ranges, [["2026-10-21T04:00:00.000Z", "2026-10-22T04:00:00.000Z"]]);
});

test("an account with every calendar hidden is not read, so it covers no failure of the same mailbox", async () => {
  const account = SETTINGS.accounts[0];
  const settings: SettingsView = {
    ...SETTINGS,
    accounts: [
      { ...account, id: "a", sourceId: "s-a", owner: "me@corp.example", calendars: [{ id: "c-a", name: "Calendar", shown: true }] },
      { ...account, id: "b", sourceId: "s-b", owner: "me@corp.example", calendars: [{ id: "c-b", name: "Calendar", shown: false }] },
    ],
  };
  const sync: ScheduleSync = {
    range: async () => ({
      events: [],
      clashes: [],
      syncedAt: "2026-10-21T08:00:00.000Z",
      errors: [{ accountId: "a", message: "boom", code: "helper_failed" }],
      version: "",
      unchanged: false,
    }),
    settings: async () => settings,
  };
  const result = await readSchedule(sync, { ...INPUT, time_zone: "Europe/Warsaw" }, Date.parse("2026-10-21T08:00:00.000Z"));
  assert.deepEqual(result.sources.map((source) => [source.ok, source.covered]), [[false, undefined], [true, undefined]]);
  assert.match(result.summary, /Not read: me@corp\.example \(boom\)/);
});

test("a bad zone or date is refused in the answer, before anything is read", async () => {
  const { sync, ranges } = fakeSync();
  const zone = await readSchedule(sync, { ...INPUT, time_zone: "Mars/Olympus" }, Date.now());
  assert.match(zone.error, /unknown time zone/);
  const date = await readSchedule(sync, { ...INPUT, date: "someday" }, Date.now());
  assert.match(date.error, /date takes/);
  assert.deepEqual(ranges, []);
});
