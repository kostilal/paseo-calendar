import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddEventAnswer, EventsView, EventView, SettingsView } from "../shared/calendar.ts";
import type { Event } from "../shared/event.ts";
import { ACCOUNTS, NOW, ZONE, meeting } from "../shared/add-event.fixtures.ts";
import { ACCESS_HELP, ADD_ANSWER_MS, PRE_WRITE_WAIT_MS, answerAddEvent, answerCalendars, type AssistantSync } from "./assistant.ts";
import type { CreateInput } from "./eventkit.ts";
import { emptyStored, type Stored, type StoredAccount } from "./store.ts";
import { createSync } from "./sync.ts";

function settings(over: Partial<SettingsView> = {}): SettingsView {
  return { accounts: ACCOUNTS, access: "granted", pillLeadMinutes: 30, defaultView: "day", connect: null, storeAside: "", storeBroken: false, foundFailed: false, accessError: "",
    found: [{ id: "s-sub", title: "Holidays", kind: "subscribed", calendars: 1 }], ...over };
}
function view(events: EventView[], errors: EventsView["errors"] = []): EventsView {
  return { events, clashes: [], errors, syncedAt: "2026-10-25T08:58:00.000Z", version: "v1", unchanged: false };
}
/** Refreshes that do not answer until released: an account whose helper is stuck past its budget. */
function stuckRefreshes() {
  const held: (() => void)[] = [];
  let released = false;
  return {
    refresh: () => (released ? Promise.resolve(view([])) : new Promise<EventsView>((resolve) => held.push(() => resolve(view([]))))),
    /**
     * Finishes the stuck ones and answers every later one at once, so an add a failed test left
     * waiting cannot hold the add queue, and every test after it, for good.
     */
    release: () => {
      released = true;
      for (const finish of held.splice(0)) finish();
    },
  };
}
/** Runs everything already queued: with setTimeout mocked, an add then stands still only at a timer. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));
/** An add's answer once it has one, undefined while it is still waiting. */
function pending(answer: Promise<AddEventAnswer>): () => AddEventAnswer | undefined {
  let value: AddEventAnswer | undefined;
  void answer.then((settled) => { value = settled; });
  return () => value;
}
function fakeSync(options: {
  settings?: Partial<SettingsView>; views?: EventsView[]; createError?: string;
  /** Throw from this call instead of answering. */
  throws?: "settings" | "range" | "create";
  /** Every refresh hangs until release(). */
  stuckRefresh?: boolean;
}) {
  const ranges: [string, string][] = [];
  const creates: Record<string, unknown>[] = [];
  /** How many ranges had been read when each refresh was asked for. */
  const refreshes: number[] = [];
  const views = [...(options.views ?? [view([])])];
  const stuck = stuckRefreshes();
  const sync: AssistantSync = {
    settings: async () => { if (options.throws === "settings") throw new Error("boom"); return settings(options.settings); },
    range: async (from, to) => {
      if (options.throws === "range") throw new Error("boom");
      ranges.push([from.toISOString(), to.toISOString()]); return views.length > 1 ? views.shift()! : views[0];
    },
    create: async (input) => {
      creates.push({ ...input });
      if (options.throws === "create") throw new Error("the calendar helper timed out");
      return { event: null, error: options.createError ?? "" };
    },
    refresh: async () => { refreshes.push(ranges.length); return options.stuckRefresh ? stuck.refresh() : view([]); },
  };
  return { sync, ranges, creates, refreshes, release: stuck.release };
}
const INPUT = { title: "Dentist", date: "2026-10-27", start_time: "10:00", duration_minutes: 30, calendar: "me@example.com", dry_run: false };
const DAY: [string, string] = ["2026-10-26T23:00:00.000Z", "2026-10-27T23:00:00.000Z"];
const WOULD_CREATE = { title: "Dentist", date: "2026-10-27", start: "10:00", end: "10:30", timezone: ZONE, calendar: "Exchange/Calendar (me@example.com)" };
const GONE_WARNING =
  "me@example.org is not on this Mac since 2026-10-20, so its events are NOT included. Fix: System Settings → Internet Accounts → that account → turn Calendars on (re-add the account if it was removed).";

