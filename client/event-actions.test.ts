import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../shared/i18n.ts";
import { eventRowLabel, isInvitation, ownActions } from "./event-actions.ts";

const oneOff = { recurring: false, allDay: false };

test("a one-off meeting of yours in the fortnight can be edited and deleted", () => {
  assert.deepEqual(ownActions(oneOff, true), { offered: true, edit: true, remove: true, notes: [] });
});

test("outside the fortnight the server would refuse both, so neither is offered and Calendar is named", () => {
  assert.deepEqual(ownActions(oneOff, false), { offered: false, edit: false, remove: false, notes: ["outside"] });
  assert.deepEqual(ownActions({ recurring: true, allDay: false }, false).notes, ["outside"]);
});

test("a repeating meeting is neither edited nor deleted", () => {
  assert.deepEqual(ownActions({ recurring: true, allDay: false }, true), { offered: true, edit: false, remove: false, notes: ["series"] });
});

test("an all-day event can be deleted but not edited: the form would write its dates back as UTC instants", () => {
  assert.deepEqual(ownActions({ recurring: false, allDay: true }, true), { offered: true, edit: false, remove: true, notes: ["allDay"] });
});

const guest = (over: { self?: boolean; organiser?: boolean } = {}) => ({ name: "", email: "", response: "accepted" as const, self: false, organiser: false, company: null, ...over });

test("only a meeting somebody else organised, with guests, is an invitation to answer", () => {
  assert.equal(isInvitation({ mine: false, attendees: [guest({ organiser: true }), guest({ self: true })] }), true);
  assert.equal(isInvitation({ mine: false, attendees: [] }), false, "a holiday or a birthday has no guests");
  assert.equal(isInvitation({ mine: false, attendees: [guest({ self: true, organiser: true })] }), false, "your own CalDAV meeting");
  assert.equal(isInvitation({ mine: true, attendees: [guest()] }), false);
});

test("a row is read out with its time, title and calendar, and says when it overlaps", () => {
  const en = t("en");
  const row = { title: "Standup", calendarName: "Work", allDay: false, start: "2026-10-26T09:00:00.000Z" };
  assert.equal(eventRowLabel(row, "09:00", false, en), "09:00, Standup, Work");
  assert.equal(eventRowLabel(row, "09:00", true, en), `09:00, Standup, Work, ${en.overlapsA11y}`);
  assert.equal(eventRowLabel({ ...row, allDay: true }, "", false, en), `${en.allDay}, Standup, Work`);
});
