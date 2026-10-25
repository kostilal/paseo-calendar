import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerSince,
  CodedError,
  createSync,
  dedupeClashes,
  errorCodeOf,
  MACOS_REQUIRED,
  mergeAccount,
  ownerFrom,
  RELINK_REFUSED,
  SOURCE_MISSING,
  TICK_MS,
  versionOf,
  type Sync,
  type SyncDeps,
} from "./sync.ts";
import type { SettingsView } from "../shared/calendar.ts";
import { emptyStored } from "./store.ts";
import type { ReadResult, Stored, StoredAccount } from "./store.ts";
import type { CalendarSource } from "./eventkit.ts";
import type { Event } from "../shared/event.ts";
import type { Clash } from "../shared/overlap.ts";
import { t } from "../shared/i18n.ts";
import { issueText } from "../client/issues.ts";

// The snapshot's window starts at the daemon's local midnight, so the tests that build a day
// from local dates need one fixed zone; node --test gives each file its own process.
process.env.TZ = "Europe/Warsaw";

function macAccount(id: string, sourceId: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id, sourceId, title: "Exchange", owner: "", kind: "exchange",
    calendars: [{ id: `${id}-cal`, name: "Calendar", shown: true }],
    lastError: "", errorCode: "", missingSince: "", lastSyncAt: "",
    ...extra,
  };
}

function source(id: string, title = "Exchange", kind = "exchange", calendars = 1): CalendarSource {
  return { id, title, kind, calendars };
}

/** The Mac's seams, answered from the stored list: every stored source is live, and nothing launches. */
function offline(list: () => StoredAccount[]): Pick<SyncDeps, "available" | "fetchSources" | "fetchCalendars" | "accessStatus"> {
  return {
    available: () => true,
    fetchSources: async () => list().map((a) => ({ id: a.sourceId, title: a.title, kind: a.kind || "exchange", calendars: a.calendars.length })),
    fetchCalendars: async () => [],
    accessStatus: async () => "unknown",
  };
}

/** One shown calendar and a source of its own, so a tick reads it. */
function account(id: string, title: string): StoredAccount {
  return macAccount(id, `src-${id}`, { title });
}

function event(id: string, accountId: string): Event {
  return {
    id,
    accountId,
    calendarId: "cal-1",
    calendarName: "Calendar",
    title: "Standup",
    start: "2026-09-09T09:00:00.000Z",
    end: "2026-09-09T09:30:00.000Z",
    allDay: false,
    recurring: false,
    mine: true,
    attendees: [],
    location: "",
    description: "",
    webLink: "",
    myResponse: "accepted",
  };
}

/**
 * A store kept in memory, never touching disk — no test in this file may launch the real
 * helper. fetchEvents defaults to a no-op rather than the real EventKit read, so a test that
 * never overrides it (disconnect, setCalendars) cannot launch it just because one of these
 * mutators triggers a refresh().
 *
 * Takes a partial store so a test can say only what it cares about — almost always just the
 * accounts. Everything else comes from emptyStored(), which is also where a field added later
 * gets its default, so adding one does not mean editing every call here.
 */
function memoryDeps(initial: Partial<Stored>): SyncDeps {
  let stored: Stored = { ...emptyStored(), ...initial };
  return {
    ...offline(() => stored.accounts),
    read: async () => ({ stored, broken: false }),
    write: async (value) => {
      stored = value;
    },
    log: () => {},
    // Kept although offline() is spread above: it says EventKit is available, so without this
    // a test that injects no fetchEvents would run the real `events` subcommand.
    fetchEvents: async () => [],
  };
}

const T0 = Date.parse("2026-10-26T09:00:00.000Z");

/**
 * A store that behaves like the file: read hands back a copy and write keeps a copy. memoryDeps
 * hands back one shared object, which would hide a change that only ever lived in memory; here a
 * field the tick changed but never wrote is simply not there on the next read. It also counts
 * what the tick costs: writes, sources launches, calendars launches, and events launches by account.
 */
function diskDeps(initial: Partial<Stored>, live: CalendarSource[]) {
  let disk: Stored = structuredClone({ ...emptyStored(), ...initial });
  const counts = { writes: 0, sources: 0, calendars: 0, fetches: new Map<string, number>() };
  const logs: string[] = [];
  let clock = T0;
  const deps: SyncDeps = {
    read: async () => ({ stored: structuredClone(disk), broken: false }),
    write: async (value) => { counts.writes += 1; disk = structuredClone(value); },
    log: (line) => logs.push(line),
    now: () => clock,
    available: () => true,
    accessStatus: async () => "unknown",
    fetchSources: async () => { counts.sources += 1; return [...live]; },
    fetchCalendars: async () => { counts.calendars += 1; return []; },
    fetchEvents: async (account) => { counts.fetches.set(account.id, (counts.fetches.get(account.id) ?? 0) + 1); return []; },
  };
  return { deps, counts, logs, disk: () => disk, advance: (ms: number) => { clock += ms; } };
}

/** A shown account, an all-hidden one and one with no stored calendars, all on this Mac. */
function threeAccounts() {
  return diskDeps({ accounts: [
    macAccount("work", "src-work", { title: "Work", owner: "me@example.com", kind: "caldav", calendars: [{ id: "c1", name: "Work", shown: true }] }),
    macAccount("hidden", "src-hidden", { title: "Birthdays", kind: "birthdays", calendars: [{ id: "c2", name: "Birthdays", shown: false }] }),
    macAccount("bare", "src-bare", { title: "Local", kind: "local", calendars: [] }),
  ] }, [source("src-work", "Work", "caldav", 1), source("src-hidden", "Birthdays", "birthdays", 1), source("src-bare", "Local", "local", 0)]);
}

test("one account failing leaves the other's events on the board and only its own error", async () => {
  const ok = account("acc-ok", "ok@example.com");
  const fail = account("acc-fail", "fail@example.com");
  const sync = createSync({
    ...memoryDeps({ accounts: [ok, fail]}),
    fetchEvents: async (acc) => {
      if (acc.id === "acc-fail") throw new Error("boom");
      return [event("evt-1", "acc-ok")];
    },
  });

  await sync.refresh();

  const snapshot = sync.snapshot();
  assert.deepEqual(
    snapshot.events.map((entry) => entry.id),
    ["evt-1"],
  );
  assert.deepEqual(snapshot.errors, [{ accountId: "acc-fail", message: "boom", code: "unknown" }]);

  const settings = await sync.settings();
  assert.equal(settings.accounts.find((entry) => entry.id === "acc-ok")?.lastError, "");
  assert.equal(settings.accounts.find((entry) => entry.id === "acc-fail")?.lastError, "boom");
});

// dedupeClashes is the pure seam behind view()'s clashes field: overlap.ts's Clash carries
// full Event objects, and this is where each side is reduced to the wire shape
// (calendar.ts's clashSide, {accountId, id}) and deduped by that composite pair.

test("dedupeClashes collapses the same composite pair seen more than once, regardless of side order", () => {
  const m = event("m1", "acc-a");
  const n = event("n1", "acc-a");
  const found: Clash[] = [
    { a: m, b: n, overlapMs: 900_000 },
    { a: n, b: m, overlapMs: 900_000 }, // same pair, sides swapped
  ];
  assert.deepEqual(dedupeClashes(found), [
    { a: { accountId: "acc-a", id: "m1" }, b: { accountId: "acc-a", id: "n1" }, overlapMs: 900_000 },
  ]);
});

test("dedupeClashes keeps two genuinely different pairs that happen to share one side", () => {
  const m = event("m1", "acc-a");
  const n = event("n1", "acc-a");
  const p = event("p1", "acc-a");
  const found: Clash[] = [
    { a: m, b: n, overlapMs: 900_000 },
    { a: m, b: p, overlapMs: 600_000 },
  ];
  assert.equal(dedupeClashes(found).length, 2);
});

test("a duplicate copy of the same account's own event does not double its clash with another event", async () => {
  const a = account("acc-a", "a@example.com");
  const m = event("m1", "acc-a");
  const n = { ...event("n1", "acc-a"), start: "2026-09-09T09:15:00.000Z", end: "2026-09-09T09:45:00.000Z" };
  const sync = createSync({
    // The same event twice in one account's own fetch must not read as two collisions with a
    // third, genuinely different event: clashes() finds the pair once per copy, and
    // dedupeClashes keeps one.
    ...memoryDeps({ accounts: [a]}),
    fetchEvents: async () => [m, m, n],
  });

  await sync.refresh();

  const snapshot = sync.snapshot();
  assert.equal(snapshot.clashes.length, 1);
  assert.deepEqual(snapshot.clashes[0], {
    a: { accountId: "acc-a", id: "m1" },
    b: { accountId: "acc-a", id: "n1" },
    overlapMs: 15 * 60_000,
  });
});

test("two concurrent refresh() calls share one tick", async () => {
  let reads = 0;
  const deps: SyncDeps = {
    read: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { stored: { ...emptyStored(), accounts: [] }, broken: false };
    },
    write: async () => {},
    log: () => {},
    available: () => false,
  };
  const sync = createSync(deps);

  const first = sync.refresh();
  const second = sync.refresh();
  assert.equal(first, second);
  await Promise.all([first, second]);

  assert.equal(reads, 1);
});

test("disconnect removes the account from settings", async () => {
  const a = account("acc-a", "a@example.com");
  const b = account("acc-b", "b@example.com");
  const sync = createSync(memoryDeps({ accounts: [a, b]}));

  await sync.disconnect("acc-a");

  const settings = await sync.settings();
  assert.deepEqual(
    settings.accounts.map((entry) => entry.id),
    ["acc-b"],
  );
});

test("disconnect scrubs the removed account's own errors from the snapshot", async () => {
  const ok = account("acc-ok", "ok@example.com");
  const fail = account("acc-fail", "fail@example.com");
  const sync = createSync({
    ...memoryDeps({ accounts: [ok, fail]}),
    fetchEvents: async (acc) => {
      if (acc.id === "acc-fail") throw new Error("boom");
      return [event("evt-1", "acc-ok")];
    },
  });

  await sync.refresh();
  assert.deepEqual(sync.snapshot().errors, [{ accountId: "acc-fail", message: "boom", code: "unknown" }]);

  await sync.disconnect("acc-fail");

  assert.deepEqual(sync.snapshot().errors, []);
});