test("the calendars read lists every account by its owner, with what add_event can add to", async () => {
  const answer = await answerCalendars(fakeSync({}).sync, ZONE);
  assert.equal(answer.summary, [
    "Calendar access: granted. Time zone: Europe/Warsaw. [w] = add_event can add to it; [hidden] = switched off in Paseo, not read.",
    "- me@example.com (exchange): Calendar [w], Birthdays [hidden]",
    "- iCloud (icloud): Home [w], Calendar [w]",
    "- me@example.org (caldav): Work — not on this Mac since 2026-10-20",
    "On this Mac, not connected in Paseo: Holidays (subscribed).",
    `Warning: ${GONE_WARNING}`,
  ].join("\n"));
  assert.deepEqual(answer.warnings, [GONE_WARNING]);
  assert.deepEqual(answer.sources[0], { account: "me@example.com", title: "Exchange", kind: "exchange", on_this_mac: true,
    calendars: [{ name: "Calendar", shown: true, writable: true }, { name: "Birthdays", shown: false, writable: false }] });
  assert.deepEqual(answer.not_connected, ["Holidays"]);
  assert.equal(answer.error, "");
});

test("an account macOS re-added under a new entry is pointed at the relink, not at System Settings", async () => {
  const accounts = ACCOUNTS.map((entry) => entry.id === "old" ? { ...entry, relinkTo: { sourceId: "s-new", title: "Google", calendars: 1 } } : entry);
  const answer = await answerCalendars(fakeSync({ settings: { accounts } }).sync, ZONE);
  assert.equal(answer.warnings[0], 'me@example.org is on this Mac under a new entry ("Google"), so its events are NOT included yet. Fix: open Paseo\'s Calendar settings and accept the account found on this Mac for that row.');
});

test("without macOS calendar access the read and the add both refuse in words", async () => {
  const { sync, ranges, creates } = fakeSync({ settings: { access: "denied", found: [] } });
  const calendars = await answerCalendars(sync, ZONE);
  assert.equal(calendars.error, ACCESS_HELP);
  const added = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.equal(added.error, ACCESS_HELP);
  assert.equal(added.ok, false);
  assert.equal(added.status, "refused");
  assert.deepEqual(ranges, []);
  assert.deepEqual(creates, []);
});

test("a preview names the exact calendar and the overlaps, and writes nothing", async () => {
  const standup = meeting({ id: "s1", title: "Standup", start: "2026-10-27T08:45:00.000Z", end: "2026-10-27T09:15:00.000Z" });
  const { sync, ranges, creates } = fakeSync({ views: [view([standup])] });
  const answer = await answerAddEvent(sync, { ...INPUT, dry_run: true }, NOW, ZONE);
  assert.equal(answer.status, "dry_run");
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.would_create, WOULD_CREATE);
  assert.ok(answer.would_create && !("event_id" in answer.would_create));
  assert.deepEqual(answer.conflicts, [{ title: "Standup", start: "09:45", end: "10:15", calendar: "Calendar (me@example.com)" }]);
  assert.equal(answer.summary, "Would create: Dentist, 2026-10-27 10:00–10:30 Europe/Warsaw in Exchange/Calendar (me@example.com). Overlaps: Standup 09:45–10:15 [Calendar (me@example.com)].");
  assert.deepEqual(ranges, [DAY]);
  assert.deepEqual(creates, []);
});

test("adding writes once to the resolved calendar and reads it back", async () => {
  const { sync, ranges, creates } = fakeSync({ views: [view([]), view([meeting({ id: "new-1" })])] });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.equal(answer.status, "saved_locally_verified");
  assert.equal(answer.ok, true);
  assert.equal(answer.provider_sync, "not_confirmed");
  assert.deepEqual(answer.event, { ...WOULD_CREATE, event_id: "new-1" });
  assert.deepEqual(creates.map(({ accountId, calendarId, title, start, end }) => ({ accountId, calendarId, title, start, end })), [
    { accountId: "ex", calendarId: "c-ex", title: "Dentist", start: "2026-10-27T09:00:00.000Z", end: "2026-10-27T09:30:00.000Z" },
  ]);
  assert.deepEqual(ranges, [DAY, DAY]);
  assert.match(answer.summary, /^Created in Exchange\/Calendar \(me@example\.com\): Dentist, 2026-10-27 10:00–10:30 Europe\/Warsaw\. Verified by reading it back from Apple Calendar\. No overlaps\. Saved in Apple Calendar on this Mac/);
});

