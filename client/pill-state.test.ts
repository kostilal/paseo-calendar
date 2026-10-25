import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventView } from "../shared/calendar.ts";
import { t } from "../shared/i18n.ts";
import { pillPatch, pillState, samePillState } from "./pill-state.ts";

const NOW = Date.parse("2026-10-26T09:00:00.000Z");
const MIN = 60_000;
const en = t("en");

function meeting(id: string, startMs: number, endMs = startMs + 30 * MIN): EventView {
  return {
    id, accountId: "acc", calendarId: "c", calendarName: "Work", title: "Standup",
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), allDay: false,
    recurring: false, mine: true, attendees: [], location: "", description: "", webLink: "",
    myResponse: "accepted", joinUrl: "", joinKind: "none", alsoIn: [],
  };
}

test("nothing next: hidden, labelled with the board's own empty-agenda copy", () => {
  assert.deepEqual(pillState([], NOW, 30, en), {
    label: "Nothing on the calendar.", visible: false, level: "calm", running: false, target: null,
  });
});

test("a meeting inside the lead time is shown, counted in whole minutes", () => {
  assert.deepEqual(pillState([meeting("evt-1", NOW + 12 * MIN)], NOW, 30, en), {
    label: "Standup in 12 min", visible: true, level: "calm", running: false, target: "acc:evt-1",
  });
});

test("a meeting beyond the lead time is named but not shown", () => {
  const state = pillState([meeting("evt-1", NOW + 45 * MIN)], NOW, 30, en);
  assert.equal(state.visible, false);
  assert.equal(state.label, "Standup in 45 min");
});

test("a meeting under way is shown whatever the lead, and never escalates", () => {
  assert.deepEqual(pillState([meeting("evt-1", NOW - 5 * MIN, NOW + 25 * MIN)], NOW, 10, en), {
    label: "Standup now", visible: true, level: "calm", running: true, target: "acc:evt-1",
  });
});

test("the rung follows the ladder: ten, five, one minute", () => {
  assert.equal(pillState([meeting("e", NOW + 8 * MIN)], NOW, 30, en).level, "warm");
  assert.equal(pillState([meeting("e", NOW + 4 * MIN)], NOW, 30, en).level, "urgent");
  const hot = pillState([meeting("e", NOW + MIN)], NOW, 30, en);
  assert.equal(hot.level, "hot");
  assert.equal(hot.label, "Standup in 1 min");
});

test("a lead of zero keeps the pill up all day", () => {
  assert.equal(pillState([meeting("e", NOW + 6 * 60 * MIN)], NOW, 0, en).visible, true);
});

test("samePillState compares every field, target included", () => {
  const a = pillState([meeting("evt-1", NOW + 12 * MIN)], NOW, 30, en);
  assert.equal(samePillState(a, { ...a }), true);
  assert.equal(samePillState(a, { ...a, target: "acc:evt-2" }), false);
  assert.equal(samePillState(a, { ...a, level: "warm" }), false);
});

test("pillPatch says nothing when only the icon's part moved", () => {
  const state = pillState([meeting("e", NOW + 8 * MIN)], NOW, 30, en); // warm, "Standup in 8 min", visible
  assert.equal(pillPatch({ label: "Standup in 8 min", visible: true }, state), null);
  assert.deepEqual(pillPatch({ label: "Standup in 9 min", visible: true }, state), { label: "Standup in 8 min", visible: true });
  assert.deepEqual(pillPatch({ label: "Standup in 8 min", visible: false }, state), { label: "Standup in 8 min", visible: true });
  assert.deepEqual(pillPatch(null, state), { label: "Standup in 8 min", visible: true });
});