test("setCalendars updates which calendars are shown", async () => {
  const a = account("acc-a", "a@example.com");
  a.calendars = [{ id: "cal-1", name: "Work", shown: true }];
  const sync = createSync(memoryDeps({ accounts: [a]}));

  const settings = await sync.setCalendars("acc-a", { "cal-1": false });

  assert.equal(settings.accounts[0]?.calendars[0]?.shown, false);
});

// mergeAccount is connect()'s pure half: connecting a source that is already stored must
// not read as a brand new account. Tested directly rather than through connect() itself,
// which also needs a real EventKit grant — the same reason eventkit.ts's native calls are
// untested and only its pure seams are.

test("mergeAccount keeps the row's id, its learned owner and its hidden calendars across a reconnect", () => {
  const existing: StoredAccount = {
    id: "acc-1", sourceId: "src-1", title: "Exchange", owner: "me@example.com", kind: "exchange",
    calendars: [{ id: "cal-1", name: "Work", shown: true }, { id: "cal-2", name: "Personal", shown: false }],
    lastError: "expired", errorCode: "unknown", missingSince: "2026-10-20T08:00:00.000Z", lastSyncAt: "2026-10-24T08:00:00.000Z",
  };
  const merged = mergeAccount(existing, {
    sourceId: "src-1", title: "Exchange", kind: "exchange",
    calendars: [{ id: "cal-1", name: "Work" }, { id: "cal-2", name: "Personal" }, { id: "cal-3", name: "New" }],
  });
  assert.equal(merged.id, "acc-1");
  assert.equal(merged.owner, "me@example.com");
  assert.deepEqual(merged.calendars, [
    { id: "cal-1", name: "Work", shown: true },
    { id: "cal-2", name: "Personal", shown: false },
    { id: "cal-3", name: "New", shown: true },
  ]);
  assert.deepEqual([merged.lastError, merged.errorCode, merged.missingSince], ["", "", ""]);
  assert.equal(merged.lastSyncAt, "2026-10-24T08:00:00.000Z");
});

test("mergeAccount gives a new source a fresh id, its kind, and every calendar shown", () => {
  const merged = mergeAccount(undefined, { sourceId: "src-2", title: "iCloud", kind: "icloud", calendars: [{ id: "cal-1", name: "Home" }] });
  assert.ok(merged.id.length > 0);
  assert.equal(merged.kind, "icloud");
  assert.equal(merged.owner, "");
  assert.deepEqual(merged.calendars, [{ id: "cal-1", name: "Home", shown: true }]);
});

function createInput(accountId: string) {
  return {
    accountId,
    calendarId: "cal-1",
    title: "Standup",
    start: "2026-09-09T09:00:00.000Z",
    end: "2026-09-09T09:30:00.000Z",
    description: "",
  };
}

test("create() reports no such account rather than throwing", async () => {
  const sync = createSync(memoryDeps({ accounts: []}));

  const result = await sync.create(createInput("missing"));

  assert.deepEqual(result, { event: null, error: "no such account" });
});

test("create() refuses a read-only account before the helper is launched", async () => {
  let launched = false;
  const birthdays = macAccount("acc-bd", "src-acc-bd", { title: "Birthdays", kind: "birthdays" });
  const sync = createSync({ ...memoryDeps({ accounts: [birthdays] }), createEvent: async () => { launched = true; return null; } });
  const result = await sync.create(createInput("acc-bd"));
  assert.equal(result.event, null);
  assert.match(result.error, /read-only/);
  assert.equal(launched, false);
});

test("create() reports EventKit's own error rather than throwing", async () => {
  const a = account("acc-a", "a@example.com");
  const sync = createSync({
    ...memoryDeps({ accounts: [a]}),
    createEvent: async () => {
      throw new Error("boom");
    },
  });

  const result = await sync.create(createInput("acc-a"));

  assert.deepEqual(result, { event: null, error: "boom" });
});

test("stop() mid-tick discards that tick's result and never writes", async () => {
  let writes = 0;
  const deps: SyncDeps = {
    read: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { stored: { ...emptyStored(), accounts: [] }, broken: false };
    },
    write: async () => {
      writes += 1;
    },
    log: () => {},
    available: () => false,
  };
  const sync = createSync(deps);

  const starting = sync.start();
  // Give the tick a chance to actually begin — it is now awaiting the delayed read() — before
  // stop() lands on top of it. This is the interleaving tick()'s two `if (stopped) return
  // last;` checks exist for; without waiting here, stop() would land before the tick even
  // started, which proves nothing about the mid-flight guard.
  await new Promise((resolve) => setTimeout(resolve, 5));
  sync.stop();
  await starting;

  assert.equal(writes, 0);
  assert.deepEqual(sync.snapshot(), { events: [], clashes: [], syncedAt: "", errors: [], version: "", unchanged: false });
});

test("a start() that rejects still leaves the handlers usable afterward", async () => {
  function failingDeps(): SyncDeps {
    // The first read, the start's own tick, fails; every later one answers. A failing write no
    // longer rejects a tick (it is logged and the snapshot is published anyway), so a read is
    // what has to fail here.
    let reads = 0;
    return {
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("disk full");
        return { stored: { ...emptyStored(), accounts: [account("acc-a", "a@example.com")] }, broken: false };
      },
      write: async () => {},
      log: () => {},
      available: () => false,
    };
  }

  // Confirms the premise first: with a read() that fails, start() really does reject —
  // otherwise the wrapper below would be proven against a start() that never needed it.
  // stop() afterward, always: start() sets its periodic timer before it ever awaits
  // anything, so a rejected start() still leaves a live TICK_MS interval behind — the same
  // reason every other sync in this suite is torn down rather than left running.
  const probe = createSync(failingDeps());
  try {
    await assert.rejects(probe.start(), /disk full/);
  } finally {
    probe.stop();
  }

  // Mirrors index.server.ts's own start().then(succeed, fail) wrapper: a rejected start()
  // must not leave every handler permanently pending on a promise that never settles.
  const sync = createSync(failingDeps());
  try {
    const started = sync.start().then(
      () => sync,
      () => sync,
    );

    const instance = await started;
    assert.equal(instance, sync);
    // settings() does not depend on the failed tick, so it must still answer.
    const settings = await instance.settings();
    assert.deepEqual(settings.accounts.map((entry) => entry.id), ["acc-a"]);
  } finally {
    sync.stop();
  }
});

// --- Connecting outlives the RPC that asks for it ---
//
// Paseo's plugin host gives a handler thirty seconds (REQUEST_TIMEOUT_MS in its own bundle).
// A connect can legitimately take longer than that: the macOS permission dialog waits on
// somebody finding it behind their windows. A blocking handler therefore reported
// "Plugin RPC timed out" to the screen while the work carried on in the background and often
// succeeded — the account appeared, but only after a reload, and the screen had already said
// it failed. So the RPC starts the work; settings() reports how it ends.

test("connect returns before the work it started has finished", async () => {
  const sync = createSync(memoryDeps({ accounts: []}));

  // No source, so the work fails fast; but it fails in its own turn of the queue, after this
  // answer, and the settings read below still finds it running.
  const started = await sync.connect({ sourceId: "" });
  // The point of the whole change: this resolved while the work is still outstanding.
  assert.deepEqual(started, { started: true, error: "" });
  const during = await sync.settings();
  assert.equal(during.connect?.state, "running");
});

test("a connect that fails leaves its reason where the screen can read it", async () => {
  const sync = createSync(memoryDeps({ accounts: []}));
  // No sourceId, which connect refuses rather than taking every calendar on the Mac.
  await sync.connect({ sourceId: "" });
  // The failure is recorded asynchronously; give the detached promise its turn.
  await new Promise((resolve) => setImmediate(resolve));
  const after = await sync.settings();
  assert.equal(after.connect?.state, "failed");
  assert.match(after.connect?.error ?? "", /chosen|macOS/);
});

test("a second connect while one is running is refused, not queued behind it", async () => {
  // Queueing would be worse than refusing: the second would sit invisible behind the first,
  // and then add an account long after anybody was watching for it.
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sync = createSync({
    ...memoryDeps({ accounts: []}),
    fetchEvents: async () => {
      await blocked;
      return [];
    },
  });
  await sync.connect({ sourceId: "" });
  const second = await sync.connect({ sourceId: "" });
  assert.equal(second.started, false);
  assert.ok(second.error.length > 0);
  release();
});

test("settings reports no connect at all before anything has been attempted", () => {
  const sync = createSync(memoryDeps({ accounts: []}));
  return sync.settings().then((view) => {
    assert.equal(view.connect, null);
    // Nothing has asked macOS anything yet, which is distinct from having been refused.
    assert.equal(view.access, "unknown");
  });
});

// --- Browsing a range without disturbing the snapshot ---
//
// The daemon keeps a rolling fortnight warm, and the composer pill counts down against it
// every minute. A month view three months ahead must not become what the pill is reading —
// so a browse collects and shapes its own list and leaves `events`, `errors` and `syncedAt`
// exactly where they were.

test("a browsed range does not become the snapshot the pill reads", async () => {
  const a = account("acc-1", "me@example.com");
  const near = event("evt-near", "acc-1");
  const far = { ...event("evt-far", "acc-1"), start: "2027-03-02T09:00:00.000Z", end: "2027-03-02T10:00:00.000Z" };
  const sync = createSync({
    ...memoryDeps({ accounts: [a]}),
    fetchEvents: async (_acc, _stored, from) => (from.getUTCFullYear() >= 2027 ? [far] : [near]),
  });

  await sync.refresh();
  assert.deepEqual(sync.snapshot().events.map((e) => e.id), ["evt-near"]);

  const browsed = await sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.deepEqual(browsed.events.map((e) => e.id), ["evt-far"]);
  // The whole point: what the pill reads is untouched.
  assert.deepEqual(sync.snapshot().events.map((e) => e.id), ["evt-near"]);
});

test("the same range twice costs one fetch", async () => {
  // A month view redraws constantly and the same month is revisited on every step back and
  // forth; without the cache each of those would launch the helper again.
  let fetches = 0;
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => {
      fetches++;
      return [];
    },
  });
  const from = new Date("2027-03-01T00:00:00.000Z");
  const to = new Date("2027-04-01T00:00:00.000Z");
  await sync.range(from, to);
  await sync.range(from, to);
  assert.equal(fetches, 1);
  // A different range is a different question.
  await sync.range(from, new Date("2027-05-01T00:00:00.000Z"));
  assert.equal(fetches, 2);
});