test("the same event already there is returned instead of a second copy", async () => {
  const { sync, creates } = fakeSync({ views: [view([meeting({ id: "old-1" })])] });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.equal(answer.status, "already_exists");
  assert.equal(answer.ok, true);
  assert.equal(answer.event?.event_id, "old-1");
  assert.deepEqual(creates, []);
  assert.equal(answer.summary, "Already in Exchange/Calendar (me@example.com): Dentist, 2026-10-27 10:00–10:30 Europe/Warsaw. Nothing new was created.");
});

test("a calendar name two accounts share is refused before anything is read or written", async () => {
  const { sync, ranges, creates } = fakeSync({});
  const answer = await answerAddEvent(sync, { ...INPUT, calendar: "Calendar" }, NOW, ZONE);
  assert.equal(answer.ok, false);
  assert.equal(answer.status, "refused");
  assert.equal(answer.error, '"Calendar" matches several calendars: Exchange/Calendar (me@example.com); iCloud/Calendar. Name one of them exactly.');
  assert.deepEqual(ranges, []);
  assert.deepEqual(creates, []);
});

test("an account that could not be read is not written to blind", async () => {
  const { sync, creates } = fakeSync({ views: [view([], [{ accountId: "ex", message: "the calendar helper failed: boom", code: "helper_failed" }])] });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.equal(answer.error, "could not read Exchange/Calendar (me@example.com) to check for a copy first: the calendar helper failed: boom");
  assert.deepEqual(creates, []);
});

test("macOS refusing the save is reported as nothing added, once a fresh read shows it is not there", async () => {
  const { sync, ranges, refreshes } = fakeSync({ createError: "could not save: The calendar is read only." });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.deepEqual([answer.ok, answer.status, answer.error], [false, "refused", "could not save: The calendar is read only."]);
  assert.deepEqual(ranges, [DAY, DAY]);
  // One before the first read (a write reads the day fresh), one forced between the two reads:
  // create() skips its refresh after an error.
  assert.deepEqual(refreshes, [0, 1]);
});

test("a save that reported an error but landed anyway is answered saved, so ChatGPT does not add it again", async () => {
  const { sync, creates, refreshes } = fakeSync({ views: [view([]), view([meeting({ id: "late-1" })])], createError: "the calendar helper timed out" });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.deepEqual([answer.ok, answer.status, answer.error, answer.provider_sync], [true, "saved_unverified", "", "not_confirmed"]);
  assert.deepEqual(answer.event, { ...WOULD_CREATE, event_id: "late-1" });
  assert.equal(answer.summary, "Saving to Exchange/Calendar (me@example.com) reported an error (the calendar helper timed out), but it is there now: Dentist, 2026-10-27 10:00–10:30 Europe/Warsaw. Check that calendar before adding it again.");
  assert.equal(creates.length, 1);
  assert.deepEqual(refreshes, [0, 1]);
});

test("a create that throws is checked the same way before it is called nothing added", async () => {
  const { sync, ranges, refreshes } = fakeSync({ throws: "create" });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.deepEqual([answer.ok, answer.status, answer.error], [false, "refused", "the calendar helper timed out"]);
  assert.deepEqual(ranges, [DAY, DAY]);
  assert.deepEqual(refreshes, [0, 1]);
});

