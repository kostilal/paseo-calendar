import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLabel, carryShown, readOnlyKind, relinkCandidate, relinkSuspect } from "./accounts.ts";

// The real case: macOS re-added an Exchange mailbox under a new source id.
const exchange = { sourceId: "src-exchange-old", title: "Exchange", kind: "exchange", calendars: [{ name: "Calendar" }, { name: "Birthdays" }] };
const moved = { id: "src-exchange-new", title: "Exchange", kind: "exchange", calendars: 2, connected: false };
const google = { id: "s-google", title: "Google", kind: "caldav", calendars: 3, connected: true };
const connected = new Set(["src-exchange-old", "s-google"]);
const names = ["Calendar", "Birthdays"];

test("the moved Exchange account is offered the one unconnected source that matches it", () => {
  assert.deepEqual(relinkCandidate(exchange, [google, moved], connected, names), moved);
  assert.deepEqual(relinkSuspect(exchange, [google, moved], connected), moved);
});
test("a migrated row with no kind matches on its title alone", () => {
  assert.deepEqual(relinkCandidate({ ...exchange, kind: "" }, [google, moved], connected, names), moved);
});
test("a source still on this Mac is never offered a relink", () => {
  assert.equal(relinkCandidate(exchange, [google, moved, { ...moved, id: "src-exchange-old" }], connected, names), null);
});
test("two unconnected sources with the same title are not guessed between", () => {
  assert.equal(relinkCandidate(exchange, [moved, { ...moved, id: "77AA-OTHER" }], connected, names), null);
  assert.equal(relinkSuspect(exchange, [moved, { ...moved, id: "77AA-OTHER" }], connected), null);
});
test("a source some row already reads is not a candidate", () => {
  assert.equal(relinkCandidate(exchange, [moved], new Set([...connected, "src-exchange-new"]), names), null);
});
test("a different kind is not a candidate when the row knows its kind", () => {
  assert.equal(relinkCandidate(exchange, [{ ...moved, kind: "caldav" }], connected, names), null);
});
test("a stored calendar the candidate lacks blocks the relink", () => {
  assert.equal(relinkCandidate(exchange, [moved], connected, ["Calendar"]), null);
});
test("a name collision on either side blocks the relink", () => {
  // One candidate name, so only the stored side's repeat can refuse it.
  assert.equal(relinkCandidate({ ...exchange, calendars: [{ name: "Calendar" }, { name: "Calendar" }] }, [moved], connected, ["Calendar"]), null);
  assert.equal(relinkCandidate(exchange, [moved], connected, ["Calendar", "Calendar", "Birthdays"]), null);
});
test("an extra calendar on the candidate does not block it", () => {
  assert.deepEqual(relinkCandidate(exchange, [moved], connected, ["Calendar", "Birthdays", "Holidays"]), moved);
});
test("a row with no calendars is never relinked: there is nothing to confirm it by", () => {
  assert.equal(relinkCandidate({ ...exchange, calendars: [] }, [moved], connected, names), null);
});
test("carryShown keeps hidden calendars hidden across new ids, and shows new names", () => {
  assert.deepEqual(
    carryShown(
      [{ id: "old-1", name: "Calendar", shown: true }, { id: "old-2", name: "Birthdays", shown: false }],
      [{ id: "new-1", name: "Calendar" }, { id: "new-2", name: "Birthdays" }, { id: "new-3", name: "Holidays" }],
    ),
    [{ id: "new-1", name: "Calendar", shown: true }, { id: "new-2", name: "Birthdays", shown: false }, { id: "new-3", name: "Holidays", shown: true }],
  );
});
test("carryShown carries a repeated name only when every old copy agreed", () => {
  const fresh = [{ id: "n1", name: "Calendar" }, { id: "n2", name: "Calendar" }];
  assert.deepEqual(carryShown([{ id: "o1", name: "Calendar", shown: false }, { id: "o2", name: "Calendar", shown: false }], fresh).map((c) => c.shown), [false, false]);
  assert.deepEqual(carryShown([{ id: "o1", name: "Calendar", shown: false }, { id: "o2", name: "Calendar", shown: true }], fresh).map((c) => c.shown), [true, true]);
});
test("a row is named by its mailbox when known, else by the macOS title", () => {
  assert.equal(accountLabel({ owner: "me@example.com", title: "Exchange" }), "me@example.com");
  assert.equal(accountLabel({ owner: "", title: "Exchange" }), "Exchange");
  assert.equal(accountLabel({ owner: "   ", title: "Exchange" }), "Exchange");
});

test("subscribed and birthday sources are the read-only kinds; unknown is not", () => {
  assert.deepEqual(["subscribed", "birthdays", "exchange", "caldav", "icloud", "local", ""].map(readOnlyKind),
    [true, true, false, false, false, false, false]);
});