test("refresh drops browsed ranges, because it means show me the truth now", async () => {
  let fetches = 0;
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => {
      fetches++;
      return [];
    },
  });
  const from = new Date("2027-03-01T00:00:00.000Z");
  const to = new Date("2027-04-01T00:00:00.000Z");
  await sync.range(from, to);
  const afterBrowse = fetches;
  await sync.refresh();
  await sync.range(from, to);
  assert.ok(fetches > afterBrowse + 1, "the range must be asked again, not served from before the refresh");
});

test("a provider failing during a browse is reported, not recorded against the account", async () => {
  // A browse is not evidence that an account is broken: marking lastError here would put a
  // red banner on the settings screen because somebody looked at next March.
  const a = account("acc-1", "me@example.com");
  const written: Stored[] = [];
  const deps = memoryDeps({ accounts: [a]});
  const sync = createSync({
    ...deps,
    write: async (stored) => {
      written.push(structuredClone(stored));
      await deps.write(stored);
    },
    fetchEvents: async () => {
      throw new Error("boom");
    },
  });
  const browsed = await sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.equal(browsed.errors.length, 1);
  assert.match(browsed.errors[0].message, /boom/);
  assert.deepEqual(written, [], "a browse writes nothing at all");
});

// --- Editing refuses what it cannot do safely ---
//
// Changing one occurrence and changing a series are different operations; EventKit makes the
// caller say which at save time, and the wrong answer rewrites every future occurrence of a
// standup. Nobody can undo that from here, so the refusal is checked on the server as well as
// drawn on the card — the client deciding not to offer a button is not a guarantee.

function recurring(id: string, accountId: string): Event {
  return { ...event(id, accountId), recurring: true };
}

test("a repeating meeting is refused, whatever the client asked for", async () => {
  const a = account("acc-1", "me@example.com");
  let written = false;
  const sync = createSync({
    ...memoryDeps({ accounts: [a]}),
    fetchEvents: async () => [recurring("evt-1", "acc-1")],
    createEvent: async () => {
      written = true;
      return null;
    },
  });
  await sync.refresh();
  const result = await sync.update({
    accountId: "acc-1",
    eventId: "evt-1",
    calendarId: "cal-1",
    title: "Moved",
    start: "2026-09-20T09:00:00.000Z",
    end: "2026-09-20T09:30:00.000Z",
    description: "",
  });
  assert.match(result.error, /repeating/i);
  assert.equal(written, false, "nothing may be written when the answer is no");
});

test("an event the daemon cannot see is refused rather than written to blind", async () => {
  // The window moves. An id from a board somebody left open yesterday must not become a PATCH
  // against whatever that id means today.
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => [],
  });
  await sync.refresh();
  const result = await sync.update({
    accountId: "acc-1",
    eventId: "evt-missing",
    calendarId: "cal-1",
    title: "Moved",
    start: "2026-09-20T09:00:00.000Z",
    end: "2026-09-20T09:30:00.000Z",
    description: "",
  });
  assert.match(result.error, /change it in Calendar/i);
  // Refreshing cannot bring a meeting outside the fortnight into it, so the words must not say it would.
  assert.doesNotMatch(result.error, /refresh|try again/i);
});

test("an all-day event is not edited: its bare dates would be written back as UTC instants", async () => {
  let written = false;
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")] }),
    fetchEvents: async () => [{ ...event("day-1", "acc-1"), allDay: true, start: "2026-10-26", end: "2026-10-27" }],
    updateEvent: async () => {
      written = true;
    },
  });
  await sync.refresh();
  const result = await sync.update({ accountId: "acc-1", eventId: "day-1", calendarId: "cal-1", title: "Renamed",
    start: "2026-10-26T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z", description: "" });
  assert.match(result.error, /all-day/i);
  assert.equal(written, false, "nothing may be written when the answer is no");
});

test("an account that has been disconnected is refused", async () => {
  const sync = createSync({ ...memoryDeps({ accounts: []}), fetchEvents: async () => [] });
  await sync.refresh();
  const result = await sync.update({
    accountId: "gone",
    eventId: "evt-1",
    calendarId: "cal-1",
    title: "Moved",
    start: "2026-09-20T09:00:00.000Z",
    end: "2026-09-20T09:30:00.000Z",
    description: "",
  });
  assert.match(result.error, /no longer connected/i);
});

// --- Deleting refuses the same things, and drops what it removed ---

test("a repeating meeting is not deleted, because that would take the whole series", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => [recurring("evt-1", "acc-1")],
  });
  await sync.refresh();
  const result = await sync.remove({ accountId: "acc-1", eventId: "evt-1", calendarId: "cal-1" });
  assert.match(result.error, /repeating/i);
  assert.equal(sync.snapshot().events.length, 1, "it is still there");
});

test("a deleted meeting leaves the snapshot at once, not at the next tick", async () => {
  // The board is what somebody is looking at when they press Delete; a meeting still listed
  // afterwards reads as a delete that failed.
  // A title of its own, so evt-2 is a second meeting rather than a copy of evt-1.
  let fetched = [event("evt-1", "acc-1"), { ...event("evt-2", "acc-1"), title: "Retro" }];
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => fetched,
    // Injected, so this exercises the bookkeeping rather than a real delete through EventKit.
    removeEvent: async () => {},
  });
  await sync.refresh();
  assert.equal(sync.snapshot().events.length, 2);
  fetched = fetched.filter((entry) => entry.id !== "evt-1");
  await sync.remove({ accountId: "acc-1", eventId: "evt-1", calendarId: "cal-1" });
  assert.deepEqual(sync.snapshot().events.map((entry) => entry.id), ["evt-2"]);
});

test("deleting something the daemon cannot see is refused", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => [],
  });
  await sync.refresh();
  const result = await sync.remove({ accountId: "acc-1", eventId: "ghost", calendarId: "cal-1" });
  assert.match(result.error, /change it in Calendar/i);
});

test("a delete EventKit refuses leaves the meeting where it was", async () => {
  // A failed delete must not look like a successful one: the snapshot is only trimmed after
  // EventKit has actually accepted it.
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "me@example.com")]}),
    fetchEvents: async () => [event("evt-1", "acc-1")],
    removeEvent: async () => {
      throw new Error("the calendar helper failed: event not found");
    },
  });
  await sync.refresh();
  const result = await sync.remove({ accountId: "acc-1", eventId: "evt-1", calendarId: "cal-1" });
  assert.match(result.error, /event not found/);
  assert.deepEqual(sync.snapshot().events.map((entry) => entry.id), ["evt-1"]);
});

// --- One meeting, one row ---

test("two accounts' copies of one meeting are one row naming the other calendar, and no clash", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange"), account("acc-b", "Google")] }),
    fetchEvents: async (acc) =>
      acc.id === "acc-a" ? [event("ek-1", "acc-a")] : [{ ...event("gm-7", "acc-b"), calendarName: "me@gmail.example" }],
  });
  await sync.refresh();
  const view = sync.snapshot();
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0].accountId, "acc-a");
  assert.equal(view.events[0].id, "ek-1");
  assert.deepEqual(view.events[0].alsoIn, [{ accountId: "acc-b", calendarId: "cal-1", calendarName: "me@gmail.example" }]);
  assert.deepEqual(view.clashes, []);
});

test("the kept copy follows the stored account order", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-b", "Google"), account("acc-a", "Exchange")] }),
    fetchEvents: async (acc) => [event(acc.id === "acc-a" ? "ek-1" : "gm-7", acc.id)],
  });
  await sync.refresh();
  assert.deepEqual(sync.snapshot().events.map((e) => e.accountId), ["acc-b"]);
  // Both calendars are called "Calendar"; the copy is still named, by its account.
  assert.deepEqual(sync.snapshot().events[0].alsoIn, [{ accountId: "acc-a", calendarId: "cal-1", calendarName: "Calendar" }]);
});

test("two meetings with one title and time in one account stay two rows, and collide", async () => {
  // Two invitations to an interview at 10:00 are a double booking, not two copies of one meeting.
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange")] }),
    fetchEvents: async () => [event("int-1", "acc-a"), event("int-2", "acc-a")],
  });
  await sync.refresh();
  const view = sync.snapshot();
  assert.deepEqual(view.events.map((e) => [e.id, e.alsoIn]), [["int-1", []], ["int-2", []]]);
  assert.equal(view.clashes.length, 1);
});

test("the kept copy borrows a call link only another copy carries", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange"), account("acc-b", "Google")] }),
    fetchEvents: async (acc) =>
      acc.id === "acc-a"
        ? [event("ek-1", "acc-a")]
        : [{ ...event("gm-7", "acc-b"), description: "Join: https://teams.microsoft.com/l/meetup-join/x" }],
  });
  await sync.refresh();
  const [only] = sync.snapshot().events;
  assert.equal(only.accountId, "acc-a");
  assert.equal(only.joinUrl, "https://teams.microsoft.com/l/meetup-join/x");
  assert.equal(only.joinKind, "teams");
});

test("a call link is borrowed only from the row's own copies, never from an account's other same-key meeting", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange")] }),
    fetchEvents: async () => [
      { ...event("int-1", "acc-a"), description: "Join: https://teams.microsoft.com/l/meetup-join/x" },
      event("int-2", "acc-a"),
    ],
  });
  await sync.refresh();
  assert.deepEqual(sync.snapshot().events.map((e) => [e.id, e.joinKind]), [["int-1", "teams"], ["int-2", "none"]]);
});

test("a meeting Outlook marked cancelled is not on the board", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange")] }),
    fetchEvents: async () => [{ ...event("c-1", "acc-a"), title: "Canceled: Weekly sync" }, { ...event("e-1", "acc-a"), title: "Retro" }],
  });
  await sync.refresh();
  assert.deepEqual(sync.snapshot().events.map((e) => e.id), ["e-1"]);
});

test("deleting a merged meeting drops every copy at once; a copy that really remains comes back on the refetch", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange"), account("acc-b", "Google")] }),
    fetchEvents: async (acc) => [event(acc.id === "acc-a" ? "ek-1" : "gm-7", acc.id)],
    removeEvent: async () => {},
  });
  await sync.refresh();
  assert.deepEqual(await sync.remove({ accountId: "acc-a", eventId: "ek-1", calendarId: "cal-1" }), { error: "" });
  // Read before anything else is awaited: the refetch remove() queued has not started yet.
  assert.equal(sync.snapshot().events.length, 0);
  await sync.refresh();
  assert.equal(sync.snapshot().events.length, 1);
});

