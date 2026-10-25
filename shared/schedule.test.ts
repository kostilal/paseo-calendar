import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventsView, EventView } from "./calendar.ts";
import { buildSchedule, dayOf, resolveWindow, zonedMidnight, type ScheduleAccount, type ScheduleWindow } from "./schedule.ts";

const ZONE = "Europe/Warsaw";
const ACCOUNTS: ScheduleAccount[] = [
  { id: "ex", sourceId: "src-ex", title: "Exchange", owner: "me@corp.example", kind: "exchange", errorCode: "", missingSince: "", readable: true },
  { id: "gm", sourceId: "src-gm", title: "Google", owner: "me@gmail.example", kind: "caldav", errorCode: "", missingSince: "", readable: true },
];
const ICLOUD: ScheduleAccount = { id: "ic", sourceId: "src-ic", title: "iCloud", owner: "", kind: "icloud", errorCode: "", missingSince: "", readable: true };

function event(over: Partial<EventView> & { id: string; start: string; end: string }): EventView {
  return {
    accountId: "ex",
    calendarId: "cal",
    calendarName: "Calendar",
    title: over.id,
    allDay: false,
    recurring: false,
    mine: false,
    attendees: [{ name: "Ann", email: "ann@corp.example", response: "accepted", self: false, organiser: true, company: null }],
    location: "Room 4",
    description: "secret agenda",
    webLink: "",
    myResponse: "accepted",
    joinUrl: "",
    joinKind: "none",
    alsoIn: [],
    ...over,
  };
}

function view(events: EventView[], over: Partial<EventsView> = {}): EventsView {
  return { events, clashes: [], syncedAt: "2026-10-19T08:00:00.000Z", errors: [], version: "", unchanged: false, ...over };
}

function day(date: string): ScheduleWindow {
  const window = resolveWindow({ date }, Date.parse("2026-10-19T08:00:00.000Z"), ZONE);
  assert.ok(!("error" in window));
  return window;
}

function schedule(events: EventView[], over: Partial<Parameters<typeof buildSchedule>[0]> = {}) {
  return buildSchedule({
    view: view(events),
    accounts: ACCOUNTS,
    window: day("2026-10-19"),
    zone: ZONE,
    nowMs: Date.parse("2026-10-19T08:02:00.000Z"),
    withLinks: false,
    includeDeclined: false,
    ...over,
  });
}

test("today is Warsaw's today, even while UTC is still on yesterday", () => {
  // 00:30 in Warsaw on 20 October is 22:30 UTC on the 19th.
  const window = resolveWindow({}, Date.parse("2026-10-19T22:30:00.000Z"), ZONE);
  assert.ok(!("error" in window));
  assert.equal(window.from, "2026-10-20");
  assert.equal(new Date(window.startMs).toISOString(), "2026-10-19T22:00:00.000Z");
  assert.equal(new Date(window.endMs).toISOString(), "2026-10-20T22:00:00.000Z");
});

test("the day the clocks go back is 25 hours long", () => {
  const window = day("2026-10-25");
  assert.equal(window.endMs - window.startMs, 25 * 3_600_000);
  assert.equal(new Date(zonedMidnight("2026-03-29", ZONE)).toISOString(), "2026-03-28T23:00:00.000Z");
});

test("words, dates and periods resolve; nonsense and long periods are refused", () => {
  const now = Date.parse("2026-10-19T08:00:00.000Z");
  const tomorrow = resolveWindow({ date: "tomorrow" }, now, ZONE);
  assert.ok(!("error" in tomorrow) && tomorrow.from === "2026-10-20");
  const zavtra = resolveWindow({ date: "Завтра" }, now, ZONE);
  assert.ok(!("error" in zavtra) && zavtra.from === "2026-10-20");
  const week = resolveWindow({ from: "today", to: "2026-10-25" }, now, ZONE);
  assert.ok(!("error" in week) && week.from === "2026-10-19" && week.to === "2026-10-25");
  assert.ok("error" in resolveWindow({ date: "2026-02-30" }, now, ZONE));
  assert.ok("error" in resolveWindow({ date: "next week" }, now, ZONE));
  assert.ok("error" in resolveWindow({ from: "2026-10-25", to: "2026-10-19" }, now, ZONE));
  assert.ok("error" in resolveWindow({ from: "2026-10-01", to: "2026-11-01" }, now, ZONE));
  assert.ok(!("error" in resolveWindow({ from: "2026-10-01", to: "2026-10-31" }, now, ZONE)));
});