test("a settings or day read that throws is refused as nothing added, before anything is written", async () => {
  const unread = fakeSync({ throws: "settings" });
  const noSettings = await answerAddEvent(unread.sync, INPUT, NOW, ZONE);
  assert.deepEqual([noSettings.ok, noSettings.status, noSettings.error], [false, "refused", "could not read Paseo's Calendar settings: boom; nothing was added."]);
  const blind = fakeSync({ throws: "range" });
  const noDay = await answerAddEvent(blind.sync, INPUT, NOW, ZONE);
  assert.deepEqual([noDay.ok, noDay.status, noDay.error], [false, "refused", "could not read Exchange/Calendar (me@example.com) to check for a copy first: boom; nothing was added."]);
  assert.deepEqual([...unread.creates, ...blind.creates], []);
});

test("two adds at once write once: the second reads the first one's event and answers already_exists", async () => {
  // A fake whose day is whatever has been created so far, with a slow create: God Mode's retry
  // after its 60-second timeout arrives while the first call is still saving.
  const saved: EventView[] = [];
  const creates: unknown[] = [];
  const sync: AssistantSync = {
    settings: async () => settings(),
    range: async () => view([...saved]),
    create: async (input) => {
      creates.push(input);
      await sleep(20);
      saved.push(meeting({ id: `new-${creates.length}` }));
      return { event: null, error: "" };
    },
    refresh: async () => view([...saved]),
  };
  const answers = await Promise.all([answerAddEvent(sync, INPUT, NOW, ZONE), answerAddEvent(sync, INPUT, NOW, ZONE)]);
  assert.equal(creates.length, 1);
  assert.deepEqual(answers.map((answer) => answer.status), ["saved_locally_verified", "already_exists"]);
  // A preview does not queue behind an add: it answers while the save is still running.
  saved.length = 0;
  creates.length = 0;
  const adding = answerAddEvent(sync, INPUT, NOW, ZONE);
  while (creates.length === 0) await sleep(1);
  const preview = await answerAddEvent(sync, { ...INPUT, dry_run: true }, NOW, ZONE);
  assert.deepEqual([preview.status, saved.length], ["dry_run", 0]); // queued, it would have read the saved copy
  assert.equal((await adding).status, "saved_locally_verified");
});

test("an add gives a stuck refresh PRE_WRITE_WAIT_MS, then checks for a copy in what is held and writes once", async (t) => {
  // The assistant's own wait only. This fake's range() answers at once, while the real one waits
  // for a refresh in flight; the macSync tests below run the real one, and ADD_ANSWER_MS bounds it.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sync, creates, refreshes, release } = fakeSync({ views: [view([]), view([meeting({ id: "new-1" })])], stuckRefresh: true });
  try {
    const answer = pending(answerAddEvent(sync, INPUT, NOW, ZONE));
    await drained();
    t.mock.timers.tick(PRE_WRITE_WAIT_MS - 1);
    await drained();
    assert.deepEqual([refreshes, creates.length, answer()], [[0], 0, undefined], "still giving the fresh read its time");
    t.mock.timers.tick(1);
    await drained();
    assert.equal(answer()?.status, "saved_locally_verified");
    assert.equal(creates.length, 1);
  } finally {
    release();
  }
});

test("after a save that reported an error, the re-read waits for a stuck refresh no longer than the first read did", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sync, creates, refreshes, release } = fakeSync({
    views: [view([]), view([meeting({ id: "late-1" })])],
    createError: "the calendar helper timed out",
    stuckRefresh: true,
  });
  try {
    const answer = pending(answerAddEvent(sync, INPUT, NOW, ZONE));
    await drained();
    t.mock.timers.tick(PRE_WRITE_WAIT_MS);
    await drained();
    assert.deepEqual([refreshes, creates.length, answer()], [[0, 1], 1, undefined], "saved with an error, now waiting on the second refresh");
    t.mock.timers.tick(PRE_WRITE_WAIT_MS - 1);
    await drained();
    assert.equal(answer(), undefined);
    t.mock.timers.tick(1);
    await drained();
    assert.deepEqual([answer()?.status, answer()?.event?.event_id, creates.length], ["saved_unverified", "late-1", 1]);
  } finally {
    release();
  }
});

