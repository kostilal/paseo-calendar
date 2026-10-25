import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameAdded, overlapsOf, planEvent, resolveTarget, targetsOf, wallClockInstant, type PlannedEvent } from "./add-event.ts";
import { ACCOUNTS, NOW, ZONE, account, meeting } from "./add-event.fixtures.ts";

// add-event.test.ts only: a subscribed account, for the read-only case
const TARGETS = targetsOf([...ACCOUNTS, account({ id: "sub", title: "Holidays", kind: "subscribed",
  calendars: [{ id: "c-hol", name: "Holidays", shown: true }] })]);
const id = (query: string) => { const found = resolveTarget(TARGETS, query); return "error" in found ? found.error : found.calendarId; };
const PLAN: PlannedEvent = { title: "Dentist", date: "2026-10-27", startMs: Date.parse("2026-10-27T09:00:00.000Z"), endMs: Date.parse("2026-10-27T09:30:00.000Z") };

test("a wall clock becomes the instant it names in the zone, and a skipped or doubled one is refused", () => {
  assert.equal(wallClockInstant("2026-10-27", "10:00", ZONE), Date.parse("2026-10-27T09:00:00.000Z"));
  assert.equal(wallClockInstant("2026-07-01", "9:05", ZONE), Date.parse("2026-07-01T07:05:00.000Z"));
  assert.deepEqual(wallClockInstant("2026-03-29", "02:30", ZONE), { error: "2026-03-29 02:30 does not exist in Europe/Warsaw (clocks jump forward); pick another time" });
  assert.deepEqual(wallClockInstant("2026-10-25", "02:30", ZONE), { error: "2026-10-25 02:30 happens twice in Europe/Warsaw (clocks go back); pick another time" });
  assert.deepEqual(wallClockInstant("2026-10-27", "25:00", ZONE), { error: 'bad time "25:00": use HH:MM, 24-hour' });
});
test("an event plan trims the title, reads a weekday, and refuses the past", () => {
  const base = { title: "  Dentist ", date: "tuesday", start_time: "10:00", duration_minutes: 30 };
  assert.deepEqual(planEvent(base, NOW, ZONE), PLAN);
  assert.deepEqual(planEvent({ ...base, date: "today", start_time: "09:00" }, NOW, ZONE), { error: "2026-10-25 09:00 Europe/Warsaw is in the past" });
  assert.ok(!("error" in planEvent({ ...base, date: "today", start_time: "09:56" }, NOW, ZONE))); // five minutes' grace
  assert.deepEqual(planEvent({ ...base, title: "   " }, NOW, ZONE), { error: "title is required" });
  assert.deepEqual(planEvent({ ...base, date: "someday" }, NOW, ZONE), { error: 'cannot understand date "someday"; use YYYY-MM-DD, today, tomorrow, yesterday or a weekday name' });
});
test("a title the board would hide as cancelled is refused, since nothing could find it again", () => {
  const base = { title: "Cancelled: gym", date: "tuesday", start_time: "18:00", duration_minutes: 60 };
  const plan = planEvent(base, NOW, ZONE);
  assert.ok("error" in plan && /hide/.test(plan.error), JSON.stringify(plan));
  assert.ok("error" in planEvent({ ...base, title: "Отменено: зал" }, NOW, ZONE));
  assert.ok(!("error" in planEvent({ ...base, title: "Gym (cancelled last week)" }, NOW, ZONE)));
});
test("a calendar is found by owner, Account/Calendar, its own name, then its account's title", () => {
  assert.equal(id("me@example.com"), "c-ex");
  assert.equal(id("EXCHANGE/calendar"), "c-ex");
  assert.equal(id("me@example.com/Calendar"), "c-ex");
  assert.equal(id("Home"), "c-home");
  assert.equal(id("Calendar"), '"Calendar" matches several calendars: Exchange/Calendar (me@example.com); iCloud/Calendar. Name one of them exactly.');
  assert.equal(id("iCloud"), '"iCloud" matches several calendars: iCloud/Home; iCloud/Calendar. Name one of them exactly.');
});
test("a hidden, read-only or vanished calendar is named as such and never chosen", () => {
  assert.equal(id("Birthdays"), `"Birthdays" is switched off in Paseo's Calendar settings; switch it on there to add events to it.`);
  assert.equal(id("Holidays"), '"Holidays" is read-only in Apple Calendar; events cannot be added to it.');
  assert.equal(id("me@example.org"), '"me@example.org" is not on this Mac right now (its account is missing from Internet Accounts); nothing was added.');
  assert.equal(id("Gym"), 'no calendar you can add to is called "Gym". Calendars you can add to: Exchange/Calendar (me@example.com); iCloud/Home; iCloud/Calendar.');
});
test("the same event is recognised in its own calendar and as a merged copy, and nowhere else", () => {
  const exchange = TARGETS.find((target) => target.calendarId === "c-ex")!;
  assert.ok(isSameAdded(meeting({ title: " dentist " }), exchange, PLAN));
  // A row kept from iCloud's copy, with the Exchange calendar's own copy merged into it: found by account and calendar id.
  const merged = { accountId: "ic", calendarId: "c-ic", alsoIn: [{ accountId: "ex", calendarId: "c-ex", calendarName: "Calendar" }] };
  assert.ok(isSameAdded(meeting(merged), exchange, PLAN));
  assert.ok(!isSameAdded(meeting({ accountId: "ic", calendarId: "c-home", calendarName: "Home" }), exchange, PLAN));
  // A calendar called "Calendar" in another account is not the target, kept or merged: only the ids decide.
  assert.ok(!isSameAdded(meeting({ accountId: "ic", calendarId: "c-ic" }), exchange, PLAN));
  assert.ok(!isSameAdded(meeting({ accountId: "ic", calendarId: "c-ic", alsoIn: [{ accountId: "gm", calendarId: "c-gm", calendarName: "Calendar" }] }), exchange, PLAN));
  assert.ok(!isSameAdded(meeting({ end: "2026-10-27T09:31:00.000Z" }), exchange, PLAN));
  assert.ok(!isSameAdded(meeting({ allDay: true, start: "2026-10-27", end: "2026-10-28" }), exchange, PLAN));
});
test("overlaps leave out all-day, declined and cancelled meetings", () => {
  const events = [
    meeting({ id: "a", title: "Standup", start: "2026-10-27T08:45:00.000Z", end: "2026-10-27T09:15:00.000Z" }),
    meeting({ id: "b", title: "Offsite", allDay: true, start: "2026-10-27", end: "2026-10-28" }),
    meeting({ id: "c", title: "Review", myResponse: "declined" }),
    meeting({ id: "d", title: "Canceled: Sync" }),
    meeting({ id: "e", title: "Lunch", start: "2026-10-27T09:30:00.000Z", end: "2026-10-27T10:00:00.000Z" }),
  ];
  assert.deepEqual(overlapsOf(events, PLAN).map((event) => event.id), ["a"]);
});
