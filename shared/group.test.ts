// Pinned: the fixtures' local days are Warsaw days (node --test gives each file its own process).
process.env.TZ = "Europe/Warsaw";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventsView, EventView } from "./calendar.ts";
import { agendaOf, allDayDates, clashGroupsOf, dayAgenda, eventKey, eventsByDay, groupByDay, partnersOf } from "./group.ts";

function event(id: string, start: string, end: string, allDay = false, accountId = "acc"): EventView {
  return {
    id,
    accountId,
    calendarId: "c",
    calendarName: "Work",
    title: id,
    start,
    end,
    allDay,
    recurring: false,
    mine: true,
    attendees: [],
    location: "",
    description: "",
    webLink: "",
    myResponse: "accepted",
    joinUrl: "",
    joinKind: "none",
    alsoIn: [],
  };
}

/** Takes the actual event objects rather than bare ids, so the composite identity a real
 *  clash carries (calendar.ts's clashSide) is built the same way sync.ts's dedupeClashes
 *  builds it, not a shortcut that could hide a bug the real path would hit. */
function clash(a: EventView, b: EventView, overlapMs: number): EventsView["clashes"][number] {
  return { a: { accountId: a.accountId, id: a.id }, b: { accountId: b.accountId, id: b.id }, overlapMs };
}

// --- groupByDay ---

