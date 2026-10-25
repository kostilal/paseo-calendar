import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventsView, EventView } from "../shared/calendar.ts";
import { t } from "../shared/i18n.ts";
import { announcePillLead, createPillWatch, nudgePill } from "./pill-watch.ts";

const NOW = Date.parse("2026-10-26T09:00:00.000Z");
const MIN = 60_000;
const en = t("en");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function meeting(id: string, startMs: number, endMs = startMs + 30 * MIN): EventView {
  return {
    id, accountId: "acc", calendarId: "c", calendarName: "Work", title: "Standup",
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), allDay: false,
    recurring: false, mine: true, attendees: [], location: "", description: "", webLink: "",
    myResponse: "accepted", joinUrl: "", joinKind: "none", alsoIn: [],
  };
}

function eventsOf(events: EventView[]): EventsView {
  return { events, clashes: [], errors: [], syncedAt: "2026-10-26T08:58:00.000Z", version: "v1", unchanged: false };
}

/** A clock the test winds by hand: tick(n) is n evaluations elapsing. */
function fakeTicker() {
  let run: (() => void) | null = null;
  let interval = 0;
  let cancels = 0;
  return {
    ticker: (fn: () => void, ms: number) => { run = fn; interval = ms; return () => { cancels += 1; run = null; }; },
    tick: (times = 1) => { for (let i = 0; i < times; i += 1) run?.(); },
    interval: () => interval,
    cancelled: () => cancels,
  };
}

test("a hidden pill comes back on the clock alone, with no RPC riding along", async () => {
  let now = NOW;
  let polls = 0;
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: async () => { polls += 1; return eventsOf([meeting("evt-1", NOW + 40 * MIN)]); },
    loadLead: async () => 30, strings: () => en, now: () => now, ticker: clock.ticker,
  });
  await settle();
  assert.equal(clock.interval(), 15_000);
  assert.equal(watch.snapshot().visible, false);
  now = NOW + 10 * MIN;
  clock.tick();
  assert.equal(watch.snapshot().visible, true, "the lead time arrived and nobody had to do anything");
  assert.equal(watch.snapshot().label, "Standup in 30 min");
  assert.equal(polls, 1, "the evaluation reads what the last poll kept");
  watch.stop();
});

test("it polls once a minute and re-reads the lead once in ten", async () => {
  let polls = 0;
  let leads = 0;
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: async () => { polls += 1; return eventsOf([]); },
    loadLead: async () => { leads += 1; return 30; }, strings: () => en, now: () => NOW, ticker: clock.ticker,
  });
  await settle();
  clock.tick(4); await settle();
  assert.equal(polls, 2);
  // A minute at a time, so each poll lands before the next is due.
  for (let minute = 0; minute < 9; minute += 1) { clock.tick(4); await settle(); }
  assert.equal(polls, 11);
  assert.equal(leads, 2);
  watch.stop();
});

test("a failed poll keeps the meeting rather than hiding the pill", async () => {
  let fail = false;
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: async () => { if (fail) throw new Error("plugin reloading"); return eventsOf([meeting("evt-1", NOW + 12 * MIN)]); },
    loadLead: async () => 30, strings: () => en, now: () => NOW, ticker: clock.ticker,
  });
  await settle();
  const before = watch.snapshot();
  assert.equal(before.visible, true);
  fail = true;
  clock.tick(4); await settle();
  assert.equal(watch.snapshot(), before);
  watch.stop();
});

test("listeners hear a change once, and nothing while nothing visible moved", async () => {
  let now = NOW;
  let heard = 0;
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: async () => eventsOf([meeting("evt-1", NOW + 12 * MIN)]),
    loadLead: async () => 30, strings: () => en, now: () => now, ticker: clock.ticker,
  });
  watch.subscribe(() => { heard += 1; });
  await settle();
  assert.equal(heard, 1);
  const first = watch.snapshot();
  now = NOW + 1_000;
  clock.tick();
  assert.equal(heard, 1);
  assert.equal(watch.snapshot(), first, "same state, same object: useSyncExternalStore must not spin");
  watch.stop();
});

test("the lead is 30 minutes until settings answer, and a change made in Settings lands at once", async () => {
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: async () => eventsOf([meeting("evt-1", NOW + 20 * MIN)]),
    loadLead: () => new Promise<number>(() => {}), strings: () => en, now: () => NOW, ticker: clock.ticker,
  });
  await settle();
  assert.equal(watch.snapshot().visible, true);
  announcePillLead(10);
  assert.equal(watch.snapshot().visible, false);
  watch.stop();
});

test("nudgePill polls every live watch now, and none that stopped", async () => {
  const counts = { a: 0, b: 0 };
  const make = (key: "a" | "b") => createPillWatch({
    loadEvents: async () => { counts[key] += 1; return eventsOf([]); },
    loadLead: async () => 30, strings: () => en, now: () => NOW, ticker: fakeTicker().ticker,
  });
  const a = make("a");
  const b = make("b");
  await settle();
  b.stop();
  nudgePill(); await settle();
  assert.deepEqual(counts, { a: 2, b: 1 });
  a.stop();
});

test("a nudge while a poll is in flight polls once more when it lands", async () => {
  let polls = 0;
  let land: (view: EventsView) => void = () => {};
  const watch = createPillWatch({
    loadEvents: () => { polls += 1; return new Promise<EventsView>((resolve) => { land = resolve; }); },
    loadLead: async () => 30, strings: () => en, now: () => NOW, ticker: fakeTicker().ticker,
  });
  nudgePill(); nudgePill();
  assert.equal(polls, 1, "still one poll at a time");
  land(eventsOf([]));
  await settle();
  assert.equal(polls, 2, "the poll in flight may predate the change, so exactly one more follows");
  watch.stop();
});

test("stop cancels the clock and ignores an answer that lands afterwards", async () => {
  let answer: (view: EventsView) => void = () => {};
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: () => new Promise<EventsView>((resolve) => { answer = resolve; }),
    loadLead: async () => 30, strings: () => en, now: () => NOW, ticker: clock.ticker,
  });
  const before = watch.snapshot();
  watch.stop();
  answer(eventsOf([meeting("evt-1", NOW + 12 * MIN)]));
  await settle();
  assert.equal(watch.snapshot(), before);
  assert.equal(clock.cancelled(), 1);
});

test("polls do not pile up behind a daemon that is not answering", async () => {
  let polls = 0;
  const clock = fakeTicker();
  const watch = createPillWatch({
    loadEvents: () => { polls += 1; return new Promise<EventsView>(() => {}); },
    loadLead: async () => 30, strings: () => en, now: () => NOW, ticker: clock.ticker,
  });
  clock.tick(8);
  assert.equal(polls, 1);
  watch.stop();
});

test("the watch sends back the version it holds, and keeps its meeting on an unchanged answer", async () => {
  const sinces: Array<string | undefined> = [];
  let answer: EventsView = eventsOf([meeting("evt-1", NOW + 12 * MIN)]);
  const watch = createPillWatch({
    loadEvents: async (since) => { sinces.push(since); return answer; },
    loadLead: async () => 30, strings: () => en, now: () => NOW, ticker: fakeTicker().ticker,
  });
  await settle();
  const before = watch.snapshot();
  answer = { events: [], clashes: [], errors: [], syncedAt: "2026-10-26T09:05:00.000Z", version: "v1", unchanged: true };
  nudgePill(); await settle();
  assert.deepEqual(sinces, [undefined, "v1"]);
  assert.equal(watch.snapshot(), before);
  assert.equal(watch.snapshot().label, "Standup in 12 min");
  watch.stop();
});
