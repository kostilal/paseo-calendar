import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubmitLatch } from "./submit-latch.ts";

test("the first press claims the latch and the second gets nothing", () => {
  const latch = createSubmitLatch();
  assert.equal(latch.claim(), true);
  // The second press is the whole point: it lands before isPending has reached the touch
  // responder, and it must not reach createEvent.
  assert.equal(latch.claim(), false);
  assert.equal(latch.claim(), false);
});

test("releasing lets the next attempt through, so a failed write is still retryable", () => {
  const latch = createSubmitLatch();
  latch.claim();
  latch.release();
  assert.equal(latch.claim(), true);
});

test("a release nobody was waiting for changes nothing", () => {
  const latch = createSubmitLatch();
  latch.release();
  latch.release();
  assert.equal(latch.held(), false);
  assert.equal(latch.claim(), true);
});

test("held() is what a Cancel button reads before acting", () => {
  const latch = createSubmitLatch();
  assert.equal(latch.held(), false);
  latch.claim();
  // Cancel is specifically designed never to reach an in-flight write; this is how it knows.
  assert.equal(latch.held(), true);
  latch.release();
  assert.equal(latch.held(), false);
});

test("two forms hold their own latches", () => {
  const first = createSubmitLatch();
  const second = createSubmitLatch();
  first.claim();
  assert.equal(second.held(), false);
  assert.equal(second.claim(), true);
});
