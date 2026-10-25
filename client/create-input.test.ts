import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AccountChoice,
  buildCreateInput,
  classifyCreateError,
  type CreateDraft,
  createOutcome,
  defaultStartText,
  isHiddenTarget,
  pickSelection,
  writableAccounts,
} from "./create-input.ts";

// The whole point of this module is that a wall clock typed by a person becomes the right
// instant, so the tests run in a fixed zone rather than whichever one the machine is in.
// node --test gives every file its own process, so this affects nothing else.
process.env.TZ = "Europe/Kyiv";

function draft(overrides: Partial<CreateDraft> = {}): CreateDraft {
  return {
    accountId: "acc",
    calendarId: "cal",
    title: "Stand-up",
    start: "2026-09-12T15:00",
    duration: "60",
    description: "",
    ...overrides,
  };
}

function account(id: string, calendars: Array<{ id: string; shown: boolean }>, over: Partial<AccountChoice> = {}): AccountChoice {
  return {
    id,
    kind: "exchange",
    errorCode: "",
    calendars: calendars.map((calendar) => ({ id: calendar.id, name: calendar.id, shown: calendar.shown })),
    ...over,
  };
}

test("15:00 in the client's own zone is sent as the instant it actually is", () => {
  const built = buildCreateInput(draft());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  // Kyiv is UTC+3 in September: 15:00 local is 12:00Z. Sending "15:00" raw would land the
  // meeting three hours out — the exact mistake this whole area invites.
  assert.equal(built.fields.start, "2026-09-12T12:00:00.000Z");
  assert.equal(built.fields.end, "2026-09-12T13:00:00.000Z");
});