test("deleting one of an account's two same-key meetings leaves the other on the board", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-a", "Exchange")] }),
    fetchEvents: async () => [event("int-1", "acc-a"), event("int-2", "acc-a")],
    removeEvent: async () => {},
  });
  await sync.refresh();
  assert.deepEqual(await sync.remove({ accountId: "acc-a", eventId: "int-1", calendarId: "cal-1" }), { error: "" });
  // Read before the queued refetch runs: only the deleted meeting left memory.
  assert.deepEqual(sync.snapshot().events.map((e) => e.id), ["int-2"]);
});

test("the board's opening view is stored, and comes straight back out of settings()", async () => {
  const sync = createSync(memoryDeps({}));

  // Nothing chosen yet: the day, which is the question "what am I doing now".
  assert.equal((await sync.settings()).defaultView, "day");

  const after = await sync.setDefaultView("agenda");
  assert.equal(after.defaultView, "agenda", "the answer is the new settings, not the old ones");
  // And it went through deps.write, so a daemon restart finds it again rather than reverting.
  assert.equal((await sync.settings()).defaultView, "agenda");
});

// --- A store that did not read cleanly is never written back ---
//
// readStored used to turn every failure into an empty store, and the next tick wrote that over
// the real file. A broken read is now for showing only: sync publishes what did validate,
// says so on the board, and refuses every write until a read comes back clean.

function brokenDeps(initial: Partial<Stored>, aside = "/tmp/calendar.json.broken-20261025T120000") {
  const stored: Stored = { ...emptyStored(), ...initial };
  const writes: Stored[] = [];
  const lines: string[] = [];
  const deps: SyncDeps = {
    ...offline(() => stored.accounts),
    // A fresh copy per read, as readStored gives: a mutator that edits what it read must not
    // be able to change the "disk" without writing.
    read: async (): Promise<ReadResult> => ({ stored: structuredClone(stored), broken: true, aside }),
    write: async (value) => {
      writes.push(structuredClone(value));
    },
    log: (line) => lines.push(line),
    fetchEvents: async () => [],
  };
  return { deps, writes, lines };
}

test("while the store reads as broken, nothing is ever written", async () => {
  const a = { ...account("acc-a", "a@example.com"), lastError: "old", calendars: [{ id: "cal-1", name: "Work", shown: true }] };
  const { deps, writes } = brokenDeps({ accounts: [a] });
  const sync = createSync({ ...deps, fetchEvents: async () => [event("evt-1", "acc-a")] });
  await sync.refresh(); // would clear lastError "old"
  await sync.setCalendars("acc-a", { "cal-1": false });
  await sync.setPillLead(15);
  await sync.setDefaultView("agenda");
  await sync.disconnect("acc-a");
  await sync.connect({ sourceId: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, []);
  const settings = await sync.settings();
  assert.deepEqual(settings.accounts.map((entry) => entry.id), ["acc-a"]);
  assert.equal(settings.accounts[0]?.calendars[0]?.shown, true);
  assert.equal(settings.connect?.state, "failed");
  assert.match(settings.connect?.error ?? "", /did not read cleanly/);
  // The refusal names the copy as the board's entry does, so its banner can name it too.
  assert.match(settings.connect?.error ?? "", /calendar\.json\.broken-20261025T120000/);
  assert.equal(settings.connect?.code, "store_broken");
  assert.deepEqual(sync.snapshot().events.map((entry) => entry.id), ["evt-1"], "a refused disconnect leaves the board alone too");
  const issue = sync.snapshot().errors.find((entry) => entry.code === "store_broken");
  assert.ok(issue);
  assert.equal(issue.accountId, "");
  assert.match(issue.message, /calendar\.json\.broken-20261025T120000/);
});

test("a broken store is logged once, not on every tick", async () => {
  const { deps, lines } = brokenDeps({});
  const sync = createSync(deps);
  await sync.refresh();
  await sync.refresh();
  assert.equal(lines.filter((line) => line.includes("broken-20261025T120000")).length, 1);
});

test("a browse while broken says so as well", async () => {
  const { deps } = brokenDeps({});
  const sync = createSync(deps);
  const browsed = await sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.deepEqual(browsed.errors.map((entry) => entry.code), ["store_broken"]);
});

// The board shows its own words for store_broken, not the message. Those words must not claim a
// copy the server never made: a user told a copy is kept may delete the only one there is.

test("with a copy set aside, the board's banner says one is kept", async () => {
  const en = t("en");
  const { deps } = brokenDeps({});
  const sync = createSync(deps);
  await sync.refresh();
  const issue = sync.snapshot().errors.find((entry) => entry.code === "store_broken");
  assert.ok(issue);
  assert.equal(issueText("store_broken", issue.message, "", en), en.issueStoreBroken("calendar.json.broken-20261025T120000"));
  // A name taken in the same second gets a suffix, and is still a copy: that one is named.
  assert.equal(
    issueText("store_broken", `${issue.message}-2`, "", en),
    en.issueStoreBroken("calendar.json.broken-20261025T120000-2"),
  );
});

test("with no copy made, nothing claims one: not the message, not the log, not the banner", async () => {
  const { deps, lines } = brokenDeps({}, "");
  const sync = createSync(deps);
  await sync.refresh();
  const issue = sync.snapshot().errors.find((entry) => entry.code === "store_broken");
  assert.ok(issue);
  assert.doesNotMatch(issue.message, /\.broken-/);
  assert.match(lines.join("\n"), /no copy could be made/);
  for (const locale of ["en", "ru", "uk"] as const) {
    const strings = t(locale);
    assert.equal(issueText("store_broken", issue.message, "", strings), strings.issueStoreBroken(""), locale);
  }
});

test("writing resumes once the store reads cleanly again", async () => {
  let broken = true;
  let stored: Stored = { ...emptyStored() };
  let writes = 0;
  const sync = createSync({
    ...offline(() => stored.accounts),
    read: async (): Promise<ReadResult> =>
      broken ? { stored: structuredClone(stored), broken: true, aside: "" } : { stored: structuredClone(stored), broken: false },
    write: async (value) => {
      writes += 1;
      stored = value;
    },
    log: () => {},
    fetchEvents: async () => [],
  });
  await sync.setPillLead(15);
  assert.equal(writes, 0);
  broken = false;
  await sync.setPillLead(15);
  assert.equal(writes, 1);
  assert.equal(stored.pillLeadMinutes, 15);
});

test("nothing is written when nothing changed", async () => {
  let writes = 0;
  const deps = memoryDeps({ accounts: [account("acc-a", "a@example.com")] });
  const sync = createSync({ ...deps, write: async (value) => { writes += 1; await deps.write(value); } });
  await sync.refresh();
  await sync.refresh();
  assert.equal(writes, 0, "a tick that finds every account as it was writes nothing");
  await sync.setPillLead(15);
  assert.equal(writes, 1);
  await sync.setPillLead(15);
  assert.equal(writes, 1, "the same value again is not a change");
});

test("an account whose error changes is written once, and the same error again is not", async () => {
  let writes = 0;
  const deps = memoryDeps({ accounts: [account("acc-a", "a@example.com")] });
  const sync = createSync({
    ...deps,
    write: async (value) => { writes += 1; await deps.write(value); },
    fetchEvents: async () => { throw new Error("boom"); },
  });
  await sync.refresh();
  await sync.refresh();
  assert.equal(writes, 1);
});

test("a read that migrated the file is written back once, even when nothing else changed", async () => {
  // Without this the v2 file and its .v1.bak would never appear: a migrated store equals itself.
  let stored: Stored = { ...emptyStored(), accounts: [account("acc-a", "Exchange")] };
  let migrated = true;
  let writes = 0;
  const sync = createSync({
    ...offline(() => stored.accounts),
    read: async (): Promise<ReadResult> => ({ stored: structuredClone(stored), broken: false, ...(migrated ? { migrated: true as const } : {}) }),
    write: async (value) => {
      writes += 1;
      stored = value;
      migrated = false;
    },
    log: () => {},
    fetchEvents: async () => [],
  });
  await sync.refresh();
  await sync.refresh();
  assert.equal(writes, 1);
});

// --- The account model: one sources launch per tick, presence, owner, health ---
//
// Which accounts are on this Mac is asked once per tick, and every stored account is checked
// against that one answer: a source macOS no longer lists costs no launch and is marked, an
// account with every calendar hidden is not read at all, and each read teaches the row its kind
// and its owner.

test("one sources launch per tick, however many accounts are read", async () => {
  let sourceCalls = 0;
  const read: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1"), macAccount("b", "s2"), macAccount("c", "s3")] }),
    fetchSources: async () => { sourceCalls += 1; return [source("s1"), source("s2"), source("s3")]; },
    fetchEvents: async (acc) => { read.push(acc.id); return []; },
  });
  await sync.refresh();
  assert.equal(sourceCalls, 1);
  assert.deepEqual(read, ["a", "b", "c"]);
});

test("a source macOS no longer lists costs no launch, is marked once, and is logged once", async () => {
  let clock = Date.parse("2026-10-25T08:00:00.000Z");
  const logs: string[] = [];
  const read: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("ok", "s1"), macAccount("ex", "src-exchange-old")] }),
    now: () => clock,
    log: (line) => logs.push(line),
    fetchSources: async () => [source("s1"), source("src-exchange-new")],
    fetchEvents: async (acc) => { read.push(acc.id); return []; },
  });
  await sync.refresh();
  clock += TICK_MS;
  await sync.refresh();
  assert.deepEqual(read, ["ok", "ok"]);
  const ex = (await sync.settings()).accounts.find((a) => a.id === "ex");
  assert.equal(ex?.errorCode, "source_gone");
  assert.equal(ex?.missingSince, "2026-10-25T08:00:00.000Z", "the first time it went missing, not the latest tick");
  assert.equal(logs.filter((line) => /no longer on this Mac/.test(line)).length, 1);
  assert.deepEqual(sync.snapshot().errors.map((e) => [e.accountId, e.code]), [["ex", "source_gone"]]);
});

test("a source that is listed again clears missingSince and the error", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("ex", "s1", { errorCode: "source_gone", lastError: "gone", missingSince: "2026-10-20T08:00:00.000Z" })] }),
    fetchSources: async () => [source("s1")],
  });
  await sync.refresh();
  const [ex] = (await sync.settings()).accounts;
  assert.deepEqual([ex.missingSince, ex.errorCode, ex.lastError], ["", "", ""]);
});