test("a weekday is its next occurrence, today included, and the earlier plugin's day words work", () => {
  assert.equal(dayOf("sunday", "2026-10-25"), "2026-10-25"); // 2026-10-25 is a Sunday
  assert.equal(dayOf("Monday", "2026-10-25"), "2026-10-26");
  assert.equal(dayOf("friday", "2026-10-25"), "2026-10-30");
  assert.equal(dayOf("послезавтра", "2026-10-25"), "2026-10-27");
  assert.equal(dayOf("jutro", "2026-10-25"), "2026-10-26");
  assert.equal(dayOf("", "2026-10-25"), "2026-10-25");
  assert.equal(dayOf("someday", "2026-10-25"), null);
  assert.equal(dayOf("constructor", "2026-10-25"), null); // a word on Object's prototype is not a day
});

test("times are Warsaw's, and nothing but title, time and calendar leaves", () => {
  const result = schedule([event({ id: "standup", start: "2026-10-19T07:30:00.000Z", end: "2026-10-19T07:45:00.000Z" })]);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    date: "2026-10-19",
    start: "09:30",
    end: "09:45",
    all_day: false,
    title: "standup",
    calendar: "Calendar (me@corp.example)",
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes("secret agenda") && !text.includes("ann@corp.example") && !text.includes("Room 4"));
});

test("an event late on the day before, in UTC, belongs to the Warsaw day it happens on", () => {
  const result = schedule([event({ id: "early", start: "2026-10-18T22:30:00.000Z", end: "2026-10-18T23:00:00.000Z" })]);
  assert.equal(result.events[0]?.start, "00:30");
  // And one at 23:30 Warsaw on the 19th is still the 19th, though UTC says 21:30.
  const late = schedule([event({ id: "late", start: "2026-10-19T21:30:00.000Z", end: "2026-10-19T21:45:00.000Z" })]);
  assert.equal(late.events[0]?.date, "2026-10-19");
  const next = schedule([event({ id: "next", start: "2026-10-19T22:00:00.000Z", end: "2026-10-19T22:30:00.000Z" })]);
  assert.equal(next.events.length, 0);
});

test("an all-day event shows on each day it covers and never slides into the next one", () => {
  const offsite = event({ id: "offsite", allDay: true, start: "2026-10-18", end: "2026-10-21" });
  const result = schedule([offsite]);
  assert.equal(result.events[0]?.all_day, true);
  assert.equal(result.events[0]?.date, "2026-10-19");
  assert.equal(result.events[0]?.until, "2026-10-20");
  assert.equal(schedule([event({ id: "holiday", allDay: true, start: "2026-10-20", end: "2026-10-21" })]).events.length, 0);
  assert.equal(schedule([event({ id: "yesterday", allDay: true, start: "2026-10-18", end: "2026-10-19" })]).events.length, 0);
  assert.match(result.summary, /all day until 2026-10-20 offsite/);
});

test("cancelled meetings are left out, declined ones are left out and counted, and declined comes back when asked", () => {
  const events = [
    event({ id: "a", title: "Canceled: Weekly sync", start: "2026-10-19T09:00:00.000Z", end: "2026-10-19T10:00:00.000Z" }),
    event({ id: "b", title: "Отменено: Ретро", start: "2026-10-19T11:00:00.000Z", end: "2026-10-19T12:00:00.000Z" }),
    event({ id: "c", myResponse: "declined", start: "2026-10-19T09:00:00.000Z", end: "2026-10-19T10:00:00.000Z" }),
    event({ id: "d", myResponse: "tentative", start: "2026-10-19T13:00:00.000Z", end: "2026-10-19T14:00:00.000Z" }),
  ];
  const result = schedule(events);
  assert.deepEqual(result.events.map((entry) => entry.title), ["d"]);
  assert.equal(result.events[0]?.response, "tentative");
  // Not counted: the board drops them before the schedule sees them, so a count would always be
  // zero, and "0 cancelled" reads as "nothing was cancelled".
  assert.deepEqual(result.hidden, { declined: 1, duplicates: 0 });
  assert.match(result.summary, /Left out: 1 declined\./);
  assert.doesNotMatch(result.summary, /cancelled/);
  const withDeclined = schedule(events, { includeDeclined: true });
  assert.deepEqual(withDeclined.events.map((entry) => [entry.title, entry.response]), [["c", "declined"], ["d", "tentative"]]);
});

