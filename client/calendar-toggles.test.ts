import assert from "node:assert/strict";
import { test } from "node:test";
import { applyToggles, toggleKey } from "./calendar-toggles.ts";

const view = () => ({
  accounts: [
    { id: "a", calendars: [{ id: "c1", name: "Work", shown: true }, { id: "c2", name: "Birthdays", shown: false }] },
    { id: "b", calendars: [{ id: "c1", name: "Home", shown: true }] },
  ],
});

test("a toggle flips one calendar of one account and leaves the rest as they were", () => {
  const before = view();
  const after = applyToggles(before, [{ accountId: "a", calendarId: "c1", shown: false }]);
  assert.deepEqual(after.accounts[0].calendars.map((c) => c.shown), [false, false]);
  assert.equal(after.accounts[1], before.accounts[1], "another account is the same object");
  assert.equal(before.accounts[0].calendars[0].shown, true, "the cache entry it came from is not mutated");
});

test("no toggles, or toggles for something gone, hand back the same object", () => {
  const before = view();
  assert.equal(applyToggles(before, []), before);
  assert.equal(applyToggles(before, [{ accountId: "zz", calendarId: "c1", shown: false }]), before);
});

test("the server's answer is re-dressed with the toggles still in flight", () => {
  // The answer to toggle A was computed before toggle B's write; B must not flick back.
  const answer = view();
  const dressed = applyToggles(answer, [{ accountId: "a", calendarId: "c2", shown: true }]);
  assert.deepEqual(dressed.accounts[0].calendars.map((c) => c.shown), [true, true]);
});

test("rolling back is the inverse toggle, so a neighbour's change survives", () => {
  const optimistic = applyToggles(view(), [
    { accountId: "a", calendarId: "c1", shown: false },
    { accountId: "a", calendarId: "c2", shown: true },
  ]);
  const rolledBack = applyToggles(optimistic, [{ accountId: "a", calendarId: "c1", shown: true }]);
  assert.deepEqual(rolledBack.accounts[0].calendars.map((c) => c.shown), [true, true]);
});

test("toggleKey is the row-error key", () => {
  assert.equal(toggleKey({ accountId: "a", calendarId: "c1" }), "a:c1");
});