test("two adds at once while the refresh is stuck still write once: the queue, not the refresh, orders them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved: EventView[] = [];
  const creates: unknown[] = [];
  const stuck = stuckRefreshes();
  const sync: AssistantSync = {
    settings: async () => settings(),
    range: async () => view([...saved]),
    create: async (input) => {
      creates.push(input);
      saved.push(meeting({ id: `new-${creates.length}` }));
      return { event: null, error: "" };
    },
    refresh: stuck.refresh,
  };
  try {
    const first = pending(answerAddEvent(sync, INPUT, NOW, ZONE));
    const second = pending(answerAddEvent(sync, INPUT, NOW, ZONE));
    await drained();
    t.mock.timers.tick(PRE_WRITE_WAIT_MS);
    await drained();
    assert.deepEqual([first()?.status, second(), creates.length], ["saved_locally_verified", undefined, 1], "the second waits its turn");
    t.mock.timers.tick(PRE_WRITE_WAIT_MS);
    await drained();
    assert.deepEqual([second()?.status, creates.length], ["already_exists", 1]);
  } finally {
    stuck.release();
  }
});

/**
 * The real sync, over a store in memory and a fake Mac with two accounts: Exchange, which add_event
 * writes to and which reads back whatever was saved, and iCloud, whose every read, once slow() is
 * called, takes `slowMs` and then fails the way the helper fails at its read budget. This is what
 * the fakes above cannot stand in for: the real range() waits for a refresh in flight, and the
 * real create() queues behind one and then waits for its own. With setTimeout mocked, a slow read
 * costs no real time.
 */
function macSync(slowMs: number, options: { saveThenFail?: boolean } = {}) {
  const row = (id: string, title: string, kind: string, owner: string, calendar: { id: string; name: string }): StoredAccount => ({
    id, sourceId: `s-${id}`, title, owner, kind, calendars: [{ ...calendar, shown: true }],
    lastError: "", errorCode: "", missingSince: "", lastSyncAt: "",
  });
  const rows = [
    row("ex", "Exchange", "exchange", "me@example.com", { id: "c-ex", name: "Calendar" }),
    row("ic", "iCloud", "icloud", "", { id: "c-home", name: "Home" }),
  ];
  let stored: Stored = { ...emptyStored(), accounts: structuredClone(rows) };
  const saved: Event[] = [];
  const creates: CreateInput[] = [];
  let slow = false;
  const sync = createSync({
    read: async () => ({ stored: structuredClone(stored), broken: false }),
    write: async (value) => { stored = structuredClone(value); },
    log: () => {},
    now: () => NOW,
    available: () => true,
    accessStatus: async () => "granted",
    fetchSources: async () => rows.map((entry) => ({ id: entry.sourceId, title: entry.title, kind: entry.kind, calendars: 1 })),
    fetchCalendars: async () => [],
    fetchEvents: async (account) => {
      if (account.id === "ex") return saved.map((event) => ({ ...event }));
      if (!slow) return [];
      await new Promise((resolve) => setTimeout(resolve, slowMs));
      throw new Error(`eventkit helper timed out after ${slowMs}ms`);
    },
    createEvent: async (account, _stored, input) => {
      creates.push({ ...input });
      const event: Event = { id: `new-${creates.length}`, accountId: account.id, calendarId: input.calendarId, calendarName: "Calendar",
        title: input.title, start: input.start, end: input.end, allDay: false, recurring: false, mine: true, attendees: [],
        location: "", description: "", webLink: "", myResponse: "accepted" };
      saved.push(event);
      // A helper that ran out of time after EventKit had already saved.
      if (options.saveThenFail) throw new Error("eventkit helper timed out after 15000ms");
      return event;
    },
  });
  return { sync, creates, slow: () => { slow = true; } };
}
/** Moves mocked time on a quarter of a second at a time, letting every promise run in between, as real time would. */
async function advance(t: TestContext, ms: number): Promise<void> {
  for (let passed = 0; passed < ms; passed += 250) {
    t.mock.timers.tick(Math.min(250, ms - passed));
    await drained();
  }
}

