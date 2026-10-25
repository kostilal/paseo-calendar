import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "./event.ts";
import { calendarNamesOf, copiesMergedWith, copiesOf, copyLabelsOf, isCancelledTitle, mergeMeetings, sameMeetingKey } from "./meeting.ts";

function copy(over: Partial<Event> & { id: string; accountId: string }): Event {
  return {
    calendarId: "cal", calendarName: "Calendar", title: "Planning",
    start: "2026-10-19T10:00:00.000Z", end: "2026-10-19T11:00:00.000Z", allDay: false,
    recurring: false, mine: false, attendees: [], location: "", description: "",
    webLink: "", myResponse: "accepted", ...over,
  };
}

test("the same meeting through two accounts has one key, whatever the case, spacing or instant spelling", () => {
  assert.equal(
    sameMeetingKey(copy({ id: "ek-1", accountId: "ex" })),
    sameMeetingKey(copy({ id: "gm-1", accountId: "gm", title: "  planning ", start: "2026-10-19T10:00:00Z", end: "2026-10-19T11:00:00Z" })),
  );
});

test("a different title, start or end is a different meeting", () => {
  const base = sameMeetingKey(copy({ id: "a", accountId: "ex" }));
  assert.notEqual(base, sameMeetingKey(copy({ id: "b", accountId: "ex", title: "Planning 2" })));
  assert.notEqual(base, sameMeetingKey(copy({ id: "c", accountId: "ex", start: "2026-10-19T10:30:00.000Z" })));
  assert.notEqual(base, sameMeetingKey(copy({ id: "d", accountId: "ex", end: "2026-10-19T11:30:00.000Z" })));
});

test("an all-day key compares bare dates and never matches a timed one", () => {
  const offsite = { title: "Offsite", start: "2026-10-19", end: "2026-10-21", allDay: true };
  assert.equal(sameMeetingKey(offsite), "day|offsite|2026-10-19|2026-10-21");
  assert.notEqual(sameMeetingKey(offsite), sameMeetingKey({ ...offsite, allDay: false }));
});

test("Outlook's cancelled prefixes are recognised; a title merely about cancelling is not", () => {
  assert.equal(isCancelledTitle("Canceled: Weekly sync"), true);
  assert.equal(isCancelledTitle("Cancelled: x"), true);
  assert.equal(isCancelledTitle("Отменено: Ретро"), true);
  assert.equal(isCancelledTitle("Anulowane: x"), true);
  assert.equal(isCancelledTitle("Cancel culture talk"), false);
});

test("two copies become one row, kept from the first account in stored order, naming the other calendar", () => {
  const merged = mergeMeetings(
    [copy({ id: "gm-1", accountId: "gm", calendarName: "Work" }), copy({ id: "ek-1", accountId: "ex" })],
    ["ex", "gm"],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].accountId, "ex");
  assert.equal(merged[0].id, "ek-1");
  assert.deepEqual(merged[0].alsoIn, [{ accountId: "gm", calendarId: "cal", calendarName: "Work" }]);
});

test("alsoIn lists every other account's copy, even under a calendar name the kept copy or another copy shares", () => {
  // Every Exchange mailbox calls its default calendar "Calendar": a name alone cannot tell
  // two accounts' copies apart, so each copy is listed with its account.
  const merged = mergeMeetings(
    [
      copy({ id: "1", accountId: "ex" }),
      copy({ id: "2", accountId: "gm" }),
      copy({ id: "3", accountId: "ic", calendarName: "Work" }),
      copy({ id: "4", accountId: "ic2", calendarName: "Work" }),
    ],
    ["ex", "gm", "ic", "ic2"],
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].alsoIn, [
    { accountId: "gm", calendarId: "cal", calendarName: "Calendar" },
    { accountId: "ic", calendarId: "cal", calendarName: "Work" },
    { accountId: "ic2", calendarId: "cal", calendarName: "Work" },
  ]);
});

