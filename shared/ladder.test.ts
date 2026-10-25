import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "./event.ts";
import { HOT_MS, LEAD_ALWAYS, URGENT_MS, WARM_MS, pickNext, pillVisible, pulseFor, step } from "./ladder.ts";

const NOW = Date.parse("2026-09-09T10:00:00.000Z");

function event(id: string, start: string, end: string, over: Partial<Event> = {}): Event {
  return {
    id,
    accountId: "acc",
    calendarId: "primary",
    calendarName: "Work",
    title: id,
    start,
    end,
    allDay: false,
    recurring: false,
    mine: true,
    attendees: [],
    location: "",
    description: "",
    webLink: "",
    myResponse: "accepted",
    ...over,
  };
}

test("an hour out is calm, and so is a week out", () => {
  assert.equal(step(NOW + 3_600_000, NOW), "calm");
  assert.equal(step(NOW + 7 * 86_400_000, NOW), "calm");
});

test("ten minutes is the warm boundary", () => {
  assert.equal(step(NOW + WARM_MS + 1, NOW), "calm");
  assert.equal(step(NOW + WARM_MS, NOW), "warm");
});

test("two minutes is the hot boundary", () => {
  assert.equal(step(NOW + HOT_MS + 1, NOW), "urgent");
  assert.equal(step(NOW + HOT_MS, NOW), "hot");
});

test("a meeting that has started is hot, not calm", () => {
  assert.equal(step(NOW - 60_000, NOW), "hot");
});

test("the next event is the soonest one that has not ended", () => {
  const picked = pickNext(
    [
      event("past", "2026-09-09T08:00:00.000Z", "2026-09-09T09:00:00.000Z"),
      event("later", "2026-09-09T15:00:00.000Z", "2026-09-09T16:00:00.000Z"),
      event("soon", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z"),
    ],
    NOW,
  );
  assert.equal(picked?.event.id, "soon");
  assert.equal(picked?.running, false);
});

test("a meeting under way wins over one that has not started", () => {
  const picked = pickNext(
    [
      event("running", "2026-09-09T09:30:00.000Z", "2026-09-09T10:30:00.000Z"),
      event("soon", "2026-09-09T11:00:00.000Z", "2026-09-09T12:00:00.000Z"),
    ],
    NOW,
  );
  assert.equal(picked?.event.id, "running");
  assert.equal(picked?.running, true);
});

test("all-day events and declined invitations are not what the pill shows", () => {
  const picked = pickNext(
    [
      event("allday", "2026-09-09", "2026-09-10", { allDay: true }),
      event("declined", "2026-09-09T10:30:00.000Z", "2026-09-09T11:00:00.000Z", { myResponse: "declined" }),
      event("real", "2026-09-09T12:00:00.000Z", "2026-09-09T13:00:00.000Z"),
    ],
    NOW,
  );
  assert.equal(picked?.event.id, "real");
});

test("nothing left today means nothing to show", () => {
  assert.equal(pickNext([event("past", "2026-09-09T08:00:00.000Z", "2026-09-09T09:00:00.000Z")], NOW), null);
});

// --- Four rungs, because three did not say enough ---
//
// The pill used to be calm until ten minutes, warm until two, and only then pulse. Watched
// from the corner of an eye that reads as "something changed once" — the difference between
// nine minutes and three was nothing at all, and the last two minutes looked the same as the
// first of them. The rungs now step at ten, five and one, and each pulses differently.

test("the ladder steps at ten, five and one minute", () => {
  assert.equal(step(NOW + WARM_MS + 1, NOW), "calm");
  assert.equal(step(NOW + WARM_MS, NOW), "warm");
  assert.equal(step(NOW + URGENT_MS + 1, NOW), "warm");
  assert.equal(step(NOW + URGENT_MS, NOW), "urgent");
  assert.equal(step(NOW + HOT_MS + 1, NOW), "urgent");
  assert.equal(step(NOW + HOT_MS, NOW), "hot");
});

test("calm schedules no animation at all", () => {
  // Not a pulse of zero depth: nothing running, for the twenty-three hours a day when the
  // next meeting is hours away and the pill has no business moving.
  assert.equal(pulseFor("calm"), null);
});

test("each rung is both deeper and faster than the one before it", () => {
  const warm = pulseFor("warm");
  const urgent = pulseFor("urgent");
  const hot = pulseFor("hot");
  assert.ok(warm && urgent && hot);
  // Depth escalates: the dim value falls, so the dark half of the breath gets darker.
  assert.ok(warm.dim > urgent.dim && urgent.dim > hot.dim);
  // And speed: the round trip shortens.
  assert.ok(warm.durationMs > urgent.durationMs && urgent.durationMs > hot.durationMs);
  // Still a breath at the top rung, not a strobe — anything under about a fifth of a second
  // stops reading as a pulse and starts reading as a fault.
  assert.ok(hot.durationMs >= 250);
});

// --- Whether the pill is there at all ---
//
// It used to be there always. That is defensible — a pill which materialises is itself an
// interruption — right up until you notice it also occupies the composer for the twenty-three
// hours a day when the next meeting is tomorrow. Presence is a setting now, and the old
// behaviour is one of its choices rather than something taken away.

function upcoming(startMs: number) {
  return {
    event: { start: new Date(startMs).toISOString(), end: new Date(startMs + 1800_000).toISOString(), allDay: false, myResponse: "accepted" },
    running: false,
  };
}

test("nothing next means nothing on screen", () => {
  // The case that prompted this: the pill sat there saying "nothing today" and occupying the
  // composer to do it.
  assert.equal(pillVisible(null, NOW, 30), false);
  assert.equal(pillVisible(null, NOW, LEAD_ALWAYS), false, "even set to always, there is nothing to show");
});

test("the pill appears exactly at the lead time, not a minute either side", () => {
  assert.equal(pillVisible(upcoming(NOW + 31 * 60_000), NOW, 30), false);
  assert.equal(pillVisible(upcoming(NOW + 30 * 60_000), NOW, 30), true);
  assert.equal(pillVisible(upcoming(NOW + 60_000), NOW, 30), true);
});

test("the lead time is honoured whatever it is set to", () => {
  const in45 = upcoming(NOW + 45 * 60_000);
  assert.equal(pillVisible(in45, NOW, 60), true);
  assert.equal(pillVisible(in45, NOW, 30), false);
  assert.equal(pillVisible(in45, NOW, 10), false);
});

test("zero means always, which is what the pill used to do", () => {
  assert.equal(pillVisible(upcoming(NOW + 8 * 3600_000), NOW, LEAD_ALWAYS), true);
  assert.equal(LEAD_ALWAYS, 0);
});

test("a meeting under way ignores the setting entirely", () => {
  // Being late to the one you are in is the single thing this pill exists to say. Hiding it
  // because a lead time elapsed would hide it exactly when it matters most.
  const running = { ...upcoming(NOW - 5 * 60_000), running: true };
  for (const lead of [10, 30, 60, LEAD_ALWAYS]) {
    assert.equal(pillVisible(running, NOW, lead), true, `lead ${lead}`);
  }
});

test("an unparseable start hides rather than showing a countdown to nothing", () => {
  const broken = { event: { start: "not a date", end: "not a date", allDay: false, myResponse: "accepted" }, running: false };
  assert.equal(pillVisible(broken, NOW, 30), false);
});
