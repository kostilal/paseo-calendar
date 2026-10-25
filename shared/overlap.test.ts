import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "./event.ts";
import { clashes } from "./overlap.ts";

function event(over: Partial<Event> & { id: string; start: string; end: string }): Event {
  return {
    accountId: "acc",
    calendarId: "primary",
    calendarName: "Work",
    title: over.id,
    allDay: false,
    recurring: false,
    mine: true,
    attendees: [],
    location: "",
    description: "",
    webLink: "",
    myResponse: "accepted",
    ...over,
  };
}

test("two meetings that share half an hour collide", () => {
  const found = clashes([
    event({ id: "a", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "b", start: "2026-09-09T11:30:00.000Z", end: "2026-09-09T12:15:00.000Z" }),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].overlapMs, 30 * 60_000);
});

test("back to back is not a collision", () => {
  const found = clashes([
    event({ id: "a", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "b", start: "2026-09-09T12:00:00.000Z", end: "2026-09-09T12:30:00.000Z" }),
  ]);
  assert.deepEqual(found, []);
});

test("an all-day event collides with nothing", () => {
  const found = clashes([
    event({ id: "a", start: "2026-09-09", end: "2026-09-10", allDay: true }),
    event({ id: "b", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
  ]);
  assert.deepEqual(found, []);
});

test("a meeting you declined collides with nothing", () => {
  const found = clashes([
    event({ id: "a", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z", myResponse: "declined" }),
    event({ id: "b", start: "2026-09-09T11:30:00.000Z", end: "2026-09-09T12:30:00.000Z" }),
  ]);
  assert.deepEqual(found, []);
});

test("three overlapping meetings report every pair", () => {
  const found = clashes([
    event({ id: "a", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T13:00:00.000Z" }),
    event({ id: "b", start: "2026-09-09T11:30:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "c", start: "2026-09-09T11:45:00.000Z", end: "2026-09-09T12:30:00.000Z" }),
  ]);
  assert.equal(found.length, 3);
});

test("events from different accounts still collide — that is the whole point", () => {
  const found = clashes([
    event({ id: "a", accountId: "work", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "b", accountId: "home", start: "2026-09-09T11:30:00.000Z", end: "2026-09-09T12:30:00.000Z" }),
  ]);
  assert.equal(found.length, 1);
});

test("the same meeting through two connected accounts does not collide with itself", () => {
  const found = clashes([
    event({ id: "dup", accountId: "work", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "dup", accountId: "home", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
  ]);
  assert.deepEqual(found, []);
});

test("a duplicate across accounts still collides with a genuinely different meeting", () => {
  const found = clashes([
    event({ id: "dup", accountId: "work", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "dup", accountId: "home", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "c", start: "2026-09-09T11:30:00.000Z", end: "2026-09-09T12:30:00.000Z" }),
  ]);
  assert.equal(found.length, 2);
});

test("two accounts' copies of one meeting, under different ids, do not collide", () => {
  const found = clashes([
    event({ id: "ek-1", accountId: "ex", title: "Planning", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "gm-9", accountId: "gm", title: " planning", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
  ]);
  assert.deepEqual(found, []);
});

test("the same title at a different time still collides", () => {
  const found = clashes([
    event({ id: "a", title: "Planning", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z" }),
    event({ id: "b", title: "Planning", start: "2026-09-09T11:30:00.000Z", end: "2026-09-09T12:30:00.000Z" }),
  ]);
  assert.equal(found.length, 1);
});

test("two meetings with one title and time in one account still collide: a double booking, not a copy", () => {
  const found = clashes([
    event({ id: "i-1", accountId: "ex", title: "Interview", start: "2026-09-09T10:00:00.000Z", end: "2026-09-09T11:00:00.000Z" }),
    event({ id: "i-2", accountId: "ex", title: "Interview", start: "2026-09-09T10:00:00.000Z", end: "2026-09-09T11:00:00.000Z" }),
  ]);
  assert.equal(found.length, 1);
});

test("a merged row still collides with a same-key meeting of an account whose copy it carries", () => {
  // gm holds two interviews at 10:00 and ex a copy of one of them; the merged row is kept
  // from ex, but gm's other interview is still a second meeting for gm.
  const found = clashes([
    {
      ...event({ id: "i-ex", accountId: "ex", title: "Interview", start: "2026-09-09T10:00:00.000Z", end: "2026-09-09T11:00:00.000Z" }),
      alsoIn: [{ accountId: "gm", calendarId: "primary", calendarName: "Work" }],
    },
    event({ id: "i-gm-2", accountId: "gm", title: "Interview", start: "2026-09-09T10:00:00.000Z", end: "2026-09-09T11:00:00.000Z" }),
  ]);
  assert.equal(found.length, 1);
});

test("clashes takes any timed shape and hands back the very objects it was given", () => {
  // `as const`: a bare "accepted" widens to string, which Timed's myResponse rejects (TS2322).
  // accountId stays in Timed: the skip of two accounts' copies of one meeting reads it (and the optional alsoIn).
  const first = { id: "a", accountId: "acc", title: "A", start: "2026-09-09T11:00:00.000Z", end: "2026-09-09T12:00:00.000Z", allDay: false, myResponse: "accepted" as const };
  const second = { ...first, id: "b", title: "B", start: "2026-09-09T11:30:00.000Z" };
  const [found] = clashes([second, first]);
  assert.equal(found.a, first);
  assert.equal(found.b, second);
});