test("a row merged upstream names every copy's calendar with its account and counts the copies", () => {
  // The row as viewOf's mergeMeetings leaves it: Exchange's copy kept, the other accounts' copies in alsoIn.
  // Gmail's calendar is called "Calendar" like the kept copy's: it is still its own copy, so it is still named.
  const result = schedule(
    [event({
      id: "ek-1", title: "Planning", start: "2026-10-19T10:00:00.000Z", end: "2026-10-19T11:00:00.000Z",
      alsoIn: [
        { accountId: "gm", calendarId: "cal-gm", calendarName: "Calendar" },
        { accountId: "ic", calendarId: "cal-work", calendarName: "Work" },
      ],
    })],
    { accounts: [...ACCOUNTS, ICLOUD] },
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.calendar, "Calendar (me@corp.example); Calendar (me@gmail.example); Work (iCloud)");
  assert.equal(result.hidden.duplicates, 2);
  assert.deepEqual(result.conflicts, []);
});

test("two meetings with one title and time in one account are two items that collide, not copies of one", () => {
  // Merging is only ever across accounts, and the schedule does no merging of its own, so a double booking shows.
  const twin = { title: "Interview", start: "2026-10-19T10:00:00.000Z", end: "2026-10-19T11:00:00.000Z" };
  const result = schedule([event({ id: "iv-1", ...twin }), event({ id: "iv-2", ...twin })]);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((entry) => entry.calendar), ["Calendar (me@corp.example)", "Calendar (me@corp.example)"]);
  assert.equal(result.hidden.duplicates, 0);
  assert.deepEqual(result.conflicts, ["2026-10-19 12:00–13:00 Interview × 12:00–13:00 Interview (1 h)"]);
  assert.deepEqual(result.events.map((entry) => entry.conflicts_with), [["Interview"], ["Interview"]]);
});

test("join links travel only when asked for", () => {
  const meeting = event({
    id: "call",
    start: "2026-10-19T10:00:00.000Z",
    end: "2026-10-19T11:00:00.000Z",
    joinUrl: "https://teams.microsoft.com/l/meetup-join/x",
    joinKind: "teams",
  });
  assert.equal(schedule([meeting]).events[0]?.join_url, undefined);
  assert.equal(schedule([meeting], { withLinks: true }).events[0]?.join_url, "https://teams.microsoft.com/l/meetup-join/x");
});

test("overlaps are named on both sides; back to back and all-day are not overlaps", () => {
  const result = schedule([
    event({ id: "A", start: "2026-10-19T10:00:00.000Z", end: "2026-10-19T11:00:00.000Z" }),
    event({ id: "B", start: "2026-10-19T10:30:00.000Z", end: "2026-10-19T11:30:00.000Z" }),
    event({ id: "C", start: "2026-10-19T11:30:00.000Z", end: "2026-10-19T12:00:00.000Z" }),
    event({ id: "D", allDay: true, start: "2026-10-19", end: "2026-10-20" }),
  ]);
  assert.deepEqual(result.conflicts, ["2026-10-19 12:00–13:00 A × 12:30–13:30 B (30 min)"]);
  assert.deepEqual(result.events.find((entry) => entry.title === "A")?.conflicts_with, ["B"]);
  assert.deepEqual(result.events.find((entry) => entry.title === "B")?.conflicts_with, ["A"]);
  assert.equal(result.events.find((entry) => entry.title === "C")?.conflicts_with, undefined);
  assert.equal(result.events[0]?.title, "D");
});

test("a source that failed is named with what to do, and old data says it is old", () => {
  const result = buildSchedule({
    view: view([], {
      syncedAt: "2026-10-19T07:40:00.000Z",
      errors: [{ accountId: "gm", message: "calendar access has not been granted yet", code: "access_needed" }],
    }),
    accounts: ACCOUNTS,
    window: day("2026-10-19"),
    zone: ZONE,
    nowMs: Date.parse("2026-10-19T08:00:00.000Z"),
    withLinks: false,
    includeDeclined: false,
  });
  assert.deepEqual(
    result.sources.map((source) => [source.name, source.ok]),
    [["me@corp.example", true], ["me@gmail.example", false]],
  );
  assert.match(result.sources[1]?.note ?? "", /macOS calendar access is not granted/);
  assert.equal(result.stale, true);
  assert.equal(result.as_of, "2026-10-19 09:40");
  assert.match(result.summary, /nothing scheduled/);
  assert.match(result.summary, /Not read: me@gmail.example/);
  assert.match(result.summary, /may be out of date/);
});

