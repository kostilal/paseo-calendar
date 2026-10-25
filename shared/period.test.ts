import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENDA_POLL_MS,
  ERROR_RETRY_MS,
  browseRefetchMs,
  dayKey,
  formatClock,
  formatIsoStamp,
  formatStamp,
  monthGrid,
  rangeFor,
  sameMonth,
  shift,
  startOfDay,
} from "./period.ts";

test("agenda keeps the daemon's own window rather than asking for one", () => {
  // It reads the rolling fortnight the pill counts against; asking for a window would make
  // the board and the pill disagree about what "next" is.
  assert.equal(rangeFor("agenda", new Date(2026, 8, 14)), null);
});

test("a day's window is that day and nothing either side of it", () => {
  const range = rangeFor("day", new Date(2026, 8, 14, 17, 30));
  assert.equal(range?.from.getTime(), new Date(2026, 8, 14).getTime());
  assert.equal(range?.to.getTime(), new Date(2026, 8, 15).getTime());
});

test("a month's window ends exactly where the next one begins", () => {
  const september = rangeFor("month", new Date(2026, 8, 14));
  const october = rangeFor("month", new Date(2026, 9, 3));
  assert.equal(september?.to.getTime(), october?.from.getTime());
});

test("only a day in the fortnight polls on the agenda's cadence; a month or a far day waits for a navigation", () => {
  const now = new Date(2026, 9, 25, 10, 0);
  assert.equal(AGENDA_POLL_MS, 60_000);
  assert.equal(browseRefetchMs("day", new Date(2026, 9, 25, 18, 0), now), 60_000, "today");
  assert.equal(browseRefetchMs("day", new Date(2026, 10, 7), now), 60_000, "13 days on is still in the snapshot");
  // Outside the fortnight a day is a provider pass, and one a minute is goal 7's opposite.
  assert.equal(browseRefetchMs("day", new Date(2026, 10, 8), now), false, "14 days on");
  assert.equal(browseRefetchMs("day", new Date(2026, 9, 24), now), false, "yesterday");
  assert.equal(browseRefetchMs("month", now, now), false);
  assert.equal(browseRefetchMs("agenda", now, now), false);
});

test("a browse that failed is asked again, so 'Retrying…' is true", () => {
  const now = new Date(2026, 9, 25, 10, 0);
  assert.equal(browseRefetchMs("month", now, now, true), ERROR_RETRY_MS);
  assert.equal(browseRefetchMs("day", new Date(2027, 0, 1), now, true), ERROR_RETRY_MS);
});

test("stepping a month from the 31st does not skip February", () => {
  // Date normalises 31 February into 3 March without complaint, so carrying the day across a
  // month step silently loses a month. Landing on the 1st is what avoids it.
  const january31 = new Date(2027, 0, 31);
  const next = shift("month", january31, 1);
  assert.equal(next.getMonth(), 1, "February");
  assert.equal(next.getDate(), 1);
});

test("stepping a day crosses a month and a year boundary cleanly", () => {
  assert.equal(dayKey(shift("day", new Date(2026, 8, 30), 1)), "2026-10-01");
  assert.equal(dayKey(shift("day", new Date(2026, 11, 31), 1)), "2027-01-01");
  assert.equal(dayKey(shift("day", new Date(2027, 0, 1), -1)), "2026-12-31");
});

test("a month grid is six whole weeks starting on Monday", () => {
  const weeks = monthGrid(new Date(2026, 8, 14));
  assert.equal(weeks.length, 6);
  assert.ok(weeks.every((week) => week.length === 7));
  assert.ok(weeks.every((week) => week[0].getDay() === 1), "every row begins on a Monday");
  // Consecutive days throughout, with no gap or repeat where the rows join.
  const flat = weeks.flat();
  for (let i = 1; i < flat.length; i++) {
    assert.equal(flat[i].getTime() - flat[i - 1].getTime() > 0, true);
    assert.equal(dayKey(flat[i]), dayKey(new Date(flat[0].getFullYear(), flat[0].getMonth(), flat[0].getDate() + i)));
  }
});

test("the grid pads with real neighbouring days, not blanks", () => {
  // September 2026 begins on a Tuesday, so the row has to open with Monday the 31st of
  // August — which is what tells a reader the 1st is a Tuesday at all.
  const weeks = monthGrid(new Date(2026, 8, 1));
  assert.equal(dayKey(weeks[0][0]), "2026-08-31");
  assert.ok(!sameMonth(weeks[0][0], new Date(2026, 8, 1)));
  assert.equal(dayKey(weeks[0][1]), "2026-09-01");
});

test("a month that already starts on Monday still gets a full leading week", () => {
  // June 2026 starts on a Monday; the grid must not silently become five rows.
  const weeks = monthGrid(new Date(2026, 5, 1));
  assert.equal(dayKey(weeks[0][0]), "2026-06-01");
  assert.equal(weeks.length, 6);
});

test("day keys are local, so an evening meeting is not filed under tomorrow", () => {
  assert.equal(dayKey(startOfDay(new Date(2026, 8, 14, 23, 59))), "2026-09-14");
});

// --- One clock, on a 24-hour face ---

test("times are 24-hour whatever the reader's locale would have chosen", () => {
  const afternoon = new Date(2026, 8, 14, 15, 30);
  // en-US would say 3:30 PM left to itself; this is the whole point of pinning the cycle.
  for (const locale of ["ru", "en-US", "uk", "en-GB"]) {
    assert.equal(formatClock(afternoon, locale), "15:30", locale);
  }
});

test("midnight is 00:00, not 24:00", () => {
  // hour12:false leaves the 0–23 against 1–24 choice to the locale, and some pick the latter.
  // A meeting at "24:00" would be nobody's idea of midnight, which is why the cycle is named.
  assert.equal(formatClock(new Date(2026, 8, 14, 0, 5), "ru"), "00:05");
  assert.equal(formatClock(new Date(2026, 8, 14, 0, 0), "ja-JP"), "00:00");
});

test("a full stamp carries the date and a 24-hour time", () => {
  const stamp = formatStamp(new Date(2026, 8, 14, 22, 37), "en-US");
  assert.match(stamp, /22:37/);
  assert.ok(!/AM|PM/i.test(stamp));
});

test("an ISO stamp is drawn in the viewer's locale, and nothing for a missing or broken one", () => {
  assert.equal(formatIsoStamp("", "en"), "");
  assert.equal(formatIsoStamp("not a date", "en"), "");
  assert.equal(formatIsoStamp("2026-10-25T08:00:00.000Z", "en"), formatStamp(new Date("2026-10-25T08:00:00.000Z"), "en"));
});