test("against the real sync, an account stuck for the helper's whole read budget cannot hold an add past ADD_ANSWER_MS", async (t) => {
  // 15 s a read: the add waits for one refresh before it reads the day and for another after it
  // writes, which without a bound answered at 30 s, the plugin host's cut-off.
  const mac = macSync(15_000);
  await mac.sync.refresh();
  mac.slow();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  const retry = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS);
  assert.equal(mac.creates.length, 1, "written once, after the day was read");
  assert.deepEqual([first()?.ok, first()?.status, first()?.provider_sync, first()?.event?.event_id], [true, "saved_unverified", "not_confirmed", undefined]);
  assert.equal(
    first()?.summary,
    "Saving to Exchange/Calendar (me@example.com) had not answered after 25 seconds, so it is not confirmed: Dentist, 2026-10-27 " +
      "10:00–10:30 Europe/Warsaw. Check that calendar before adding it again.",
  );
  assert.deepEqual([retry()?.ok, retry()?.status], [false, "refused"], "still behind the first add, so it added nothing");
  assert.match(retry()?.summary ?? "", /^Not added: an earlier add was still running 25 seconds after this request came in/);
  // Both run on behind their answers. Once they are done, asking again finds the event.
  await advance(t, 30_000);
  const third = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS);
  assert.deepEqual([third()?.status, mac.creates.length], ["already_exists", 1]);
});

test("against the real sync, the re-read after a save that reported an error is cut off at ADD_ANSWER_MS as well", async (t) => {
  const mac = macSync(15_000, { saveThenFail: true });
  await mac.sync.refresh();
  mac.slow();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS);
  assert.equal(mac.creates.length, 1);
  assert.deepEqual([answer()?.ok, answer()?.status, answer()?.error], [true, "saved_unverified", ""]);
  assert.equal(
    answer()?.summary,
    "Saving to Exchange/Calendar (me@example.com) reported an error (eventkit helper timed out after 15000ms), and the read that " +
      "would show whether it was saved anyway did not finish within 25 seconds. Check that calendar before adding it again.",
  );
  // Lets the re-read finish, so the add queue is free for the tests after this one.
  await advance(t, 30_000);
});

test("against the real sync, two adds at once while an account is slow write once, and both answer in time", async (t) => {
  const mac = macSync(7_000);
  await mac.sync.refresh();
  mac.slow();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  const second = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS);
  assert.deepEqual([first()?.status, second()?.status, mac.creates.length], ["saved_locally_verified", "already_exists", 1]);
});