test("an account with every calendar hidden is not read, and alone it launches nothing", async () => {
  let sourceCalls = 0;
  const read: string[] = [];
  const hidden = macAccount("hidden", "s1", { calendars: [{ id: "c1", name: "Calendar", shown: false }] });
  const seams = {
    fetchSources: async () => { sourceCalls += 1; return [source("s1"), source("s2")]; },
    fetchEvents: async (acc: StoredAccount) => { read.push(acc.id); return []; },
  };
  await createSync({ ...memoryDeps({ accounts: [hidden] }), ...seams }).refresh();
  assert.equal(sourceCalls, 0);
  assert.deepEqual(read, []);
  await createSync({ ...memoryDeps({ accounts: [hidden, macAccount("shown", "s2")] }), ...seams }).refresh();
  assert.equal(sourceCalls, 1);
  assert.deepEqual(read, ["shown"]);
});

test("a tick learns a migrated account's kind, and its owner from the self attendee, then keeps the owner", async () => {
  let attendees: Event["attendees"] = [
    { name: "Colleague", email: "colleague@example.com", response: "accepted", self: false, organiser: true },
    { name: "Me", email: "me@example.com", response: "accepted", self: true, organiser: false },
  ];
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("g", "s1", { title: "Google", kind: "" })] }),
    fetchSources: async () => [source("s1", "Google", "caldav", 3)],
    fetchEvents: async () => [{ ...event("e1", "g"), attendees }],
  });
  await sync.refresh();
  let [g] = (await sync.settings()).accounts;
  assert.equal(g.kind, "caldav");
  assert.equal(g.owner, "me@example.com");
  attendees = [{ name: "Me", email: "someone-else@example.com", response: "accepted", self: true, organiser: false }];
  await sync.refresh();
  [g] = (await sync.settings()).accounts;
  assert.equal(g.owner, "me@example.com", "once known, the owner is kept");
});

test("ownerFrom takes the first self attendee with a real address, and nothing else", () => {
  const me = { name: "Me", response: "accepted" as const, self: true, organiser: false };
  assert.equal(ownerFrom([{ ...event("e1", "a"), attendees: [{ ...me, email: "/aMTI3NDU2/principal/" }] }]), "");
  assert.equal(ownerFrom([{ ...event("e1", "a"), attendees: [{ ...me, self: false, email: "x@example.com" }] }]), "");
  assert.equal(ownerFrom([{ ...event("e1", "a"), attendees: [{ ...me, email: " me@example.com " }] }]), "me@example.com");
});

test("each account carries its own last read, and a failing one keeps its last good one", async () => {
  let clock = Date.parse("2026-10-25T08:00:00.000Z");
  let failing = false;
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1"), macAccount("b", "s2")] }),
    now: () => clock,
    fetchSources: async () => [source("s1"), source("s2")],
    fetchEvents: async (acc) => { if (failing && acc.id === "b") throw new Error("boom"); return []; },
  });
  await sync.refresh();
  clock = Date.parse("2026-10-25T08:05:00.000Z");
  failing = true;
  await sync.refresh();
  const byId = new Map((await sync.settings()).accounts.map((a) => [a.id, a]));
  assert.equal(byId.get("a")?.lastSyncAt, "2026-10-25T08:05:00.000Z");
  assert.equal(byId.get("b")?.lastSyncAt, "2026-10-25T08:00:00.000Z");
  assert.equal(byId.get("b")?.errorCode, "unknown");
  assert.equal(byId.get("b")?.lastError, "boom");
});

test("a sources launch that fails marks every account it would have read and launches nothing more", async () => {
  const read: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1"), macAccount("b", "s2")] }),
    fetchSources: async () => { throw new Error("calendar access not granted"); },
    fetchEvents: async (acc) => { read.push(acc.id); return []; },
  });
  await sync.refresh();
  assert.deepEqual(read, []);
  assert.deepEqual((await sync.settings()).accounts.map((a) => [a.errorCode, a.missingSince]), [["access_needed", ""], ["access_needed", ""]]);
  assert.deepEqual(sync.snapshot().errors.map((e) => e.code), ["access_needed", "access_needed"]);
});

test("off a Mac nothing is launched and every account says why", async () => {
  let launches = 0;
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1")] }),
    available: () => false,
    fetchSources: async () => { launches += 1; return []; },
    fetchEvents: async () => { launches += 1; return []; },
  });
  await sync.refresh();
  assert.equal(launches, 0);
  assert.deepEqual(sync.snapshot().errors, [{ accountId: "a", message: MACOS_REQUIRED, code: "macos_required" }]);
});

// Far-future ranges on purpose: a range inside the snapshot window is answered from memory.
test("a browse reuses the tick's list of sources for a minute, and reports a gone source without logging it", async () => {
  let clock = Date.parse("2026-10-25T08:00:00.000Z");
  let sourceCalls = 0;
  const logs: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1"), macAccount("ex", "src-exchange-old")] }),
    now: () => clock,
    log: (line) => logs.push(line),
    fetchSources: async () => { sourceCalls += 1; return [source("s1")]; },
  });
  await sync.refresh();
  const logged = logs.length;
  clock += 30_000;
  const browsed = await sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.equal(sourceCalls, 1);
  assert.deepEqual(browsed.errors.map((e) => [e.accountId, e.code]), [["ex", "source_gone"]]);
  assert.equal(logs.length, logged, "a browse does not log the gone source again");
  clock += 31_000;
  await sync.range(new Date("2027-04-01T00:00:00.000Z"), new Date("2027-05-01T00:00:00.000Z"));
  assert.equal(sourceCalls, 2);
});

test("settings lists the Mac's sources that no row reads, once access is granted", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1")] }),
    accessStatus: async () => "granted",
    fetchSources: async () => [source("s1"), source("s2", "iCloud", "caldav", 4)],
  });
  try {
    await sync.start();
    assert.deepEqual((await sync.settings()).found, [{ id: "s2", title: "iCloud", kind: "caldav", calendars: 4 }]);
  } finally {
    sync.stop();
  }
});

test("nothing is found, and nothing launched for it, before access is granted", async () => {
  let sourceCalls = 0;
  const sync = createSync({
    ...memoryDeps({ accounts: [] }),
    accessStatus: async () => "unknown",
    fetchSources: async () => { sourceCalls += 1; return [source("s2")]; },
  });
  try {
    await sync.start();
    assert.deepEqual((await sync.settings()).found, []);
    assert.equal(sourceCalls, 0);
  } finally {
    sync.stop();
  }
});

test("an account row carries the whole account model, and no relink offer while its source is there", async () => {
  const sync = createSync(memoryDeps({ accounts: [macAccount("a", "s1", { owner: "me@example.com", lastSyncAt: "2026-10-25T08:00:00.000Z" })] }));
  assert.deepEqual((await sync.settings()).accounts, [{
    id: "a", sourceId: "s1", title: "Exchange", owner: "me@example.com", kind: "exchange",
    calendars: [{ id: "a-cal", name: "Calendar", shown: true }],
    lastSyncAt: "2026-10-25T08:00:00.000Z", lastError: "", errorCode: "", missingSince: "", relinkTo: null,
  }]);
});

test("errorCodeOf reads our own failures by code and the helper's by its fixed words", () => {
  assert.equal(errorCodeOf(new CodedError("source_gone", "x")), "source_gone");
  assert.equal(errorCodeOf(new Error("calendar access not granted")), "access_needed");
  assert.equal(errorCodeOf(new Error("calendar access has not been granted yet")), "access_needed");
  assert.equal(errorCodeOf(new Error("could not build the EventKit helper (is 'swiftc' installed?): x")), "helper_failed");
  assert.equal(errorCodeOf(new Error("the calendar helper failed: dyld: missing")), "helper_failed");
  assert.equal(errorCodeOf(new Error("eventkit helper timed out after 15000ms")), "helper_failed");
  assert.equal(errorCodeOf(new Error("boom")), "unknown");
  assert.equal(errorCodeOf("not even an Error"), "unknown");
});

// A fresh row per test: memoryDeps hands its accounts out as they are, and a tick or a relink changes them in place.
const exchangeRow = (): StoredAccount => macAccount("ex", "src-exchange-old", {
  title: "Exchange", kind: "", owner: "me@example.com",
  calendars: [{ id: "old-cal", name: "Calendar", shown: true }, { id: "old-bday", name: "Birthdays", shown: false }],
  errorCode: "source_gone", lastError: SOURCE_MISSING, missingSince: "2026-10-25T08:00:00.000Z",
});
const moved = source("src-exchange-new", "Exchange", "exchange", 2);
const movedCalendars = [{ id: "new-cal", name: "Calendar" }, { id: "new-bday", name: "Birthdays" }];

async function settledConnect(sync: Sync): Promise<SettingsView> {
  for (let i = 0; i < 50; i += 1) {
    const view = await sync.settings();
    if (view.connect?.state !== "running") return view;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("connect never settled");
}

test("settings offers the moved Exchange row its new source and leaves that source out of found", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [exchangeRow(), macAccount("g", "s-google", { title: "Google", kind: "caldav" })] }),
    accessStatus: async () => "granted",
    fetchSources: async () => [source("s-google", "Google", "caldav", 3), moved, source("s-icloud", "iCloud", "caldav", 2)],
    fetchCalendars: async (id) => (id === "src-exchange-new" ? movedCalendars : []),
  });
  try {
    await sync.start();
    const view = await sync.settings();
    assert.deepEqual(view.accounts.find((a) => a.id === "ex")?.relinkTo, { sourceId: "src-exchange-new", title: "Exchange", calendars: 2 });
    assert.equal(view.accounts.find((a) => a.id === "g")?.relinkTo, null);
    assert.deepEqual(view.found.map((s) => s.id), ["s-icloud"]);
  } finally {
    sync.stop();
  }
});

test("relink keeps the row id, swaps the source, carries hidden calendars by name and reads the new source", async () => {
  const read: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [exchangeRow()] }),
    fetchSources: async () => [moved],
    fetchCalendars: async () => movedCalendars,
    fetchEvents: async (acc) => { read.push(acc.sourceId); return [{ ...event("e1", acc.id), calendarId: "new-cal" }]; },
  });
  const result = await sync.relink("ex", "src-exchange-new");
  assert.equal(result.error, "");
  const row = result.settings?.accounts[0];
  assert.equal(row?.id, "ex");
  assert.equal(row?.sourceId, "src-exchange-new");
  assert.deepEqual(row?.calendars, [{ id: "new-cal", name: "Calendar", shown: true }, { id: "new-bday", name: "Birthdays", shown: false }]);
  assert.deepEqual([row?.missingSince, row?.errorCode, row?.lastError, row?.kind], ["", "", "", "exchange"]);
  assert.deepEqual(read, ["src-exchange-new"], "the refresh after a relink reads the new source before relink answers");
  assert.deepEqual(sync.snapshot().events.map((e) => e.id), ["e1"]);
});