test("the end is the duration away from the start, in real minutes", () => {
  const built = buildCreateInput(draft({ duration: "90" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const span = new Date(built.fields.end).getTime() - new Date(built.fields.start).getTime();
  assert.equal(span, 90 * 60_000);
});

test("a start that is not a wall clock is refused", () => {
  const built = buildCreateInput(draft({ start: "12/09/2026 15:00" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.deepEqual(built.problems, ["start"]);
});

test("a day that does not exist is refused rather than rolled forward", () => {
  const built = buildCreateInput(draft({ start: "2026-02-30T10:00" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.deepEqual(built.problems, ["start"]);
});

test("an hour that does not exist is refused too", () => {
  const built = buildCreateInput(draft({ start: "2026-09-12T25:00" }));
  assert.equal(built.ok, false);
});

test("a title of nothing but spaces is not a title", () => {
  const built = buildCreateInput(draft({ title: "   " }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.deepEqual(built.problems, ["title"]);
});

test("the request carries only what EventKit writes: title, time and notes", () => {
  const built = buildCreateInput(draft({ description: "  agenda  " }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(Object.keys(built.fields).sort(), ["accountId", "calendarId", "description", "end", "start", "title"]);
  assert.equal(built.fields.description, "agenda");
});

test("the title and description are trimmed before they are sent", () => {
  const built = buildCreateInput(draft({ title: "  Stand-up  ", description: "  agenda  " }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.fields.title, "Stand-up");
  assert.equal(built.fields.description, "agenda");
});

test("a duration has to be a positive whole number of minutes", () => {
  for (const duration of ["0", "-15", "abc", "12.5", ""]) {
    const built = buildCreateInput(draft({ duration }));
    assert.equal(built.ok, false, `expected ${duration} to be refused`);
    if (built.ok) continue;
    assert.deepEqual(built.problems, ["duration"]);
  }
});

test("every problem is reported at once, not one per attempt", () => {
  const built = buildCreateInput(draft({ title: "", start: "soon", duration: "x" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.deepEqual(built.problems, ["title", "start", "duration"]);
});

test("a draft with no calendar chosen cannot be built", () => {
  const built = buildCreateInput(draft({ accountId: "", calendarId: "" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.deepEqual(built.problems, ["calendar"]);
});

test("a valid account and calendar pair is left alone", () => {
  const accounts = [account("a", [{ id: "a1", shown: true }, { id: "a2", shown: true }])];
  assert.deepEqual(pickSelection(accounts, { accountId: "a", calendarId: "a2" }), {
    accountId: "a",
    calendarId: "a2",
  });
});

test("a calendar belonging to another account is never carried over", () => {
  // Switching account with a stale calendarId would write to the wrong calendar, or to a
  // calendar the chosen account cannot even see.
  const accounts = [
    account("a", [{ id: "a1", shown: true }]),
    account("b", [{ id: "b1", shown: false }, { id: "b2", shown: true }]),
  ];
  assert.deepEqual(pickSelection(accounts, { accountId: "b", calendarId: "a1" }), {
    accountId: "b",
    calendarId: "b2",
  });
});

test("an account whose calendars are all hidden still offers one to write to", () => {
  // shown is an agenda preference, not a permission: hiding a calendar must not make it
  // impossible to put anything in it.
  const offered = writableAccounts([account("a", [{ id: "a1", shown: false }])]);
  assert.deepEqual(pickSelection(offered, { accountId: "", calendarId: "" }), { accountId: "a", calendarId: "a1" });
});

test("no accounts at all selects nothing rather than inventing an id", () => {
  assert.deepEqual(pickSelection([], { accountId: "a", calendarId: "a1" }), { accountId: "", calendarId: "" });
});

test("the default start is the next quarter hour, never the one just gone", () => {
  assert.equal(defaultStartText(new Date(2026, 8, 12, 10, 0, 0)), "2026-09-12T10:15");
  assert.equal(defaultStartText(new Date(2026, 8, 12, 10, 14, 59)), "2026-09-12T10:15");
  assert.equal(defaultStartText(new Date(2026, 8, 12, 10, 52, 0)), "2026-09-12T11:00");
});

test("the default start rolls over midnight and pads single digits", () => {
  assert.equal(defaultStartText(new Date(2026, 0, 4, 23, 55, 0)), "2026-01-05T00:00");
  assert.equal(defaultStartText(new Date(2026, 0, 5, 9, 1, 0)), "2026-01-05T09:15");
});

test("only accounts that can take a new event are offered", () => {
  const offered = writableAccounts([
    account("ex", [{ id: "e1", shown: true }]),
    account("bd", [{ id: "b1", shown: true }], { kind: "birthdays" }),
    account("sub", [{ id: "s1", shown: true }], { kind: "subscribed" }),
    account("gone", [{ id: "g1", shown: true }], { errorCode: "source_gone" }),
    account("empty", []),
    account("old", [{ id: "o1", shown: true }], { kind: "" }),
  ]);
  assert.deepEqual(offered.map((entry) => entry.id), ["ex", "old"]);
});

test("writing to a calendar switched off in Settings is what adds the not-on-the-board line", () => {
  const offered = [account("a", [{ id: "a1", shown: false }, { id: "a2", shown: true }])];
  assert.equal(isHiddenTarget(offered, { accountId: "a", calendarId: "a1" }), true);
  assert.equal(isHiddenTarget(offered, { accountId: "a", calendarId: "a2" }), false);
  assert.equal(isHiddenTarget(offered, { accountId: "a", calendarId: "gone" }), false, "an unknown calendar says nothing");
  assert.equal(isHiddenTarget(offered, { accountId: "zz", calendarId: "a1" }), false, "nor does another account's id");
});

test("with nothing chosen yet, the first account offered is chosen", () => {
  const offered = [account("first", [{ id: "f1", shown: true }]), account("second", [{ id: "s1", shown: true }])];
  assert.deepEqual(pickSelection(offered, { accountId: "", calendarId: "" }), { accountId: "first", calendarId: "f1" });
});

test("a save EventKit refused as read-only is told apart, in the helper's three languages", () => {
  for (const message of [
    "could not save: The calendar is read only.",
    "could not save: That calendar does not allow events to be added.",
    "could not save: Календарь доступен только для чтения.",
    "could not save: Этот календарь не предусматривает добавление событий.",
    "could not save: Календар доступний лише для перегляду.",
    "could not save: Цей календар не дозволяє додавання подій.",
    "this calendar account is read-only on this Mac: subscribed and birthday calendars do not accept new events",
  ]) assert.equal(classifyCreateError(message), "read_only", message);
});

test("a calendar the helper cannot find is told apart from everything else", () => {
  assert.equal(classifyCreateError("calendar not found: ABC — reconnect the account to re-read its calendars"), "calendar_missing");
  assert.equal(classifyCreateError("eventkit helper timed out after 15000ms"), "other");
});

test("a create whose answer never arrived may have been saved, so it is not offered as a plain retry", () => {
  assert.equal(createOutcome({ answer: { error: "" } }), "created");
  assert.equal(createOutcome({ answer: { error: "could not save: read only" } }), "refused", "the daemon answered: nothing was written");
  // The daemon writes, then refreshes, then answers: a connection lost in between loses only the answer.
  assert.equal(createOutcome({ thrown: new Error("Plugin RPC timed out") }), "uncertain");
});