test("an add still reading the day at ADD_ANSWER_MS says nothing was added, and never writes afterwards", async (t) => {
  // 40 s a read: two accounts stuck at once.
  const mac = macSync(40_000);
  await mac.sync.refresh();
  mac.slow();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = pending(answerAddEvent(mac.sync, INPUT, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS - 250);
  assert.equal(answer(), undefined);
  await advance(t, 250);
  assert.deepEqual([answer()?.ok, answer()?.status], [false, "refused"]);
  assert.equal(
    answer()?.summary,
    "Not added: the calendars on this Mac did not answer within 25 seconds (an account may be slow or stuck), so the day could " +
      "not be checked for a copy; nothing was added. Try again in a minute.",
  );
  await advance(t, 60_000);
  assert.equal(mac.creates.length, 0, "the day came back at 40 s, after the answer, and the add stopped there");
});

test("a preview behind a stuck refresh answers at ADD_ANSWER_MS too", async (t) => {
  const mac = macSync(40_000);
  await mac.sync.refresh();
  mac.slow();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  void mac.sync.refresh(); // the five-minute tick, in flight when the preview arrives
  const answer = pending(answerAddEvent(mac.sync, { ...INPUT, dry_run: true }, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS);
  assert.deepEqual([answer()?.ok, answer()?.status], [false, "refused"]);
  await advance(t, 60_000);
  assert.equal(mac.creates.length, 0);
});

test("ADD_ANSWER_MS counts from the call, so a daemon still starting cannot hold an add past it either", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ready: (sync: AssistantSync) => void = () => {};
  const starting = new Promise<AssistantSync>((resolve) => { ready = resolve; });
  const answer = pending(answerAddEvent(starting, INPUT, NOW, ZONE));
  await advance(t, ADD_ANSWER_MS - 250);
  assert.equal(answer(), undefined);
  await advance(t, 250);
  assert.deepEqual([answer()?.ok, answer()?.status], [false, "refused"]);
  assert.match(answer()?.summary ?? "", /did not answer within 25 seconds/);
  const { sync, ranges, creates, refreshes } = fakeSync({});
  ready(sync);
  await drained();
  assert.deepEqual([ranges, refreshes, creates], [[], [], []], "it started after its answer had gone out, so it does nothing");
});

test("saved but not found on the way back is still done, so ChatGPT never adds it twice", async () => {
  const { sync } = fakeSync({ views: [view([]), view([])] });
  const answer = await answerAddEvent(sync, INPUT, NOW, ZONE);
  assert.deepEqual([answer.ok, answer.status, answer.error], [true, "saved_unverified", ""]);
  assert.equal(answer.summary, "Saved in Exchange/Calendar (me@example.com), but reading it back did not find it. Check that calendar before adding it again.");
});

test("an add reads the day fresh before looking for a copy, and a preview reads what is held", async () => {
  // The snapshot can be minutes old: a copy added on the phone since must still be found.
  const add = fakeSync({ views: [view([]), view([meeting({ id: "new-1" })])] });
  await answerAddEvent(add.sync, INPUT, NOW, ZONE);
  assert.deepEqual(add.refreshes, [0], "refreshed before the first read");
  const preview = fakeSync({});
  await answerAddEvent(preview.sync, { ...INPUT, dry_run: true }, NOW, ZONE);
  assert.deepEqual(preview.refreshes, []);
});

test("a preview and an add say which other accounts were not read, and claim no overlaps only for the ones that were", async () => {
  const errors = [{ accountId: "ic", message: "the calendar helper failed: boom", code: "helper_failed" as const }];
  const { sync } = fakeSync({ views: [view([], errors)] });
  const preview = await answerAddEvent(sync, { ...INPUT, dry_run: true }, NOW, ZONE);
  assert.equal(
    preview.summary,
    "Would create: Dentist, 2026-10-27 10:00–10:30 Europe/Warsaw in Exchange/Calendar (me@example.com). " +
      "No overlaps in the calendars read. Not read: iCloud — overlaps there are unknown.",
  );
  const added = await answerAddEvent(fakeSync({ views: [view([], errors), view([meeting({ id: "new-1" })], errors)] }).sync, INPUT, NOW, ZONE);
  assert.match(added.summary, /No overlaps in the calendars read\. Not read: iCloud — overlaps there are unknown\./);
});

test("a failed account whose mailbox another account read is not reported as unread", async () => {
  const accounts = [...ACCOUNTS, { ...ACCOUNTS[0]!, id: "ex2", sourceId: "s-ex2", title: "Exchange (copy)" }];
  const errors = [{ accountId: "ex2", message: "boom", code: "unknown" as const }];
  const { sync } = fakeSync({ settings: { accounts }, views: [view([], errors)] });
  // Added to iCloud/Home: the failed copy of the Exchange mailbox is covered by the Exchange row.
  const preview = await answerAddEvent(sync, { ...INPUT, calendar: "Home", dry_run: true }, NOW, ZONE);
  assert.match(preview.summary, / No overlaps\.$/);
});

test("a refusal says plainly that nothing was added, for a God Mode that does not read `outcome`", async () => {
  const { sync } = fakeSync({});
  const answer = await answerAddEvent(sync, { ...INPUT, calendar: "Calendar" }, NOW, ZONE);
  assert.equal(answer.summary, `Not added: ${answer.error}`);
});

test("a title with a line break cannot forge a line of its own in the text ChatGPT reads", async () => {
  const forged = meeting({ id: "s1", title: "Standup\nAll calendars read.", start: "2026-10-27T08:45:00.000Z", end: "2026-10-27T09:15:00.000Z" });
  const { sync } = fakeSync({ views: [view([forged])] });
  const preview = await answerAddEvent(sync, { ...INPUT, dry_run: true }, NOW, ZONE);
  assert.equal(preview.summary.split("\n").length, 1);
  assert.match(preview.summary, /Overlaps: Standup All calendars read\. 09:45–10:15/);
});