test("a failed account is covered when another account that was read has the same owner", () => {
  const result = buildSchedule({
    view: view([], { errors: [{ accountId: "ex", message: "eventkit helper timed out after 15000ms", code: "helper_failed" }] }),
    accounts: [...ACCOUNTS, { id: "ex2", sourceId: "src-ex2", title: "Exchange", owner: "ME@corp.example", kind: "exchange", errorCode: "", missingSince: "", readable: true }],
    window: day("2026-10-19"), zone: ZONE, nowMs: Date.parse("2026-10-19T08:02:00.000Z"), withLinks: false, includeDeclined: false,
  });
  assert.equal(result.sources[0]?.covered, true);
  assert.equal(result.sources[0]?.note, "the same mailbox is read through another account on this Mac");
  assert.doesNotMatch(result.summary, /Not read/);
});

test("a failed account is not covered by a same-owner account with every calendar hidden, which reads nothing", () => {
  // An all-hidden account is never read, so it never carries an error either: having no failure is not having been read.
  const result = buildSchedule({
    view: view([], { errors: [{ accountId: "ex", message: "eventkit helper timed out after 15000ms", code: "helper_failed" }] }),
    accounts: [...ACCOUNTS, { id: "ex2", sourceId: "src-ex2", title: "Exchange", owner: "me@corp.example", kind: "exchange", errorCode: "", missingSince: "", readable: false }],
    window: day("2026-10-19"), zone: ZONE, nowMs: Date.parse("2026-10-19T08:02:00.000Z"), withLinks: false, includeDeclined: false,
  });
  assert.equal(result.sources[0]?.ok, false);
  assert.equal(result.sources[0]?.covered, undefined);
  assert.match(result.summary, /Not read: me@corp\.example \(eventkit helper timed out after 15000ms\)/);
});

test("two accounts that only share the title Exchange do not cover each other", () => {
  const unknown = { sourceId: "", owner: "", kind: "exchange", errorCode: "" as const, missingSince: "", readable: true };
  const result = buildSchedule({
    view: view([], { errors: [{ accountId: "a", message: "boom", code: "helper_failed" }] }),
    accounts: [{ id: "a", title: "Exchange", ...unknown, sourceId: "s-a" }, { id: "b", title: "Exchange", ...unknown, sourceId: "s-b" }],
    window: day("2026-10-19"), zone: ZONE, nowMs: Date.parse("2026-10-19T08:02:00.000Z"), withLinks: false, includeDeclined: false,
  });
  assert.equal(result.sources[0]?.covered, undefined);
  assert.match(result.summary, /Not read: Exchange \(boom\)/);
});

test("an account whose source left the Mac is not read, says since when, and where to fix it", () => {
  // Every calendar hidden, so sync names it in no error (a hidden account is never read): its own errorCode says it is gone.
  const result = schedule([], {
    accounts: [{ ...ACCOUNTS[0], errorCode: "source_gone", missingSince: "2026-10-18T09:00:00.000Z", readable: false }, ACCOUNTS[1]],
  });
  assert.equal(result.sources[0]?.ok, false);
  assert.equal(result.sources[0]?.note,
    "not found on this Mac since 2026-10-18: add it back in System Settings → Internet Accounts with Calendars on, or re-link it on Paseo's Calendar settings screen");
});

test("a readable account is judged by what this read found, not by a gone flag Settings still carries", () => {
  // Sync lists a readable gone account in the errors itself, so with no error it was read.
  const result = schedule([], {
    accounts: [{ ...ACCOUNTS[0], errorCode: "source_gone", missingSince: "2026-10-18T09:00:00.000Z" }, ACCOUNTS[1]],
  });
  assert.equal(result.sources[0]?.ok, true);
  assert.doesNotMatch(result.summary, /Not read/);
});

