import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventsView, EventView } from "../shared/calendar.ts";
import { WINDOW_DAYS, coveredBy, sliceView, versionOf, windowFor } from "./sync.ts";

// The window is the daemon's own local day; node --test gives each file its own process.
process.env.TZ = "Europe/Warsaw";

test("the window starts at local midnight, not UTC midnight, and ends fourteen local days later", () => {
  const { from, to } = windowFor(Date.parse("2026-10-21T08:00:00.000Z"));
  assert.equal(from.toISOString(), "2026-10-20T22:00:00.000Z");
  // The clocks go back on 25 October, so fourteen local days are 14 × 24 h plus one.
  assert.equal(to.toISOString(), "2026-11-03T23:00:00.000Z");
  assert.equal(to.getTime() - from.getTime(), WINDOW_DAYS * 86_400_000 + 3_600_000);
});

test("at 00:30 local, while UTC is still on yesterday, the window is already today's", () => {
  assert.equal(windowFor(Date.parse("2026-10-20T22:30:00.000Z")).from.toISOString(), "2026-10-20T22:00:00.000Z");
});

test("a range is covered only when both ends lie inside the window", () => {
  const window = windowFor(Date.parse("2026-10-21T08:00:00.000Z"));
  assert.equal(coveredBy(window, new Date(2026, 9, 21), new Date(2026, 9, 22)), true);
  assert.equal(coveredBy(window, new Date(2026, 9, 20, 23, 59), new Date(2026, 9, 22)), false);
  assert.equal(coveredBy(window, new Date(2026, 10, 3), window.to), true);
  assert.equal(coveredBy(window, new Date(2026, 10, 3), new Date(window.to.getTime() + 1)), false);
});

function row(id: string, start: string, end: string, allDay = false): EventView {
  return { id, accountId: "ex", calendarId: "c", calendarName: "Calendar", title: id, start, end, allDay, recurring: false,
    mine: false, attendees: [], location: "", description: "", webLink: "", myResponse: "accepted", joinUrl: "",
    joinKind: "none", alsoIn: [] };
}

test("a slice keeps what overlaps the day, all-day by local date, and a clash only when both sides stay", () => {
  const late = row("late", "2026-10-21T21:30:00.000Z", "2026-10-21T22:30:00.000Z");   // 23:30–00:30 local
  const after = row("after", "2026-10-21T22:00:00.000Z", "2026-10-21T22:15:00.000Z"); // 00:00 on the 22nd
  const view: EventsView = {
    events: [
      row("early", "2026-10-20T22:30:00.000Z", "2026-10-20T23:00:00.000Z"),           // 00:30 local on the 21st
      late, after,
      row("today-all-day", "2026-10-21", "2026-10-22", true),
      row("tomorrow-all-day", "2026-10-22", "2026-10-23", true),
    ],
    clashes: [{ a: { accountId: "ex", id: "late" }, b: { accountId: "ex", id: "after" }, overlapMs: 900_000 }],
    syncedAt: "2026-10-21T07:58:00.000Z",
    errors: [{ accountId: "gm", message: "boom", code: "helper_failed" }],
    version: "", unchanged: false,
  };
  const day = sliceView(view, new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.deepEqual(day.events.map((e) => e.id), ["early", "late", "today-all-day"]);
  assert.deepEqual(day.clashes, []);
  assert.equal(day.syncedAt, view.syncedAt);
  assert.deepEqual(day.errors, view.errors);
  // A slice is its own answer: it has its own version, and is never itself an "unchanged".
  assert.equal(day.version, versionOf(day));
  assert.notEqual(day.version, "");
  assert.equal(day.unchanged, false);
});

test("a clash between two accounts inside the day survives the slice with its sides as they were", () => {
  const review = { ...row("review", "2026-10-21T08:00:00.000Z", "2026-10-21T09:00:00.000Z"), accountId: "ex" };
  const call = { ...row("call", "2026-10-21T08:30:00.000Z", "2026-10-21T09:30:00.000Z"), accountId: "gm" };
  const late = { ...row("late", "2026-10-21T21:30:00.000Z", "2026-10-21T22:30:00.000Z"), accountId: "ex" };  // 23:30–00:30 local
  const after = { ...row("after", "2026-10-21T22:00:00.000Z", "2026-10-21T22:15:00.000Z"), accountId: "gm" }; // 00:00 on the 22nd
  const inside = { a: { accountId: "ex", id: "review" }, b: { accountId: "gm", id: "call" }, overlapMs: 1_800_000 };
  const view: EventsView = {
    events: [review, call, late, after],
    clashes: [inside, { a: { accountId: "ex", id: "late" }, b: { accountId: "gm", id: "after" }, overlapMs: 900_000 }],
    syncedAt: "2026-10-21T07:58:00.000Z",
    errors: [],
    version: "", unchanged: false,
  };
  const day = sliceView(view, new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.deepEqual(day.events.map((e) => `${e.accountId}/${e.id}`), ["ex/review", "gm/call", "ex/late"]);
  // The pair inside the day is kept as it was; the one across midnight lost a side and goes.
  assert.deepEqual(day.clashes, [inside]);
});
