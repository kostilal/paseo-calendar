import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPassed } from "./elapsed.ts";

const timed = (end: string) => ({ end, allDay: false });
const allDay = (end: string) => ({ end, allDay: true });

test("a meeting that has not ended yet is still ahead of you", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  assert.equal(hasPassed(timed("2026-09-17T10:30:00.000Z"), now), false);
});

test("a meeting is past the moment it ends, not a minute later", () => {
  const now = new Date("2026-09-17T10:00:00.000Z");
  assert.equal(hasPassed(timed("2026-09-17T10:00:00.000Z"), now), true);
  assert.equal(hasPassed(timed("2026-09-17T10:00:00.001Z"), now), false);
});

test("an all-day event lasts its whole day, wherever the reader is", () => {
  // Its exclusive end is the 18th, so it covers the 17th. Local midday and local late
  // evening both fall inside it — the latter is where a UTC reading of the bare date would
  // retire the day early for anyone east of Greenwich.
  const end = "2026-09-18";
  assert.equal(hasPassed(allDay(end), new Date(2026, 8, 17, 12, 0)), false);
  assert.equal(hasPassed(allDay(end), new Date(2026, 8, 17, 23, 59)), false);
  assert.equal(hasPassed(allDay(end), new Date(2026, 8, 18, 0, 1)), true);
});

test("a multi-day all-day event is not past until the last day it covers is", () => {
  const end = "2026-09-20";
  assert.equal(hasPassed(allDay(end), new Date(2026, 8, 19, 9, 0)), false);
  assert.equal(hasPassed(allDay(end), new Date(2026, 8, 20, 9, 0)), true);
});

test("an end nobody can parse leaves the meeting undimmed rather than guessed at", () => {
  assert.equal(hasPassed(timed("not a date"), new Date("2026-09-17T10:00:00.000Z")), false);
  assert.equal(hasPassed(timed(""), new Date("2026-09-17T10:00:00.000Z")), false);
});