test("two events with one key in one account are two meetings, never merged", () => {
  // Two invitations to an interview at 10:00 in one calendar are a double booking; merging
  // them would hide it.
  const merged = mergeMeetings([copy({ id: "i-1", accountId: "ex" }), copy({ id: "i-2", accountId: "ex" })], ["ex"]);
  assert.deepEqual(merged.map((event) => [event.id, event.alsoIn]), [["i-1", []], ["i-2", []]]);
});

test("another account's copy joins one of an account's two same-key meetings, the one with the smaller id", () => {
  const merged = mergeMeetings(
    [copy({ id: "i-2", accountId: "ex" }), copy({ id: "g-1", accountId: "gm", calendarName: "Work" }), copy({ id: "i-1", accountId: "ex" })],
    ["ex", "gm"],
  );
  assert.deepEqual(
    merged.map((event) => [event.id, event.alsoIn.map((other) => other.accountId)]),
    [["i-2", []], ["i-1", ["gm"]]],
  );
});

test("accounts missing from the order rank last, and a tie goes to the smaller id", () => {
  const merged = mergeMeetings([copy({ id: "x2", accountId: "zz" }), copy({ id: "x1", accountId: "yy" })], ["ex"]);
  assert.equal(merged[0].id, "x1");
});

test("different meetings are left alone, kept copies in input order, each with an empty alsoIn", () => {
  const merged = mergeMeetings(
    [
      copy({ id: "A-gm", accountId: "gm" }),
      copy({ id: "B", accountId: "ex", title: "Retro", start: "2026-10-19T12:00:00.000Z", end: "2026-10-19T13:00:00.000Z" }),
      copy({ id: "A-ex", accountId: "ex" }),
    ],
    ["ex", "gm"],
  );
  assert.deepEqual(merged.map((event) => event.id), ["B", "A-ex"]);
  assert.deepEqual(merged.map((event) => event.alsoIn), [[], [{ accountId: "gm", calendarId: "cal", calendarName: "Calendar" }]]);
});

const row = {
  accountId: "ex", calendarId: "cal-ex", calendarName: "Calendar",
  alsoIn: [{ accountId: "gm", calendarId: "cal-gm", calendarName: "Calendar" }],
};

test("a row's copies are the kept one first, then the others; its calendar names repeat a shared name", () => {
  assert.deepEqual(copiesOf(row), [
    { accountId: "ex", calendarId: "cal-ex", calendarName: "Calendar" },
    { accountId: "gm", calendarId: "cal-gm", calendarName: "Calendar" },
  ]);
  assert.deepEqual(calendarNamesOf(row), ["Calendar", "Calendar"]);
});

test("the card names each copy by its calendar and its account, and by the calendar alone when the account is unknown", () => {
  const accounts = [
    { id: "ex", owner: "a@corp.example", title: "Exchange" },
    { id: "gm", owner: "", title: "b@gmail.example" },
  ];
  assert.deepEqual(copyLabelsOf(row, accounts), ["Calendar · a@corp.example", "Calendar · b@gmail.example"]);
  assert.deepEqual(copyLabelsOf(row, []), ["Calendar", "Calendar"]);
});

test("the copies merged with a row are found by the same rule that drew it", () => {
  const events = [
    copy({ id: "i-1", accountId: "ex" }),
    copy({ id: "i-2", accountId: "ex" }),
    copy({ id: "g-1", accountId: "gm" }),
    copy({ id: "r", accountId: "gm", title: "Retro" }),
  ];
  assert.deepEqual(copiesMergedWith(events, { accountId: "ex", id: "i-1" }).map((event) => event.id), ["i-1", "g-1"]);
  assert.deepEqual(copiesMergedWith(events, { accountId: "ex", id: "i-2" }).map((event) => event.id), ["i-2"]);
  assert.deepEqual(copiesMergedWith(events, { accountId: "ex", id: "ghost" }), []);
});