test("relink refuses a source that is not this account moved, and writes nothing", async () => {
  let writes = 0;
  const base = memoryDeps({ accounts: [exchangeRow()] });
  const sync = createSync({
    ...base,
    write: async (stored) => { writes += 1; await base.write(stored); },
    fetchSources: async () => [moved, source("s-work", "Work", "exchange", 2)],
    fetchCalendars: async () => movedCalendars,
  });
  assert.deepEqual(await sync.relink("ex", "s-work"), { error: RELINK_REFUSED, settings: null });
  assert.equal(writes, 0);
  assert.equal((await sync.settings()).accounts[0].sourceId, "src-exchange-old");
});

test("relink refuses a source whose calendars no longer match, and writes nothing", async () => {
  // The offer was right when Settings showed it; the relink re-reads sources and calendars fresh.
  let writes = 0;
  let live = [moved];
  let calendars = movedCalendars;
  const base = memoryDeps({ accounts: [exchangeRow()] });
  const sync = createSync({
    ...base,
    write: async (stored) => { writes += 1; await base.write(stored); },
    accessStatus: async () => "granted",
    fetchSources: async () => live,
    fetchCalendars: async () => calendars,
  });
  try {
    await sync.start();
    assert.equal((await sync.settings()).accounts[0].relinkTo?.sourceId, "src-exchange-new", "offered first");
    writes = 0;
    calendars = [{ id: "new-cal", name: "Calendar" }]; // Birthdays went away after the offer
    assert.deepEqual(await sync.relink("ex", "src-exchange-new"), { error: RELINK_REFUSED, settings: null });
    calendars = movedCalendars;
    live = [{ ...moved, title: "Exchange (Work)" }]; // the source was renamed after the offer
    assert.deepEqual(await sync.relink("ex", "src-exchange-new"), { error: RELINK_REFUSED, settings: null });
    assert.equal(writes, 0, "a refused relink writes nothing");
    assert.equal((await sync.settings()).accounts[0].sourceId, "src-exchange-old");
  } finally {
    sync.stop();
  }
});

test("a source two missing rows could both have moved to is offered to neither, listed by neither, and relinked by neither", async () => {
  // Two mailboxes macOS both calls "Exchange", both gone, one re-added: which row it belongs to
  // cannot be told, and a wrong guess would show one mailbox's meetings under the other's row.
  let writes = 0;
  const other: StoredAccount = { ...exchangeRow(), id: "ex2", sourceId: "src-exchange-old-2", kind: "exchange", owner: "other@example.com" };
  const base = memoryDeps({ accounts: [{ ...exchangeRow(), kind: "exchange" }, other] });
  const sync = createSync({
    ...base,
    write: async (stored) => { writes += 1; await base.write(stored); },
    accessStatus: async () => "granted",
    fetchSources: async () => [moved],
    fetchCalendars: async () => movedCalendars,
  });
  try {
    await sync.start();
    const view = await sync.settings();
    assert.deepEqual(view.accounts.map((a) => a.relinkTo), [null, null]);
    assert.deepEqual(view.found, [], "nor is it an Add button");
    writes = 0;
    assert.deepEqual(await sync.relink("ex", "src-exchange-new"), { error: RELINK_REFUSED, settings: null });
    assert.deepEqual(await sync.relink("ex2", "src-exchange-new"), { error: RELINK_REFUSED, settings: null });
    assert.equal(writes, 0, "a refused relink writes nothing");
    assert.deepEqual((await sync.settings()).accounts.map((a) => a.sourceId), ["src-exchange-old", "src-exchange-old-2"]);
  } finally {
    sync.stop();
  }
});

test("relink refuses a row that has been disconnected", async () => {
  const sync = createSync({ ...memoryDeps({ accounts: [] }), fetchSources: async () => [moved] });
  assert.match((await sync.relink("ex", "src-exchange-new")).error, /no longer connected/);
});

test("relink writes nothing while the store is broken", async () => {
  let writes = 0;
  const stored = { ...emptyStored(), accounts: [exchangeRow()] };
  const sync = createSync({
    read: async () => ({ stored, broken: true, aside: "/tmp/calendar.json.broken-20261025T101500" }),
    write: async () => { writes += 1; },
    log: () => {},
    available: () => true,
    fetchSources: async () => [moved],
    fetchCalendars: async () => movedCalendars,
    fetchEvents: async () => [],
  });
  const result = await sync.relink("ex", "src-exchange-new");
  assert.match(result.error, /did not read cleanly.*calendar\.json\.broken-20261025T101500/);
  assert.equal(result.settings, null);
  assert.equal(writes, 0);
});

test("a connect records the source's kind and title and starts healthy", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [] }),
    fetchSources: async () => [source("s-icloud", "iCloud", "caldav", 1)],
    fetchCalendars: async () => [{ id: "home", name: "Home" }],
  });
  await sync.connect({ sourceId: "s-icloud" });
  const view = await settledConnect(sync);
  assert.equal(view.connect?.state, "done");
  const [row] = view.accounts;
  assert.deepEqual([row.title, row.kind, row.owner, row.errorCode, row.missingSince], ["iCloud", "caldav", "", "", ""]);
  assert.deepEqual(row.calendars, [{ id: "home", name: "Home", shown: true }]);
});

test("connecting a source that is already a row keeps its id and hidden calendars", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [macAccount("a", "s1", { calendars: [{ id: "c1", name: "Calendar", shown: false }] })] }),
    fetchSources: async () => [source("s1")],
    fetchCalendars: async () => [{ id: "c1", name: "Calendar" }, { id: "c2", name: "Holidays" }],
  });
  await sync.connect({ sourceId: "s1" });
  const view = await settledConnect(sync);
  assert.equal(view.accounts.length, 1);
  assert.equal(view.accounts[0].id, "a");
  assert.deepEqual(view.accounts[0].calendars.map((c) => [c.id, c.shown]), [["c1", false], ["c2", true]]);
});

test("a connect to a source macOS no longer lists fails in words", async () => {
  const sync = createSync({ ...memoryDeps({ accounts: [] }), fetchSources: async () => [] });
  await sync.connect({ sourceId: "s-gone" });
  const view = await settledConnect(sync);
  assert.equal(view.connect?.state, "failed");
  assert.match(view.connect?.error ?? "", /no longer on this Mac/);
  assert.equal(view.connect?.code, "source_gone");
});

test("settings names the copy a broken store was set aside as, and is empty otherwise", async () => {
  const aside = "/tmp/calendar.json.broken-20261025T101500";
  const broken = createSync({ read: async () => ({ stored: emptyStored(), broken: true, aside }), write: async () => {}, log: () => {}, available: () => false });
  assert.equal((await broken.settings()).storeAside, aside);
  assert.equal((await createSync(memoryDeps({})).settings()).storeAside, "");
});

// --- A range inside the snapshot's window is a slice of it ---

function clocked(start: number) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

test("a range inside the snapshot's window is answered from memory, without a provider pass", async () => {
  let fetches = 0;
  const clock = clocked(Date.parse("2026-10-21T08:00:00.000Z"));
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    now: clock.now,
    fetchEvents: async () => {
      fetches += 1;
      return [
        { ...event("early", "acc-1"), title: "Early", start: "2026-10-20T22:30:00.000Z", end: "2026-10-20T23:00:00.000Z" },
        { ...event("standup", "acc-1"), start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z" },
        { ...event("late", "acc-1"), title: "Late", start: "2026-10-21T22:30:00.000Z", end: "2026-10-21T23:00:00.000Z" },
      ];
    },
  });
  await sync.refresh();
  const day = await sync.range(new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.deepEqual(day.events.map((e) => e.id), ["early", "standup"]);
  assert.equal(day.syncedAt, sync.snapshot().syncedAt);
  assert.equal(fetches, 1);
});

