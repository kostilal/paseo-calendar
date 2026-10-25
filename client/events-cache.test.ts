import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventsView, EventView } from "../shared/calendar.ts";
import { keepUnchanged, providerPassDue, sinceOf } from "./events-cache.ts";

const standup: EventView = {
  id: "evt-1", accountId: "acc", calendarId: "c", calendarName: "Work", title: "Standup",
  start: "2026-10-26T09:30:00.000Z", end: "2026-10-26T10:00:00.000Z", allDay: false,
  recurring: false, mine: true, attendees: [], location: "", description: "", webLink: "",
  myResponse: "accepted", joinUrl: "", joinKind: "none", alsoIn: [],
};
const held: EventsView = {
  events: [standup], clashes: [], errors: [], syncedAt: "2026-10-26T09:00:00.000Z", version: "abc", unchanged: false,
};
const same = (syncedAt: string): EventsView => ({ events: [], clashes: [], errors: [], syncedAt, version: "abc", unchanged: true });

test("an unchanged answer keeps the meetings already held, and takes the new sync time", () => {
  const kept = keepUnchanged(held, same("2026-10-26T09:05:00.000Z"));
  assert.equal(kept.events, held.events);
  assert.equal(kept.syncedAt, "2026-10-26T09:05:00.000Z");
  assert.equal(kept.unchanged, false);
});

test("an unchanged answer at the same sync time hands back the very same object", () => {
  assert.equal(keepUnchanged(held, same(held.syncedAt)), held);
});

test("a full answer replaces what was held", () => {
  const full = { ...held, version: "def" };
  assert.equal(keepUnchanged(held, full), full);
});

test("since is the held version, and nothing when there is none", () => {
  assert.equal(sinceOf(undefined), undefined);
  assert.equal(sinceOf({ ...held, version: "" }), undefined);
  assert.equal(sinceOf(held), "abc");
});

const NOW = Date.parse("2026-10-26T09:00:00.000Z");
test("a focus re-reads EventKit only once the daemon's last pass is two minutes old", () => {
  assert.equal(providerPassDue(new Date(NOW - 119_999).toISOString(), NOW), false);
  assert.equal(providerPassDue(new Date(NOW - 120_000).toISOString(), NOW), true);
});

test("no stamp, or one nobody can read, counts as old", () => {
  assert.equal(providerPassDue("", NOW), true);
  assert.equal(providerPassDue("not a date", NOW), true);
});

test("a stamp ahead of this device's clock is not a reason to re-read", () => {
  assert.equal(providerPassDue(new Date(NOW + 60_000).toISOString(), NOW), false);
});