test("events are grouped by local day and sorted within it", () => {
  const groups = groupByDay([
    event("b", "2026-09-09T14:00:00.000Z", "2026-09-09T15:00:00.000Z"),
    event("a", "2026-09-09T09:00:00.000Z", "2026-09-09T10:00:00.000Z"),
    event("c", "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups[0].events.map((entry) => entry.id),
    ["a", "b"],
  );
  assert.equal(groups[1].events[0].id, "c");
});

test("an all-day event sorts before the timed ones on its day", () => {
  const groups = groupByDay([
    event("timed", "2026-09-09T09:00:00.000Z", "2026-09-09T10:00:00.000Z"),
    event("allday", "2026-09-09", "2026-09-10", true),
  ]);
  assert.deepEqual(
    groups[0].events.map((entry) => entry.id),
    ["allday", "timed"],
  );
});

test("no events means no groups, not one empty group", () => {
  assert.deepEqual(groupByDay([]), []);
});

test("a multi-day all-day event appears on every day it covers, not only its first", () => {
  // end is exclusive (see shared/event.ts): a three-day conference from the 10th through
  // the 12th carries end "2026-09-13".
  const groups = groupByDay([event("conference", "2026-09-10", "2026-09-13", true)]);
  assert.deepEqual(
    groups.map((group) => group.day),
    ["2026-09-10", "2026-09-11", "2026-09-12"],
  );
  for (const group of groups) {
    assert.deepEqual(
      group.events.map((entry) => entry.id),
      ["conference"],
    );
  }
});

test("a single-day all-day event still lands on exactly one day", () => {
  const groups = groupByDay([event("holiday", "2026-09-09", "2026-09-10", true)]);
  assert.deepEqual(
    groups.map((group) => group.day),
    ["2026-09-09"],
  );
});

test("a multi-day all-day event still sorts before a timed event on a day it shares with one", () => {
  const groups = groupByDay([
    event("timed", "2026-09-11T09:00:00.000Z", "2026-09-11T10:00:00.000Z"),
    event("conference", "2026-09-10", "2026-09-13", true),
  ]);
  const middleDay = groups.find((group) => group.day === "2026-09-11");
  assert.deepEqual(
    middleDay?.events.map((entry) => entry.id),
    ["conference", "timed"],
  );
});

// --- allDayDates ---

test("allDayDates lists every day a multi-day all-day event covers, first to last inclusive", () => {
  assert.deepEqual(allDayDates(event("conference", "2026-09-10", "2026-09-13", true)), [
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
  ]);
});

test("allDayDates is one day for a single-day all-day event", () => {
  assert.deepEqual(allDayDates(event("holiday", "2026-09-09", "2026-09-10", true)), ["2026-09-09"]);
});

test("allDayDates falls back to just the start when end is not after it", () => {
  assert.deepEqual(allDayDates(event("odd", "2026-09-09", "2026-09-09", true)), ["2026-09-09"]);
});

// --- clashGroupsOf ---

test("a clashing pair becomes one group, found from either side", () => {
  const a = event("a", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z");
  const b = event("b", "2026-09-09T11:30:00.000Z", "2026-09-09T12:15:00.000Z");
  const groups = clashGroupsOf([a, b], [clash(a, b, 30 * 60_000)]);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get(eventKey(a)), { members: [a, b], overlapMs: 30 * 60_000 });
  assert.deepEqual(groups.get(eventKey(b)), { members: [a, b], overlapMs: 30 * 60_000 });
});

test("events with no clash entries produce no groups", () => {
  const a = event("a", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z");
  const b = event("b", "2026-09-09T13:00:00.000Z", "2026-09-09T14:00:00.000Z");
  assert.deepEqual(clashGroupsOf([a, b], []), new Map());
});

test("a chain of three merges into one group, labelled with the worst pair", () => {
  // a-b overlap by 15 min, b-c overlap by 45 min, a and c do not touch at all.
  const a = event("a", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z");
  const b = event("b", "2026-09-09T10:45:00.000Z", "2026-09-09T12:00:00.000Z");
  const c = event("c", "2026-09-09T11:15:00.000Z", "2026-09-09T12:30:00.000Z");
  const groups = clashGroupsOf([a, b, c], [clash(a, b, 15 * 60_000), clash(b, c, 45 * 60_000)]);
  assert.equal(groups.size, 3);
  for (const member of [a, b, c]) {
    assert.deepEqual(
      groups
        .get(eventKey(member))
        ?.members.map((entry) => entry.id)
        .sort(),
      ["a", "b", "c"],
    );
    assert.equal(groups.get(eventKey(member))?.overlapMs, 45 * 60_000);
  }
});

test("a clash referencing an event outside this fetch is ignored rather than thrown", () => {
  const a = event("a", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z");
  // "gone" is a real event, just not part of this fetch (events only carries [a]) — a
  // superseded snapshot's clash pointing at something no longer around.
  const gone = event("gone", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z");
  assert.deepEqual(clashGroupsOf([a], [clash(a, gone, 10 * 60_000)]), new Map());
});

test("events from different accounts still merge into one collision block", () => {
  // Same bare id convention as every other test here ("a", "b"), but two different accounts
  // — the whole premise of this plugin is several accounts' calendars at once.
  const a = event("a", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z", false, "work");
  const b = event("b", "2026-09-09T11:30:00.000Z", "2026-09-09T12:30:00.000Z", false, "home");
  const groups = clashGroupsOf([a, b], [clash(a, b, 30 * 60_000)]);
  assert.equal(groups.size, 2);
  assert.deepEqual(
    groups
      .get(eventKey(a))
      ?.members.map((entry) => entry.id)
      .sort(),
    ["a", "b"],
  );
  assert.deepEqual(groups.get(eventKey(b)), groups.get(eventKey(a)));
});

test("two accounts' copies of a shared meeting (identical bare id) are resolved independently, not collapsed to whichever came last", () => {
  // An id is only promised unique within one account — mA and mB here share one, read through
  // two of this person's own connected accounts. clashGroupsOf once resolved a clash side
  // through `new Map(events.map(e => [e.id, e]))`, which can only remember one event per bare id.
  const mA = event("m1", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z", false, "accA");
  const mB = event("m1", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z", false, "accB");
  const n = event("n1", "2026-09-09T10:30:00.000Z", "2026-09-09T11:30:00.000Z", false, "accC");
  const groups = clashGroupsOf([mA, mB, n], [clash(mA, n, 30 * 60_000), clash(mB, n, 30 * 60_000)]);
  const expectedMembers = [eventKey(mA), eventKey(mB), eventKey(n)].sort();
  assert.deepEqual(
    groups
      .get(eventKey(mA))
      ?.members.map(eventKey)
      .sort(),
    expectedMembers,
  );
  // Neither copy is silently dropped from the group in favour of the other.
  assert.deepEqual(groups.get(eventKey(mB)), groups.get(eventKey(mA)));
  assert.deepEqual(groups.get(eventKey(n)), groups.get(eventKey(mA)));
});

// --- partnersOf ---

test("partnersOf reports only the pairs that genuinely touch this event, each with its own duration", () => {
  // Same chain as above: a-b overlap 15 min, b-c overlap 45 min, a and c never touch.
  const a = event("a", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z");
  const b = event("b", "2026-09-09T10:45:00.000Z", "2026-09-09T12:00:00.000Z");
  const c = event("c", "2026-09-09T11:15:00.000Z", "2026-09-09T12:30:00.000Z");
  const clashes = [clash(a, b, 15 * 60_000), clash(b, c, 45 * 60_000)];

  assert.deepEqual(partnersOf(a, [a, b, c], clashes), [{ event: b, overlapMs: 15 * 60_000 }]);
  assert.deepEqual(partnersOf(c, [a, b, c], clashes), [{ event: b, overlapMs: 45 * 60_000 }]);
  // b genuinely overlaps both, unlike the group's blanket view — sorted by partner start.
  assert.deepEqual(partnersOf(b, [a, b, c], clashes), [
    { event: a, overlapMs: 15 * 60_000 },
    { event: c, overlapMs: 45 * 60_000 },
  ]);
});

test("partnersOf tells two accounts' copies of a shared meeting (identical bare id) apart", () => {
  const mA = event("m1", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z", false, "accA");
  const mB = event("m1", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z", false, "accB");
  const n = event("n1", "2026-09-09T10:30:00.000Z", "2026-09-09T11:30:00.000Z", false, "accC");
  const clashes = [clash(mA, n, 30 * 60_000), clash(mB, n, 30 * 60_000)];

  assert.deepEqual(partnersOf(mA, [mA, mB, n], clashes), [{ event: n, overlapMs: 30 * 60_000 }]);
  assert.deepEqual(partnersOf(mB, [mA, mB, n], clashes), [{ event: n, overlapMs: 30 * 60_000 }]);
  // n genuinely clashes with both distinct rows and must report both, not collapse to one
  // bare id and answer for only whichever copy a Map happened to keep.
  assert.deepEqual(partnersOf(n, [mA, mB, n], clashes), [
    { event: mA, overlapMs: 30 * 60_000 },
    { event: mB, overlapMs: 30 * 60_000 },
  ]);
});

test("partnersOf reports nothing for an event with no clashes", () => {
  const a = event("a", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z");
  assert.deepEqual(partnersOf(a, [a], []), []);
});

// --- agendaOf ---

test("agendaOf merges a same-day clash into one row", () => {
  const a = event("a", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z");
  const b = event("b", "2026-09-09T11:30:00.000Z", "2026-09-09T12:15:00.000Z");
  const days = agendaOf([a, b], [clash(a, b, 30 * 60_000)]);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].rows, [{ kind: "clash", members: [a, b], overlapMs: 30 * 60_000 }]);
});

test("a clash spanning local midnight renders its group exactly once, not once per day", () => {
  // Built from local-time components (not fixed UTC strings) so this straddles a
  // local-midnight boundary in whatever timezone the test happens to run in, rather than
  // assuming the runner sits near UTC. September is month index 8.
  const localMidnight = new Date(2026, 8, 10, 0, 0, 0, 0).getTime();
  const a = event(
    "a",
    new Date(localMidnight - 15 * 60_000).toISOString(),
    new Date(localMidnight + 30 * 60_000).toISOString(),
  );
  const b = event(
    "b",
    new Date(localMidnight + 15 * 60_000).toISOString(),
    new Date(localMidnight + 60 * 60_000).toISOString(),
  );
  const days = agendaOf([a, b], [clash(a, b, 15 * 60_000)]);

  const allIds = days
    .flatMap((day) => day.rows)
    .flatMap((row) => (row.kind === "single" ? [row.event.id] : row.members.map((member) => member.id)));
  assert.deepEqual(allIds.sort(), ["a", "b"]);

  // Whether this lands as one day-bucket or two depends on the runner's offset, but either
  // way the pair is exactly one merged row — never a single on one day and a clash on the
  // other, which is the bug this test exists to catch.
  const clashRows = days.flatMap((day) => day.rows).filter((row) => row.kind === "clash");
  assert.equal(clashRows.length, 1);
});

test("no events means no agenda days, not one empty day", () => {
  assert.deepEqual(agendaOf([], []), []);
});

test("a multi-day all-day event with no clash renders on every day, not only its first", () => {
  // An all-day event can never be part of a clash (overlap.ts excludes it), so this always
  // takes agendaOf's "single" branch, which must not dedupe across days.
  const conference = event("conference", "2026-09-10", "2026-09-13", true);
  const days = agendaOf([conference], []);
  assert.deepEqual(
    days.map((day) => day.day),
    ["2026-09-10", "2026-09-11", "2026-09-12"],
  );
  for (const day of days) {
    assert.deepEqual(day.rows, [{ kind: "single", event: conference }]);
  }
});

// --- The day view and the month grid ---

test("a multi-day all-day event is filed under every day it covers, so the month counts each", () => {
  const conference = event("conference", "2026-09-14", "2026-09-17", true);
  const standup = event("standup", "2026-09-14T07:00:00.000Z", "2026-09-14T07:15:00.000Z");
  const days = eventsByDay([conference, standup]);
  assert.deepEqual([...days.keys()].sort(), ["2026-09-14", "2026-09-15", "2026-09-16"]);
  assert.deepEqual(days.get("2026-09-14")?.map((entry) => entry.id), ["conference", "standup"]);
  assert.deepEqual(days.get("2026-09-16")?.map((entry) => entry.id), ["conference"]);
});

test("a day lists a multi-day event once, and on every day it covers", () => {
  const conference = event("conference", "2026-09-14", "2026-09-17", true);
  const standup = event("standup", "2026-09-14T07:00:00.000Z", "2026-09-14T07:15:00.000Z");
  const days = eventsByDay([conference, standup]);
  const monday = dayAgenda(days.get("2026-09-14") ?? [], [], "2026-09-14");
  assert.deepEqual(monday.map((row) => (row.kind === "single" ? row.event.id : "clash")), ["conference", "standup"]);
  const tuesday = dayAgenda(days.get("2026-09-15") ?? [], [], "2026-09-15");
  assert.deepEqual(tuesday.map((row) => (row.kind === "single" ? row.event.id : "clash")), ["conference"]);
});