test("a failure is explained by its code, not by matching English text", () => {
  const result = schedule([], { view: view([], { errors: [{ accountId: "gm", message: "calendar access not granted", code: "access_needed" }] }) });
  assert.equal(result.sources[1]?.note, "macOS calendar access is not granted to the Calendar helper: allow it on Paseo's Calendar settings screen");
});

test("an error that names no listed account is still said", () => {
  const result = schedule([], { view: view([], { errors: [{ accountId: "", message: "calendar.json is not valid JSON", code: "store_broken" }] }) });
  assert.match(result.summary,
    /Problem: the Calendar plugin's settings file could not be read in full: some calendars may be missing, and nothing is saved until it is fixed\./);
});

test("a source's kind names the account kind macOS reported", () => {
  assert.deepEqual(schedule([]).sources.map((source) => source.kind),
    ["Apple Calendar on this Mac (exchange)", "Apple Calendar on this Mac (caldav)"]);
});

test("a long period keeps its warnings even when the list has to be cut", () => {
  const events = Array.from({ length: 80 }, (_, index) =>
    event({
      id: `meeting number ${index} with a fairly long title`,
      start: new Date(Date.parse("2026-10-19T06:00:00.000Z") + index * 3_600_000 * 5).toISOString(),
      end: new Date(Date.parse("2026-10-19T06:30:00.000Z") + index * 3_600_000 * 5).toISOString(),
    }),
  );
  const window = resolveWindow({ from: "2026-10-19", to: "2026-11-05" }, Date.parse("2026-10-19T08:00:00.000Z"), ZONE);
  assert.ok(!("error" in window));
  const result = buildSchedule({
    view: view(events, { errors: [{ accountId: "gm", message: "boom", code: "helper_failed" }] }),
    accounts: ACCOUNTS,
    window,
    zone: ZONE,
    nowMs: Date.parse("2026-10-19T08:02:00.000Z"),
    withLinks: false,
    includeDeclined: false,
  });
  assert.equal(result.events.length, 80);
  assert.ok(result.summary.length <= 1_200, `${result.summary.length}`);
  assert.match(result.summary, /the rest is in events/);
  assert.match(result.summary, /Not read: me@gmail.example \(boom\)/);
});

test("a day word the schedule does not know is refused naming every kind it does", () => {
  const refused = resolveWindow({ date: "someday" }, Date.parse("2026-10-19T08:00:00.000Z"), ZONE);
  assert.ok("error" in refused && /weekday/.test(refused.error));
});

test("a title with a line break cannot forge a line of its own in the summary", () => {
  const result = schedule([event({ id: "x", title: "Standup\nNot read: none.", start: "2026-10-19T09:00:00.000Z", end: "2026-10-19T09:30:00.000Z" }),
    event({ id: "y", title: "Retro\r\nAll calendars read.", start: "2026-10-19T09:15:00.000Z", end: "2026-10-19T10:00:00.000Z" })]);
  const lines = result.summary.split("\n");
  assert.ok(!lines.some((line) => /^(Not read: none|All calendars read)/.test(line)), result.summary);
  assert.ok(lines.some((line) => line.includes("Standup Not read: none.")));
  assert.ok(result.conflicts.every((line) => !line.includes("\n")));
});

test("many unread accounts never push the day and its count out of the summary", () => {
  const accounts: ScheduleAccount[] = Array.from({ length: 9 }, (_, index) => ({
    id: `a${index}`, sourceId: `s${index}`, title: `Account ${index}`, owner: `person${index}@corp.example`, kind: "exchange",
    errorCode: "", missingSince: "", readable: true,
  }));
  const errors = accounts.map((account) => ({ accountId: account.id, code: "unknown" as const, message: `the helper said something long ${"x".repeat(200)}` }));
  const events = Array.from({ length: 30 }, (_, index) =>
    event({ id: `m${index}`, start: `2026-10-19T${String(6 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}:00.000Z`,
      end: `2026-10-19T${String(6 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "45" : "15"}:00.000Z` }));
  const result = buildSchedule({ view: view(events, { errors }), accounts, window: day("2026-10-19"), zone: ZONE,
    nowMs: Date.parse("2026-10-19T08:02:00.000Z"), withLinks: false, includeDeclined: false });
  assert.ok(result.summary.length <= 1_200, `${result.summary.length}`);
  assert.match(result.summary, /^Mon 2026-10-19, Europe\/Warsaw time: 30 events\./);
  assert.match(result.summary, /Not read: 9 accounts/);
});