test("a range read issued right after update() sees the post-update data", async () => {
  let fetches = 0;
  let title = "Standup";
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    now: clocked(Date.parse("2026-10-21T08:00:00.000Z")).now,
    fetchEvents: async () => {
      fetches += 1;
      return [{ ...event("evt-1", "acc-1"), title, start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z" }];
    },
    updateEvent: async (_account, _stored, input) => { title = input.title; },
  });
  await sync.refresh();
  const result = await sync.update({ accountId: "acc-1", eventId: "evt-1", calendarId: "cal-1", title: "Moved",
    start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z", description: "" });
  assert.deepEqual(result, { error: "" });
  const day = await sync.range(new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.equal(day.events[0]?.title, "Moved");
  assert.equal(fetches, 2, "the update's own refresh, and no provider pass for the range");
});

// The composer pill re-polls calendar.events { refresh: false } (the snapshot) as soon as an
// edit or a create answers, so the answer has to wait for the refresh that reads the change.

test("update() answers with the change already in the snapshot", async () => {
  let title = "Standup";
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    now: clocked(Date.parse("2026-10-21T08:00:00.000Z")).now,
    fetchEvents: async () => [{ ...event("evt-1", "acc-1"), title, start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z" }],
    updateEvent: async (_account, _stored, input) => { title = input.title; },
  });
  await sync.refresh();
  const result = await sync.update({ accountId: "acc-1", eventId: "evt-1", calendarId: "cal-1", title: "Moved",
    start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z", description: "" });
  assert.deepEqual(result, { error: "" });
  assert.equal(sync.snapshot().events[0]?.title, "Moved");
});

test("create() answers with the new meeting already in the snapshot", async () => {
  const onCalendar: Event[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    now: clocked(Date.parse("2026-10-21T08:00:00.000Z")).now,
    fetchEvents: async () => [...onCalendar],
    createEvent: async (_account, _stored, input) => {
      const created = { ...event("new-1", "acc-1"), title: input.title, start: input.start, end: input.end };
      onCalendar.push(created);
      return created;
    },
  });
  await sync.refresh();
  const result = await sync.create({ ...createInput("acc-1"), title: "Planning",
    start: "2026-10-21T09:00:00.000Z", end: "2026-10-21T09:30:00.000Z" });
  assert.equal(result.error, "");
  assert.deepEqual(sync.snapshot().events.map((entry) => entry.title), ["Planning"]);
});

test("a refresh that fails after a successful update still reports the update as done", async () => {
  const deps = memoryDeps({ accounts: [account("acc-1", "Exchange")] });
  const logged: string[] = [];
  let diskGone = false;
  const sync = createSync({
    ...deps,
    read: async () => {
      if (diskGone) throw new Error("disk gone");
      return deps.read();
    },
    log: (line) => { logged.push(line); },
    now: clocked(Date.parse("2026-10-21T08:00:00.000Z")).now,
    fetchEvents: async () => [{ ...event("evt-1", "acc-1"), start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z" }],
    updateEvent: async () => { diskGone = true; },
  });
  await sync.refresh();
  const result = await sync.update({ accountId: "acc-1", eventId: "evt-1", calendarId: "cal-1", title: "Moved",
    start: "2026-10-21T07:00:00.000Z", end: "2026-10-21T07:30:00.000Z", description: "" });
  assert.deepEqual(result, { error: "" }, "the meeting moved; only the read-back failed");
  assert.ok(logged.some((line) => line.includes("refresh after update failed")));
});

test("a refresh that fails after a successful create still reports the create as done", async () => {
  const deps = memoryDeps({ accounts: [account("acc-1", "Exchange")] });
  const logged: string[] = [];
  let diskGone = false;
  const created = { ...event("new-1", "acc-1"), start: "2026-10-21T09:00:00.000Z", end: "2026-10-21T09:30:00.000Z" };
  const sync = createSync({
    ...deps,
    read: async () => {
      if (diskGone) throw new Error("disk gone");
      return deps.read();
    },
    log: (line) => { logged.push(line); },
    now: clocked(Date.parse("2026-10-21T08:00:00.000Z")).now,
    createEvent: async () => { diskGone = true; return created; },
  });
  const result = await sync.create(createInput("acc-1"));
  assert.deepEqual(result, { event: created, error: "" });
  assert.ok(logged.some((line) => line.includes("refresh after create failed")));
});

test("a snapshot older than two ticks and a minute is not served; the range goes to the providers", async () => {
  let fetches = 0;
  const clock = clocked(Date.parse("2026-10-21T08:00:00.000Z"));
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    now: clock.now,
    fetchEvents: async () => { fetches += 1; return []; },
  });
  await sync.refresh();
  clock.advance(12 * 60_000);
  await sync.range(new Date(2026, 9, 21), new Date(2026, 9, 22));
  assert.equal(fetches, 2);
});

test("a day before the window still goes to the providers", async () => {
  let fetches = 0;
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    now: clocked(Date.parse("2026-10-21T08:00:00.000Z")).now,
    fetchEvents: async () => { fetches += 1; return []; },
  });
  await sync.refresh();
  await sync.range(new Date(2026, 9, 20), new Date(2026, 9, 21));
  assert.equal(fetches, 2);
});

test("versionOf follows events, clashes and errors, and nothing else", () => {
  const empty = { events: [], clashes: [], errors: [] };
  const version = versionOf(empty);
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(versionOf({ events: [], clashes: [], errors: [] }), version);
  assert.notEqual(versionOf({ ...empty, errors: [{ accountId: "a", message: "boom", code: "unknown" }] }), version);
});

test("the same events in a different order give the same version", async () => {
  // EventKit makes no promise about order; without this the ~150 KB answer is resent every minute.
  const standup = { ...event("evt-1", "acc-1"), title: "Standup" };
  const retro = { ...event("evt-2", "acc-1"), title: "Retro" }; // same start, so the two also clash
  const snapshotOf = async (order: Event[]) => {
    const sync = createSync({ ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }), fetchEvents: async () => order });
    await sync.refresh();
    return sync.snapshot();
  };
  const first = await snapshotOf([standup, retro]);
  const second = await snapshotOf([retro, standup]);
  assert.deepEqual(first.events.map((e) => e.id), ["evt-1", "evt-2"]);
  assert.deepEqual(second.events.map((e) => e.id), ["evt-2", "evt-1"], "the two answers really are in different orders");
  assert.equal(first.clashes.length, 1);
  assert.equal(second.version, first.version);
  assert.notEqual(versionOf({ ...first, events: first.events.slice(1) }), first.version, "a missing event is still a change");
});

test("the same attendees in a different order give the same version, and a different attendee does not", async () => {
  // Found live: EventKit hands one meeting's attendees back in a different order on every read,
  // so ordering the events alone left the version moving on every refresh.
  const ann = { name: "Ann", email: "ann@corp.example", response: "accepted" as const, self: false, organiser: true };
  const bob = { name: "Bob", email: "bob@corp.example", response: "tentative" as const, self: true, organiser: false };
  const snapshotOf = async (attendees: Event["attendees"]) => {
    const sync = createSync({ ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
      fetchEvents: async () => [{ ...event("evt-1", "acc-1"), attendees }] });
    await sync.refresh();
    return sync.snapshot();
  };
  const first = await snapshotOf([ann, bob]);
  const second = await snapshotOf([bob, ann]);
  assert.deepEqual(first.events[0]?.attendees.map((a) => a.name), ["Ann", "Bob"]);
  assert.deepEqual(second.events[0]?.attendees.map((a) => a.name), ["Bob", "Ann"], "the two answers really are in different orders");
  assert.equal(second.version, first.version);
  assert.notEqual((await snapshotOf([ann, { ...bob, response: "declined" as const }])).version, first.version, "a changed answer is still a change");
  assert.notEqual((await snapshotOf([ann])).version, first.version, "a missing attendee is still a change");
});

test("the copies a merged meeting was also found in are hashed in no particular order", async () => {
  const sync = createSync({ ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }), fetchEvents: async () => [event("evt-1", "acc-1")] });
  await sync.refresh();
  const [row] = sync.snapshot().events;
  assert.ok(row);
  const google = { accountId: "acc-2", calendarId: "cal-g", calendarName: "Google" };
  const icloud = { accountId: "acc-3", calendarId: "cal-i", calendarName: "iCloud" };
  const withCopies = (alsoIn: typeof row.alsoIn) => versionOf({ events: [{ ...row, alsoIn }], clashes: [], errors: [] });
  assert.equal(withCopies([google, icloud]), withCopies([icloud, google]));
  assert.notEqual(withCopies([google, icloud]), withCopies([google]));
});

test("two ticks over the same meetings keep one version while syncedAt moves", async () => {
  let clock = Date.parse("2026-10-26T09:00:00.000Z");
  const sync = createSync({ ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }), now: () => clock,
    fetchEvents: async () => [event("evt-1", "acc-1")] });
  await sync.refresh();
  const first = sync.snapshot();
  clock += TICK_MS;
  await sync.refresh();
  const second = sync.snapshot();
  assert.notEqual(second.syncedAt, first.syncedAt);
  assert.equal(second.version, first.version);
});

test("a meeting that moved is a new version", async () => {
  let start = "2026-09-09T09:00:00.000Z";
  const sync = createSync({ ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    fetchEvents: async () => [{ ...event("evt-1", "acc-1"), start }] });
  await sync.refresh();
  const before = sync.snapshot().version;
  start = "2026-09-09T09:15:00.000Z";
  await sync.refresh();
  assert.notEqual(sync.snapshot().version, before);
});

test("answerSince says unchanged only to the version it would have sent", async () => {
  const sync = createSync({ ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }), fetchEvents: async () => [event("evt-1", "acc-1")] });
  const never = sync.snapshot();
  assert.equal(never.version, "", "nothing computed yet");
  assert.equal(answerSince(never, ""), never);
  await sync.refresh();
  const view = sync.snapshot();
  assert.deepEqual(answerSince(view, view.version), {
    events: [], clashes: [], errors: [], syncedAt: view.syncedAt, version: view.version, unchanged: true,
  });
  assert.equal(answerSince(view, "0000000000000000"), view);
  assert.equal(answerSince(view, undefined), view);
});

// --- A quiet tick costs nothing: no write, no launch for what is hidden or gone ---

test("three ticks over an unchanged Mac write nothing and launch nothing for a hidden account", async () => {
  const store = threeAccounts();
  const sync = createSync(store.deps);
  for (let i = 0; i < 3; i += 1) { await sync.refresh(); store.advance(TICK_MS); }
  await sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.equal(store.counts.writes, 0, "nothing changed, so the file is left alone");
  assert.equal(store.counts.sources >= 3, true);
  assert.equal(store.counts.fetches.get("hidden") ?? 0, 0, "every calendar hidden: no events launch, ticks or browse");
  assert.equal(store.counts.fetches.get("work"), 4);
  assert.equal(store.counts.fetches.get("bare") ?? 0, 0, "no stored calendars: nothing could be shown, so nothing is launched");
  assert.equal(store.counts.calendars, 0, "a tick never asks for a source's calendars");
});

test("settings says when each account was last read, even when the tick wrote nothing", async () => {
  const store = threeAccounts();
  const sync = createSync(store.deps);
  await sync.refresh();
  store.advance(TICK_MS);
  await sync.refresh();
  const accounts = (await sync.settings()).accounts;
  assert.equal(accounts.find((a) => a.id === "work")?.lastSyncAt, new Date(T0 + TICK_MS).toISOString());
  assert.equal(accounts.find((a) => a.id === "hidden")?.lastSyncAt, "", "not read is not read");
  assert.equal(store.counts.writes, 0);
});

test("a source that vanished is logged once across three ticks and a browse, and written once", async () => {
  const store = diskDeps({ accounts: [macAccount("ex", "src-old", { title: "Exchange", kind: "exchange", calendars: [{ id: "c1", name: "Calendar", shown: true }] })] },
    [source("src-icloud", "iCloud", "icloud", 2)]);
  const sync = createSync(store.deps);
  for (let i = 0; i < 3; i += 1) { await sync.refresh(); store.advance(TICK_MS); }
  await sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.equal(store.logs.length, 1, "said when it went missing, not every five minutes");
  assert.match(store.logs[0], /Exchange/);
  assert.equal(store.counts.fetches.get("ex") ?? 0, 0, "a source not on this Mac costs no events launch");
  assert.equal(store.counts.writes, 1, "missingSince is written the first time only");
  assert.equal(store.disk().accounts[0].missingSince, new Date(T0).toISOString());
  assert.equal((await sync.settings()).accounts[0].errorCode, "source_gone");
});

test("a source that comes back is read again and loses its missingSince", async () => {
  const live: CalendarSource[] = [];
  const store = diskDeps({ accounts: [macAccount("ex", "src-ex", { title: "Exchange", kind: "exchange", calendars: [{ id: "c1", name: "Calendar", shown: true }] })] }, live);
  const sync = createSync(store.deps);
  await sync.refresh();
  assert.notEqual(store.disk().accounts[0].missingSince, "");
  live.push(source("src-ex", "Exchange", "exchange", 1));
  store.advance(TICK_MS);
  await sync.refresh();
  assert.equal(store.disk().accounts[0].missingSince, "");
  assert.equal(store.counts.fetches.get("ex"), 1);
  assert.equal((await sync.settings()).accounts[0].errorCode, "");
});

