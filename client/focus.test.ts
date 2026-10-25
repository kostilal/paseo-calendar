import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFocus, pendingFocus, requestFocus, subscribeFocus } from "./focus.ts";

test("a request made before anyone is listening still waits to be collected", () => {
  // The ordering this module exists for: the pill is pressed, the board mounts afterwards.
  // A callback would have had nobody to call.
  clearFocus();
  requestFocus("acc-1:evt-9");
  assert.equal(pendingFocus(), "acc-1:evt-9");
  clearFocus();
  assert.equal(pendingFocus(), null);
});

test("reading does not collect, because the reader may not be ready to act on it", () => {
  // The board reads on every render; on the first one its events have not arrived and it
  // cannot find the event yet. If reading cleared, that press would be lost silently.
  clearFocus();
  requestFocus("acc-1:evt-9");
  assert.equal(pendingFocus(), "acc-1:evt-9");
  assert.equal(pendingFocus(), "acc-1:evt-9");
  clearFocus();
});

test("a listener hears about a request made while it is subscribed", () => {
  clearFocus();
  let heard = 0;
  const stop = subscribeFocus(() => heard++);
  requestFocus("acc-1:evt-9");
  assert.equal(heard, 1);
  stop();
  requestFocus("acc-1:evt-10");
  assert.equal(heard, 1, "unsubscribing has to actually stop delivery");
  clearFocus();
});

test("a listener that unsubscribes itself mid-notification does not break the rest", () => {
  clearFocus();
  const seen: string[] = [];
  const stopFirst = subscribeFocus(() => {
    seen.push("first");
    stopFirst();
  });
  const stopSecond = subscribeFocus(() => seen.push("second"));
  requestFocus("acc-1:evt-9");
  assert.deepEqual(seen, ["first", "second"]);
  stopSecond();
  clearFocus();
});
