import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateOfWallClock,
  formatWallClock,
  parseWallClock,
  wallClockOf,
  withDate,
  withTime,
} from "./wallclock.ts";

test("the format the server is promised survives a round trip", () => {
  const text = "2026-09-14T17:45";
  const parsed = parseWallClock(text);
  assert.deepEqual(parsed, { year: 2026, month: 9, day: 14, hour: 17, minute: 45 });
  assert.equal(formatWallClock(parsed!), text);
});

test("single digits keep their leading zero", () => {
  // Assembling this string by hand is where the missing zero comes from, which is most of
  // why the picker never assembles it by hand.
  assert.equal(formatWallClock({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }), "2026-01-05T09:00");
});

test("a month is counted the way a person counts it, not the way Date does", () => {
  const parsed = parseWallClock("2026-01-05T09:00");
  assert.equal(parsed?.month, 1, "January is 1 here and 0 in Date; converting once is the point");
  assert.equal(dateOfWallClock(parsed!).getMonth(), 0);
});

test("a date that does not exist is rejected rather than quietly moved", () => {
  // Date normalises 31 April into 1 May without a word. A form that accepted it would book a
  // meeting on a day nobody chose.
  assert.equal(parseWallClock("2026-04-31T10:00"), null);
  assert.equal(parseWallClock("2027-02-29T10:00"), null);
  // The genuine leap day is fine.
  assert.ok(parseWallClock("2028-02-29T10:00"));
});

test("anything not exactly the format is refused", () => {
  for (const bad of ["", "2026-09-14", "2026-9-14T17:45", "2026-09-14T25:00", "2026-09-14T17:60"]) {
    assert.equal(parseWallClock(bad), null, bad);
  }
});

test("a space is accepted where a T is expected, and normalised away", () => {
  // The parser this replaced took either separator. Collapsing two implementations into one
  // should not quietly narrow what either accepted; what comes back out is always the T form
  // the server contract names.
  assert.equal(formatWallClock(parseWallClock("2026-09-14 17:45")!), "2026-09-14T17:45");
});

test("moving the day keeps the time, and moving the time keeps the day", () => {
  const when = parseWallClock("2026-09-14T17:45")!;
  assert.equal(formatWallClock(withDate(when, new Date(2026, 11, 31))), "2026-12-31T17:45");
  assert.equal(formatWallClock(withTime(when, 9, 5)), "2026-09-14T09:05");
});

test("wallClockOf and dateOfWallClock are inverses in local time", () => {
  const date = new Date(2026, 8, 14, 17, 45);
  assert.equal(dateOfWallClock(wallClockOf(date)).getTime(), date.getTime());
});