// --- Final review: the answers a write gives, and what a tick may correct ---

test("relink forgets the old mailbox and learns the new source's owner from its own events", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [exchangeRow()] }), // owner me@example.com, the mailbox that went
    fetchSources: async () => [moved],
    fetchCalendars: async () => movedCalendars,
    fetchEvents: async (acc) => [{
      ...event("e1", acc.id), calendarId: "new-cal",
      attendees: [{ name: "Other", email: "other@example.com", response: "accepted", self: true, organiser: true }],
    }],
  });
  const result = await sync.relink("ex", "src-exchange-new");
  assert.equal(result.error, "");
  assert.equal(result.settings?.accounts[0].owner, "other@example.com", "the label follows the mailbox the row now reads");
});

test("a second tap on a relink that has just landed answers done, not refused", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [exchangeRow()] }),
    fetchSources: async () => [moved],
    fetchCalendars: async () => movedCalendars,
  });
  const [first, second] = await Promise.all([sync.relink("ex", "src-exchange-new"), sync.relink("ex", "src-exchange-new")]);
  assert.equal(first.error, "");
  assert.equal(second.error, "", "the row already reads that source");
  assert.equal(second.settings?.accounts[0].sourceId, "src-exchange-new");
});

/** A fetchEvents that hangs while `hold` is set, so a test can keep a refresh in flight. */
function stalling() {
  let release = () => {};
  let hold = false;
  return {
    stall() {
      hold = true;
    },
    release() {
      hold = false;
      release();
    },
    fetch: async () => {
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return [];
    },
  };
}

test("an edit answers within the post-write cap however long the refresh after it takes", async () => {
  const slow = stalling();
  const logged: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    log: (line) => logged.push(line),
    postWriteWaitMs: 20,
    fetchEvents: async () => {
      await slow.fetch();
      return [event("evt-1", "acc-1")];
    },
    updateEvent: async () => slow.stall(),
  });
  await sync.refresh();
  const result = await sync.update({ ...createInput("acc-1"), eventId: "evt-1", title: "Moved" });
  assert.deepEqual(result, { error: "" }, "the write landed; the refresh is still running");
  assert.ok(logged.some((line) => /refresh after update/.test(line)), "the slow refresh is logged");
  slow.release();
});

test("a create answers within the post-write cap however long the refresh after it takes", async () => {
  const slow = stalling();
  const created = event("new-1", "acc-1");
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    postWriteWaitMs: 20,
    fetchEvents: slow.fetch,
    createEvent: async () => {
      slow.stall();
      return created;
    },
  });
  assert.deepEqual(await sync.create(createInput("acc-1")), { event: created, error: "" });
  slow.release();
});

test("hiding a calendar answers within the cap, and a refresh that fails after it is not a failed toggle", async () => {
  const base = memoryDeps({ accounts: [account("acc-1", "Exchange")] });
  let reads = 0;
  const sync = createSync({
    ...base,
    read: async () => {
      reads += 1;
      // The toggle's own read and write succeed; the refresh after it cannot read the store.
      if (reads === 2) throw new Error("disk gone");
      return base.read();
    },
  });
  const view = await sync.setCalendars("acc-1", { "acc-1-cal": false }).catch((error: unknown) => error);
  assert.ok(!(view instanceof Error), "the toggle was written; only the read-back failed");
});

test("Allow access says denied only when macOS answered no", async () => {
  const answers: Array<() => Promise<boolean>> = [
    async () => false,
    async () => true,
    async () => { throw new Error("could not build the EventKit helper (is 'swiftc' installed?): exit 1"); },
  ];
  const logged: string[] = [];
  for (const [answer, expected] of [[answers[0], "denied"], [answers[1], "granted"], [answers[2], "unknown"]] as const) {
    const sync = createSync({ ...memoryDeps({ accounts: [] }), log: (line) => logged.push(line), askAccess: answer });
    assert.equal((await sync.requestAccess()).access, "asking");
    await new Promise((resolve) => setImmediate(resolve));
    const view = await sync.settings();
    assert.equal(view.access, expected);
    // A build failure is not a refusal: Settings keeps the button and says what went wrong.
    if (expected === "unknown") assert.match(view.accessError, /swiftc/);
    else assert.equal(view.accessError, "");
  }
  assert.ok(logged.some((line) => /access request failed/.test(line)));
});

test("a tick that lists this Mac's sources proves access, and one refused for access proves the opposite", async () => {
  let fail = false;
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    fetchSources: async () => {
      if (fail) throw new Error("calendar access not granted");
      return [source("src-acc-1")];
    },
  });
  assert.equal((await sync.settings()).access, "unknown");
  await sync.refresh();
  assert.equal((await sync.settings()).access, "granted");
  fail = true;
  await sync.refresh();
  assert.equal((await sync.settings()).access, "denied");
});

test("the tick asks for sources on a read's budget once access is known to be granted", async () => {
  const budgets: string[] = [];
  const sync = createSync({
    ...memoryDeps({ accounts: [account("acc-1", "Exchange")] }),
    fetchSources: async (budget) => {
      budgets.push(budget ?? "");
      return [source("src-acc-1")];
    },
  });
  await sync.refresh();
  await sync.refresh();
  // The first may be raising the permission dialog; the second runs after one proved access.
  assert.deepEqual(budgets, ["access", "read"]);
});

test("Settings knows when the store is broken even when no copy could be made", async () => {
  const broken = createSync({ read: async () => ({ stored: emptyStored(), broken: true, aside: "" }), write: async () => {}, log: () => {}, available: () => false });
  const view = await broken.settings();
  assert.deepEqual([view.storeBroken, view.storeAside], [true, ""]);
  assert.equal((await createSync(memoryDeps({})).settings()).storeBroken, false);
});

test("a disconnect a broken store refused says so, and the row stays", async () => {
  const stored = { ...emptyStored(), accounts: [account("acc-1", "Exchange")] };
  const sync = createSync({ read: async () => ({ stored: structuredClone(stored), broken: true, aside: "" }), write: async () => {}, log: () => {}, available: () => false });
  assert.equal(await sync.disconnect("acc-1"), false);
  assert.equal((await sync.settings()).accounts.length, 1);
  assert.equal(await createSync(memoryDeps({ accounts: [account("acc-2", "iCloud")] })).disconnect("acc-2"), true);
});

test("a disconnect drops the browsed ranges that still held the account's meetings", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [account("keep", "Keep"), account("gone", "Gone")] }),
    fetchEvents: async (acc) => [{ ...event(`e-${acc.id}`, acc.id), title: acc.id, start: "2027-03-02T09:00:00.000Z", end: "2027-03-02T09:30:00.000Z" }],
  });
  const march = () => sync.range(new Date("2027-03-01T00:00:00.000Z"), new Date("2027-04-01T00:00:00.000Z"));
  assert.deepEqual((await march()).events.map((e) => e.accountId), ["keep", "gone"]);
  await sync.disconnect("gone");
  assert.deepEqual((await march()).events.map((e) => e.accountId), ["keep"]);
});

test("a store that cannot be written does not stop the board from updating", async () => {
  const base = memoryDeps({ accounts: [account("acc-1", "Exchange")] });
  const logged: string[] = [];
  let writes = 0;
  let disk = true;
  const sync = createSync({
    ...base,
    log: (line) => logged.push(line),
    write: async (value) => {
      writes += 1;
      if (!disk) throw new Error("ENOSPC: no space left on device");
      await base.write(value);
    },
    // Each tick learns a new owner, so each has something to write.
    fetchEvents: async () => [event("evt-1", "acc-1")],
    fetchSources: async () => [{ id: "src-acc-1", title: `Exchange ${writes}`, kind: "exchange", calendars: 1 }],
  });
  disk = false;
  const view = await sync.refresh();
  assert.deepEqual(view.events.map((e) => e.id), ["evt-1"], "published although the write failed");
  assert.ok(logged.some((line) => /could not be saved/.test(line)));
  disk = true;
  await sync.refresh();
  assert.ok(writes >= 2, "the write is tried again on the next tick");
});

test("re-reading calendars whose ids macOS changed keeps the hidden ones hidden, by name", () => {
  const existing = macAccount("acc-1", "src-1", {
    calendars: [{ id: "old-cal", name: "Calendar", shown: true }, { id: "old-bday", name: "Birthdays", shown: false }],
  });
  const merged = mergeAccount(existing, {
    sourceId: "src-1", title: "Exchange", kind: "exchange",
    calendars: [{ id: "new-cal", name: "Calendar" }, { id: "new-bday", name: "Birthdays" }, { id: "new-x", name: "Holidays" }],
  });
  assert.deepEqual(merged.calendars.map((c) => [c.name, c.shown]), [["Calendar", true], ["Birthdays", false], ["Holidays", true]]);
});

test("Settings says listing this Mac's accounts failed instead of claiming every account is here", async () => {
  let fail = true;
  const sync = createSync({
    ...memoryDeps({ accounts: [] }),
    accessStatus: async () => "granted",
    fetchSources: async () => {
      if (fail) throw new Error("eventkit helper timed out after 15000ms");
      return [source("s1")];
    },
  });
  try {
    await sync.start();
    const failed = await sync.settings();
    assert.deepEqual([failed.found, failed.foundFailed], [[], true]);
    fail = false;
    const listed = await sync.settings();
    assert.deepEqual([listed.found.map((s) => s.id), listed.foundFailed], [["s1"], false]);
  } finally {
    sync.stop();
  }
});

test("a connect is reported done only once the board's snapshot has the new account's meetings", async () => {
  const sync = createSync({
    ...memoryDeps({ accounts: [] }),
    fetchSources: async () => [source("s-icloud", "iCloud", "caldav", 1)],
    fetchCalendars: async () => [{ id: "home", name: "Home" }],
    // Slow enough that a job marked done before its refresh would be seen done first.
    fetchEvents: async (acc) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ ...event("e1", acc.id), calendarId: "home" }];
    },
  });
  await sync.connect({ sourceId: "s-icloud" });
  for (let waited = 0; (await sync.settings()).connect?.state === "running"; waited += 5) {
    assert.ok(waited < 2000, "connect never settled");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await sync.settings()).connect?.state, "done");
  assert.deepEqual(sync.snapshot().events.map((e) => e.id), ["e1"], "the board reads the new account at once");
});
