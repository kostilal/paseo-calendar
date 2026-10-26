import { createHash, randomUUID } from "node:crypto";
import { accountLabel, carryShown, readOnlyKind, relinkCandidate, relinkSuspect } from "../shared/accounts.ts";
import type {
  AccessState,
  AccountView,
  BoardView,
  ConnectJob,
  ErrorCode,
  EventsView,
  SettingsView,
} from "../shared/calendar.ts";
import { companyOfAttendee, registrableDomain } from "../shared/company.ts";
import type { Event } from "../shared/event.ts";
import { eventKey } from "../shared/group.ts";
import { joinUrl, type Conference } from "../shared/join.ts";
import { copiesMergedWith, isCancelledTitle, mergeMeetings } from "../shared/meeting.ts";
import { SNAPSHOT_DAYS } from "../shared/period.ts";
import { STALE_AFTER_MS } from "../shared/schedule.ts";
import {
  eventkitAccess,
  eventkitAvailable,
  type SourcesBudget,
  eventkitDelete,
  eventkitStatus,
  eventkitUpdate,
  eventkitCalendars,
  eventkitCreate,
  eventkitEvents,
  eventkitSources,
  type CalendarSource,
  type CreateInput,
  type UpdateInput,
} from "./eventkit.ts";
import { clashes, type Clash } from "../shared/overlap.ts";
import { storedChanged, type ReadResult, type Stored, type StoredAccount } from "./store.ts";

/** Five minutes: a calendar changes on the scale of a person accepting an invitation. */
export const TICK_MS = 5 * 60_000;
/** Shared with the board, which polls a day view only while the day is inside this window. */
export const WINDOW_DAYS = SNAPSHOT_DAYS;

/**
 * eventkitAvailable() is false on anything but darwin. Every way into EventKit — connect(),
 * the tick and a browse, create(), update() and remove() — needs this exact wording so a user
 * sees the same message whichever one fails, and so the settings screen can show it rather than
 * a `swiftc` compile failure that points at the wrong cause.
 */
export const MACOS_REQUIRED = "reading a system calendar needs macOS: EventKit is not available on this platform";
/** Connecting without a chosen source used to mean taking every calendar on the machine. */
const SOURCE_REQUIRED = "no calendar account was chosen";
/** Long enough that paging back and forth is instant, short enough to still be today. */
const RANGE_TTL_MS = 60_000;
/**
 * How long a write's answer waits for the refresh after it. Normally that refresh takes about a
 * second and the answer then carries the change, which is what lets the pill's nudge read it. A
 * stuck helper can make it take far longer, and the plugin host cuts an RPC off at 30 seconds:
 * a create reported as failed after EventKit saved it is a create somebody taps again. Past this,
 * the answer goes out and the refresh finishes on its own.
 */
export const POST_WRITE_WAIT_MS = 20_000;

/**
 * Waits for `work` to finish, but never longer than `ms`: true when it finished in time, failed
 * or not, false when the cap came first. Never rejects, and leaves no timer behind. The work runs
 * on after the cap, and a failure it has then is absorbed here as well, so a caller that wants
 * to log one attaches its own handler before passing it in.
 */
export async function waitAtMost(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), capped]);
  } finally {
    clearTimeout(timer);
  }
}

const MAX_CACHED_RANGES = 24;
const ACCOUNT_GONE = "that account is no longer connected";
/**
 * The snapshot is the fortnight from local midnight today, and a meeting outside it is never in
 * it, whatever the client does: so the words name the window and send the change to Calendar
 * rather than promising that a refresh helps.
 */
const EVENT_GONE =
  "that meeting is not among the ones this plugin holds (today to 14 days ahead), so it cannot be changed here; change it in Calendar";
const SERIES_NOT_DELETED = "this is a repeating meeting; deleting the series is not supported";
const SERIES_NOT_EDITED = "this is a repeating meeting; editing the series is not supported";
/**
 * The edit path writes instants, and an all-day event's start and end are bare dates: saving one
 * would hand EventKit UTC midnights, a day early west of Greenwich and two days long east of it.
 */
const ALL_DAY_NOT_EDITED = "this is an all-day event; editing it here is not supported, change it in Calendar";
/** Subscribed and birthday sources never take a new event; refused before the helper is launched. */
const READ_ONLY_ACCOUNT = "this calendar account is read-only on this Mac: subscribed and birthday calendars do not accept new events";
const CONNECT_BUSY = "another account is already being connected — wait for that one to finish";
const SOURCE_GONE = "that calendar account is no longer on this Mac — pick it again from the list";
/** Refuses a connect or a relink, and is carried in every error list, while the store reads as broken. */
const STORE_BROKEN = "the stored calendar settings did not read cleanly, so nothing is saved until they do";
/**
 * Carried by a stored account whose source the Mac no longer lists. The words are the ones
 * eventkit.ts used to throw for the same state, so shared/schedule.ts's failureNote still
 * recognises them.
 */
export const SOURCE_MISSING =
  "this calendar account is no longer on this Mac: add it back in System Settings → Internet Accounts with Calendars on";
/**
 * How long a browse or a settings read may reuse the last list of this Mac's sources. The tick
 * always asks afresh; a minute is long enough that paging through months costs one launch.
 */
export const SOURCES_TTL_MS = 60_000;
/**
 * A relink whose source, re-read at accept time, is no longer this row's one match: gone,
 * renamed, connected meanwhile, joined by a second match, missing a stored calendar name, or
 * one that another missing row could equally have moved to.
 */
export const RELINK_REFUSED =
  "that calendar account cannot be re-linked to this row any more — open Settings again to see what this Mac has";

type SyncError = EventsView["errors"][number];

/**
 * A failure that already knows its code. Our own refusals throw this, so errorCodeOf never
 * has to read their words.
 */
export class CodedError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one place a failure's words become a code. Ours carry it (CodedError); the helper's are
 * frozen English: the Swift `fail("calendar access not granted")`, the "has not been granted
 * yet" sync used to say itself and an older stored error may still carry, and eventkit.ts's
 * three ways of saying the helper itself would not run.
 */
export function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof CodedError) return error.code;
  const message = messageOf(error);
  if (/calendar access (has )?not (been )?granted/i.test(message)) return "access_needed";
  if (/^(could not build the EventKit helper|the calendar helper failed|eventkit helper timed out)/.test(message)) return "helper_failed";
  return "unknown";
}

/** An address and nothing else: no spaces, no slashes or colons, a dot after the @. */
const MAILBOX = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;

/**
 * The mailbox an account is: the first attendee EventKit marks as `self` with a real address,
 * trimmed, or "". The guard matters because the helper's emailOf hands back the raw URL when
 * it is not `mailto:`, and CalDAV hands out principal paths that must never become a row's name.
 */
export function ownerFrom(events: readonly Event[]): string {
  for (const event of events) {
    for (const attendee of event.attendees) {
      if (!attendee.self) continue;
      const email = attendee.email.trim();
      if (MAILBOX.test(email)) return email;
    }
  }
  return "";
}

/**
 * The fortnight the tick keeps warm, from the daemon's local midnight to the local midnight
 * WINDOW_DAYS calendar days on, which across a clock change is not 14 × 24 h. Local, because
 * local today has to be inside it: from UTC midnight, today's first hours east of Greenwich fell
 * before the window, so the Day view and "today" could never be answered from it.
 */
export function windowFor(nowMs: number): { from: Date; to: Date } {
  const from = new Date(nowMs);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + WINDOW_DAYS);
  return { from, to };
}

/** True when the range [from, to) lies wholly inside the window [window.from, window.to). */
export function coveredBy(window: { from: Date; to: Date }, from: Date, to: Date): boolean {
  return window.from.getTime() <= from.getTime() && to.getTime() <= window.to.getTime();
}

/**
 * Local midnight of an all-day "YYYY-MM-DD", read the way the board's byDay reads it: an
 * all-day date is a day on the wall calendar, not an instant in UTC.
 */
function localMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

/**
 * The part of a view that falls in [from, to), as a provider pass over that range would have
 * returned it: what overlaps the range, plus a zero-length event at its start. A clash stays only
 * while both its sides do, so a collision across the range's edge is not reported against a row
 * that is not there.
 */
export function sliceView(view: EventsView, from: Date, to: Date): EventsView {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const at = (value: string, allDay: boolean) => (allDay ? localMidnight(value) : Date.parse(value));
  const events = view.events.filter((event) => {
    const startMs = at(event.start, event.allDay);
    const endMs = at(event.end, event.allDay);
    return startMs < toMs && (endMs > fromMs || startMs >= fromMs);
  });
  const kept = new Set(events.map(eventKey));
  const clashes = view.clashes.filter((clash) => kept.has(eventKey(clash.a)) && kept.has(eventKey(clash.b)));
  // Named field by field rather than spread: a field added to EventsView later must be decided
  // here, not carried over unsliced.
  const sliced = { events, clashes, errors: view.errors };
  return { ...sliced, syncedAt: view.syncedAt, version: versionOf(sliced), unchanged: false };
}

/**
 * What identifies an answer's content, for `since`: a hash of the events, clashes and errors,
 * and not of `syncedAt`, which moves every tick whether anything else did or not.
 *
 * Hashed from a copy put in a fixed order, because EventKit makes no promise about the order it
 * returns anything in, and a version that followed it would differ between two reads of the same
 * calendar and resend the whole answer every minute. That holds at two levels: the events
 * themselves, and the attendees inside one event, which were seen live to come back in a
 * different order on every read. `alsoIn` follows the input order too, and a clash's sides and
 * its place in the list (clashes() sorts by start, stably), so those are put in order the same way.
 * The key order inside each object is stable because one code path builds it: viewOf for an
 * event, the helper's schema for an attendee. `errors` keep their order: it is the stored
 * account order, not EventKit's. The response itself keeps EventKit's order; only the hash is
 * order-free.
 */
export function versionOf(view: Pick<EventsView, "events" | "clashes" | "errors">): string {
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = <T>(list: readonly T[]) => list.map((item) => JSON.stringify(item)).sort(byText);
  const events = view.events
    .map((event) => ({ ...event, attendees: sorted(event.attendees), alsoIn: sorted(event.alsoIn) }))
    .sort((a, b) => byText(eventKey(a), eventKey(b)));
  const clashes = view.clashes
    .map((clash) => [eventKey(clash.a), eventKey(clash.b)].sort(byText).concat(String(clash.overlapMs)).join("|"))
    .sort(byText);
  return createHash("sha1").update(JSON.stringify([events, clashes, view.errors])).digest("hex").slice(0, 16);
}

/**
 * The answer to a caller that holds version `since`: nothing but the sync time when that is
 * still the version it would have been sent, the view itself otherwise. An empty version means
 * nothing was computed yet and never matches, so a caller is not told "unchanged" about a view
 * that does not exist.
 */
export function answerSince(view: EventsView, since: string | undefined): EventsView {
  if (since && view.version && since === view.version) {
    return { events: [], clashes: [], errors: [], syncedAt: view.syncedAt, version: view.version, unchanged: true };
  }
  return view;
}

/**
 * Connecting a source that is already stored is a reconnect, not a second account: the row
 * keeps its id (stored order and every reference to it stay put), what it has learned about
 * its owner, and whichever calendars were hidden. Without this a reconnect handed back a
 * brand new account with every calendar shown, undoing whatever the user had hidden. The
 * caller matches on sourceId; a genuinely new source still gets a fresh id and everything
 * shown. The error state is cleared because the connect has just read the source cleanly.
 */
export function mergeAccount(
  existing: StoredAccount | undefined,
  fresh: { sourceId: string; title: string; kind: string; calendars: { id: string; name: string }[] },
): StoredAccount {
  const priorShown = new Map((existing?.calendars ?? []).map((calendar) => [calendar.id, calendar.shown] as const));
  // An id the row has never seen is matched by name, as a relink matches them: macOS can hand a
  // source that stayed put new calendar ids after a full resync, and reading its calendars again
  // must not turn every calendar the user hid back on.
  const byName = carryShown(existing?.calendars ?? [], fresh.calendars);
  return {
    id: existing?.id ?? randomUUID(),
    sourceId: fresh.sourceId,
    title: fresh.title,
    owner: existing?.owner ?? "",
    kind: fresh.kind,
    // Everything on by default, same as a first connect; a calendar already hidden stays hidden.
    calendars: fresh.calendars.map((calendar, index) => ({
      ...calendar,
      shown: priorShown.get(calendar.id) ?? byName[index]!.shown,
    })),
    lastError: "",
    errorCode: "",
    missingSince: "",
    lastSyncAt: existing?.lastSyncAt ?? "",
  };
}

/**
 * overlap.ts's Clash carries full Event objects, so this is where a clash first gets the
 * bare shape the wire contract (calendar.ts's clashView) actually sends — each side reduced
 * to its own {accountId, id}, the same composite eventKey uses, rather than the bare id
 * alone that used to make two accounts' copies of one meeting indistinguishable on the
 * other end. Deduped by that composite pair (order-independent, so a-b and b-a count as the
 * same clash): two rows that are really the same account's same event — a fetch returning
 * one event twice is the plausible cause — must not clash twice with a third event just
 * because both copies survived long enough to be compared against it.
 */
export function dedupeClashes(found: Clash[]): EventsView["clashes"] {
  const seen = new Set<string>();
  const deduped: EventsView["clashes"] = [];
  for (const clash of found) {
    const aKey = eventKey(clash.a);
    const bKey = eventKey(clash.b);
    const pairKey = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    deduped.push({
      a: { accountId: clash.a.accountId, id: clash.a.id },
      b: { accountId: clash.b.accountId, id: clash.b.id },
      overlapMs: clash.overlapMs,
    });
  }
  return deduped;
}

export interface SyncDeps {
  read: () => Promise<ReadResult>;
  write: (stored: Stored) => Promise<void>;
  log: (line: string) => void;
  now?: () => number;
  /**
   * Injected so a test that starts sync never launches the real helper: start() asks the
   * helper for the access status whenever EventKit is available. The defaults are
   * eventkitAvailable and eventkitStatus.
   */
  available?: () => boolean;
  accessStatus?: () => Promise<"unknown" | "granted" | "denied">;
  /**
   * Raises the macOS permission dialog: true or false is macOS's answer, a throw is a helper that
   * could not ask. Defaults to eventkitAccess.
   */
  askAccess?: () => Promise<boolean>;
  /** How long a write waits for its refresh before answering; POST_WRITE_WAIT_MS unless a test says. */
  postWriteWaitMs?: number;
  /**
   * This Mac's calendar sources, one helper launch per call; defaults to eventkitSources. Every
   * caller goes through liveSources, so a tick launches it once however many accounts it reads.
   */
  fetchSources?: (budget?: SourcesBudget) => Promise<CalendarSource[]>;
  /** One source's calendars, for a connect, a relink and a relink offer; defaults to eventkitCalendars. */
  fetchCalendars?: (sourceId: string) => Promise<{ id: string; name: string }[]>;
  /**
   * The per-account fetch, injected so createSync's coordination — the per-account failure
   * boundary above everything else — can be tested without a real account or a real calendar
   * store. Defaults to EventKit. `stored` is unused by the default and kept so the seam's shape
   * does not move under every test that injects it.
   */
  fetchEvents?: (account: StoredAccount, stored: Stored, from: Date, to: Date) => Promise<Event[]>;
  /** Same seam as fetchEvents, for create(); same default. */
  createEvent?: (account: StoredAccount, stored: Stored, input: CreateInput) => Promise<Event | null>;
  /**
   * The same seam again, for update() and remove(). Without them a test of either can only
   * reach the guards that return before EventKit is touched — everything past that point
   * launches the real helper, which is how the first attempt at testing the snapshot
   * bookkeeping around a delete failed for a reason that had nothing to do with the
   * bookkeeping.
   */
  updateEvent?: (account: StoredAccount, stored: Stored, input: UpdateInput) => Promise<void>;
  removeEvent?: (account: StoredAccount, stored: Stored, input: { calendarId: string; eventId: string }) => Promise<void>;
}

export interface Sync {
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<EventsView>;
  snapshot(): EventsView;
  settings(): Promise<SettingsView>;
  /**
   * Starts a connect and returns at once; watch settings().connect for how it ends. See
   * shared/calendar.ts's connectJob for why this cannot be the RPC's return value.
   */
  connect(input: { sourceId: string }): Promise<{ started: boolean; error: string }>;
  /** Raises the macOS permission dialog and returns at once; watch settings().access. */
  requestAccess(): Promise<{ access: AccessState }>;
  /**
   * Everything between two instants. A range inside the fortnight the last tick read, while that
   * read is fresh, is a slice of the snapshot and costs no launch: the Day view and "today".
   * Anything else, a month or a day outside the fortnight, is a provider pass, cached briefly.
   */
  range(from: Date, to: Date): Promise<EventsView>;
  /** False when a broken store refused the write, and the row is still there. */
  disconnect(accountId: string): Promise<boolean>;
  /**
   * Moves a row onto the source its macOS account moved to, keeping the row's id and its hidden
   * calendars. Only ever on request, and the offer settings() made is re-checked from scratch.
   */
  relink(accountId: string, sourceId: string): Promise<{ error: string; settings: SettingsView | null }>;
  setCalendars(accountId: string, shown: Record<string, boolean>): Promise<SettingsView>;
  /** How early the composer pill appears, in minutes; 0 means always. */
  setPillLead(minutes: number): Promise<SettingsView>;
  /** Which view the board opens on. */
  setDefaultView(view: BoardView): Promise<SettingsView>;
  create(input: CreateInput & { accountId: string }): Promise<{ event: Event | null; error: string }>;
  /** Change a one-off meeting. Refuses a series; see shared/calendar.ts's updateEvent. */
  update(input: UpdateInput & { accountId: string }): Promise<{ error: string }>;
  /** Remove a one-off meeting. Refuses a series; see shared/calendar.ts's deleteEvent. */
  remove(input: { accountId: string; eventId: string; calendarId: string }): Promise<{ error: string }>;
}

export function createSync(deps: SyncDeps): Sync {
  const now = deps.now ?? (() => Date.now());
  const available = deps.available ?? eventkitAvailable;
  const fetchSources = deps.fetchSources ?? eventkitSources;
  const fetchCalendars = deps.fetchCalendars ?? eventkitCalendars;
  let events: Event[] = [];
  let syncedAt = "";
  let errors: SyncError[] = [];
  /**
   * The read time of each account, by id. Kept here because a tick that changed nothing no
   * longer writes it: settings() reports this over the stored lastSyncAt.
   */
  const readAt = new Map<string, string>();
  /** The last list of this Mac's sources and when it was taken; see liveSources. */
  let sourcesCache: { at: number; list: CalendarSource[] } | null = null;
  let sourcesInFlight: Promise<CalendarSource[]> | null = null;
  // Both of these are deliberately in memory rather than on disk: they describe what this
  // daemon is doing right now, and a restart means nothing is in flight any more.
  let access: AccessState = "unknown";
  /** Why the last request could not ask macOS at all; see settingsView.accessError. */
  let accessError = "";
  /**
   * Browsed ranges, keyed by their bounds. A month view redraws on every navigation and the
   * same month is revisited constantly; without this, stepping back and forth over three
   * months would refetch each of them every time. Short-lived on purpose — a browse should
   * still notice a meeting added minutes ago — and dropped wholesale by refresh(), which is
   * the explicit "I want the truth now" gesture.
   */
  const ranges = new Map<string, { at: number; view: EventsView }>();
  let job: ConnectJob | null = null;
  /**
   * The last computed view. `snapshot()` must not rebuild one from an empty account list:
   * with no accounts there are no own domains, every colleague reads as external, and the
   * card fills with companies that are not there.
   */
  let last: EventsView = { events: [], clashes: [], syncedAt: "", errors: [], version: "", unchanged: false };
  /** The window `last` was read over, set with it by a tick; range() slices only inside it. */
  let held: { from: Date; to: Date } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** One tick at a time: a slow read must not have two fetches in flight. */
  let running: Promise<EventsView> | null = null;
  /**
   * True from stop() until the next start(). A tick already past this check when stop() is
   * called still has to finish the provider calls it is mid-flight on, but it must not write
   * that result to disk or publish it in memory once the caller has been told sync stopped —
   * so the tick re-checks this flag right before each of those two and discards its own
   * result in favour of whatever is already there.
   */
  let stopped = false;
  /**
   * FIFO turn-taking for every read-modify-write cycle against the store: the tick and each
   * mutator queue behind whichever one is currently in flight, rather than interleaving and
   * letting a late write silently undo an earlier one. Distinct from `running` above, which
   * collapses concurrent refresh() calls into a single tick; this queues genuinely separate
   * operations and runs every one of them, each to completion, in submission order.
   *
   * A task must never itself await a serialized() call against this same queue — that would
   * wait on its own turn to end before its turn can end. remove() sidesteps this by firing its
   * post-write refresh() without awaiting it, mirroring the periodic tick's own fire-and-forget
   * below (it has already dropped the meeting from the snapshot); connect(), setCalendars(),
   * relink(), update() and create() sidestep it by closing their serialized task at the write and
   * waiting for refresh() only after that task has returned, through settle().
   */
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const turn = queue.then(task);
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** JSON of the store as the last serialized operation read or wrote it. "" = nothing yet. */
  let lastText = "";
  /** The last serialized read was broken: nothing may be written until a clean one. */
  let broken = false;
  let brokenAside = "";

  /**
   * Every serialized operation reads through here; it is what arms or clears read-only mode.
   * A migrated read leaves lastText empty: a migrated store equals itself, so without this
   * persist() would never write the v2 file, and writeStored would never make `.v1.bak`.
   */
  async function load(): Promise<Stored> {
    const result = await deps.read();
    if (result.broken && !broken) {
      // No aside means the file would not open or the copy would not write; either way the
      // file as found is the only one, and the log must not suggest otherwise.
      const where = result.aside ? `copy at ${result.aside}` : "no copy could be made, so the file as found is the only one";
      deps.log(`calendar: the stored settings did not read cleanly (${where}); nothing will be written until they do`);
    }
    broken = result.broken;
    brokenAside = result.broken ? result.aside : "";
    lastText = !result.broken && result.migrated ? "" : JSON.stringify(result.stored);
    return result.stored;
  }

  /** The only place sync writes. False when a broken read forbids it; true when written or unchanged. */
  async function persist(stored: Stored): Promise<boolean> {
    if (broken) return false;
    if (!storedChanged(lastText, stored)) return true;
    await deps.write(stored);
    lastText = JSON.stringify(stored);
    return true;
  }

  /**
   * Waits for a refresh after a write, but never longer than the post-write cap; see
   * POST_WRITE_WAIT_MS. Never rejects: the write has already happened, and a refresh that failed
   * or is still running only means the next tick reads it, so it is logged, not reported.
   */
  async function settle(after: string): Promise<void> {
    const refreshed = api.refresh().catch((error: unknown) => {
      deps.log(`calendar: refresh after ${after} failed: ${String(error)}`);
    });
    if (!(await waitAtMost(refreshed, deps.postWriteWaitMs ?? POST_WRITE_WAIT_MS))) {
      deps.log(`calendar: refresh after ${after} is still running; answered without it`);
    }
  }

  /**
   * This Mac's sources, reused while younger than `maxAgeMs`. The comparison is strict, so 0
   * always asks afresh, unless a launch is already in flight: then every caller shares it. A
   * failure is not cached, so the next caller asks again.
   */
  function liveSources(maxAgeMs: number, budget: SourcesBudget = "access"): Promise<CalendarSource[]> {
    if (sourcesCache && now() - sourcesCache.at < maxAgeMs) return Promise.resolve(sourcesCache.list);
    if (sourcesInFlight) return sourcesInFlight;
    const started = fetchSources(budget).then((list) => {
      sourcesCache = { at: now(), list };
      return list;
    });
    sourcesInFlight = started;
    // Not .finally(), for ensureHelper's reason: it would leave an unobserved twin of a rejection.
    const clear = () => {
      if (sourcesInFlight === started) sourcesInFlight = null;
    };
    started.then(clear, clear);
    return started;
  }

  /**
   * Calendar names by source, for settings()'s relink offer only, kept as long as the list of
   * sources is: a Settings screen polls, and each read would otherwise launch the helper once per
   * row that has a suspect. A failure is not cached. relink() never reads through this.
   */
  const calendarNames = new Map<string, { at: number; names: string[] }>();
  async function sourceCalendarNames(sourceId: string): Promise<string[]> {
    const hit = calendarNames.get(sourceId);
    if (hit && now() - hit.at < SOURCES_TTL_MS) return hit.names;
    const names = (await fetchCalendars(sourceId)).map((calendar) => calendar.name);
    calendarNames.set(sourceId, { at: now(), names });
    return names;
  }

  /**
   * True when a row other than `accountId` could also have moved to `sourceId`. Two mailboxes
   * macOS calls "Exchange" can both go and one come back, and nothing says whose it is: two
   * equally good matches are no match, across rows as within one. Judged by suspect, not by
   * candidate, so settings() offers exactly what relink() would accept.
   */
  function claimedByAnother(
    accounts: readonly StoredAccount[],
    accountId: string,
    sourceId: string,
    live: readonly CalendarSource[],
    connectedIds: ReadonlySet<string>,
  ): boolean {
    return accounts.some((other) => other.id !== accountId && relinkSuspect(other, live, connectedIds)?.id === sourceId);
  }

  /**
   * Each row's relink offer by shared/accounts.ts's rules, and every source some row matched.
   * `matched` keeps a source out of `found` even when the offer is withheld for being claimed by
   * two rows: an Add button for it would only make a third row for the same mailbox.
   */
  async function relinkOffers(
    accounts: readonly StoredAccount[],
    live: readonly CalendarSource[],
    connectedIds: ReadonlySet<string>,
  ): Promise<{ offers: AccountView["relinkTo"][]; matched: Set<string> }> {
    const candidates = await Promise.all(
      accounts.map(async (account) => {
        const suspect = relinkSuspect(account, live, connectedIds);
        if (!suspect) return null;
        const names = await sourceCalendarNames(suspect.id).catch(() => []);
        return relinkCandidate(account, live, connectedIds, names);
      }),
    );
    const offers = candidates.map((candidate, index) =>
      candidate && !claimedByAnother(accounts, accounts[index]!.id, candidate.id, live, connectedIds)
        ? { sourceId: candidate.id, title: candidate.title, calendars: candidate.calendars }
        : null,
    );
    return { offers, matched: new Set(candidates.flatMap((candidate) => (candidate ? [candidate.id] : []))) };
  }

  /**
   * Only an account with a shown calendar is read, and so one with no stored calendars is not
   * either: EventKit would read every calendar of its source unfiltered.
   */
  function isReadable(account: StoredAccount): boolean {
    return account.calendars.some((calendar) => calendar.shown);
  }

  /** How a log line names an account: its mailbox once learned, else what macOS calls it. */
  function name(account: StoredAccount): string {
    return accountLabel(account);
  }

  /**
   * Why nothing is saved, naming the copy set aside when there is one. The path is in the message
   * verbatim because it is all a screen has to name the copy by (client/issues.ts's asideName),
   * and with no copy nothing is named, so nothing claims one.
   */
  function storeBrokenMessage(): string {
    return brokenAside ? `${STORE_BROKEN}; the file as found is kept at ${brokenAside}` : STORE_BROKEN;
  }

  function storeErrors(): SyncError[] {
    if (!broken) return [];
    return [{ accountId: "", message: storeBrokenMessage(), code: "store_broken" }];
  }

  /**
   * The domains that count as "ours", so a colleague is not labelled as an outside company: each
   * account's owner, the mailbox a tick learned from the attendee EventKit marks as `self`, and
   * that same `self` attendee on every event in the list, which covers an account whose owner is
   * not learned yet. A source title is no help: it is often the bare word "Exchange", and going
   * by it reported every colleague on that mailbox as external, 19 of 19 on the meeting that
   * surfaced it.
   */
  function ownDomains(stored: Stored, list: readonly Event[]): Set<string> {
    const domains = new Set<string>();
    for (const account of stored.accounts) {
      const domain = registrableDomain(account.owner);
      if (domain) domains.add(domain);
    }
    for (const event of list) {
      for (const attendee of event.attendees) {
        if (!attendee.self) continue;
        const domain = registrableDomain(attendee.email);
        if (domain) domains.add(domain);
      }
    }
    return domains;
  }

  // The real per-account calls, all through EventKit. Each fails loudly with the real cause
  // when EventKit is not there, rather than falling through to the helper, which would report
  // a `swiftc` compile failure instead.
  async function defaultFetchEvents(account: StoredAccount, _stored: Stored, from: Date, to: Date): Promise<Event[]> {
    if (!available()) throw new CodedError("macos_required", MACOS_REQUIRED);
    return eventkitEvents(account, from, to);
  }

  async function defaultCreateEvent(account: StoredAccount, _stored: Stored, input: CreateInput): Promise<Event | null> {
    if (!available()) throw new CodedError("macos_required", MACOS_REQUIRED);
    return eventkitCreate(account, input);
  }

  async function defaultUpdateEvent(account: StoredAccount, _stored: Stored, input: UpdateInput): Promise<void> {
    if (!available()) throw new CodedError("macos_required", MACOS_REQUIRED);
    await eventkitUpdate(account, {
      eventId: input.eventId,
      title: input.title,
      description: input.description,
      start: input.start,
      end: input.end,
    });
  }

  async function defaultRemoveEvent(
    _account: StoredAccount,
    _stored: Stored,
    input: { calendarId: string; eventId: string },
  ): Promise<void> {
    if (!available()) throw new CodedError("macos_required", MACOS_REQUIRED);
    await eventkitDelete(input.eventId);
  }

  const fetchEvents = deps.fetchEvents ?? defaultFetchEvents;
  const applyUpdate = deps.updateEvent ?? defaultUpdateEvent;
  const applyRemove = deps.removeEvent ?? defaultRemoveEvent;
  const createEvent = deps.createEvent ?? defaultCreateEvent;

  /**
   * Shape a list of events into what a client reads. Takes the list rather than closing over
   * the module's own, so the fortnight snapshot and an arbitrary range asked for by a
   * calendar view both go through exactly one implementation of attendee companies, join
   * links, the merge of one meeting's copies and clash detection.
   *
   * The list is every account's copies as fetched; what goes out is one row per meeting
   * reached through several accounts (shared/meeting.ts), kept from the account listed first in
   * Settings, with a meeting Outlook marked cancelled left off. Clashes are found over those
   * rows, so a meeting's copies never collide with each other, while two same-titled meetings at
   * one time in one account stay two rows and do. The own domains are taken from the whole list, before the
   * merge, so the self attendee of an account whose copy was not kept still counts.
   */
  function viewOf(stored: Stored, list: Event[], when: string, failures: SyncError[]): EventsView {
    const order = stored.accounts.map((account) => account.id);
    const visible = list.filter((event) => !isCancelledTitle(event.title));
    const merged = mergeMeetings(visible, order);
    const domains = ownDomains(stored, list);
    // The kept copy is not always the one with the call link in its notes: an Exchange copy
    // can carry only the room while the Google copy of the same meeting carries the Teams link.
    // Borrowed from the row's own copies only, never by key alone, which would hand one of an
    // account's two interviews at 10:00 the other's link.
    const borrowed = (row: Event & { alsoIn: readonly unknown[] }): { url: string; kind: Conference } | null => {
      if (row.alsoIn.length === 0) return null;
      for (const copy of copiesMergedWith(visible, row)) {
        const join = joinUrl(copy);
        if (join) return join;
      }
      return null;
    };
    const found = clashes(merged);
    const built = {
      events: merged.map((event) => {
        const join = joinUrl(event) ?? borrowed(event);
        return {
          ...event,
          attendees: event.attendees.map((attendee) => ({
            ...attendee,
            company: companyOfAttendee(attendee, domains),
          })),
          joinUrl: join?.url ?? "",
          joinKind: join?.kind ?? ("none" as const),
        };
      }),
      clashes: dedupeClashes(found),
      syncedAt: when,
      errors: failures,
    };
    return { ...built, version: versionOf(built), unchanged: false };
  }

  function view(stored: Stored): EventsView {
    return viewOf(stored, events, syncedAt, errors);
  }

  /**
   * Everything in a window the snapshot does not answer: a month, a day outside the fortnight,
   * or any range while the snapshot is stale. range() decides; this is only its provider path.
   *
   * Deliberately not the snapshot. `tick` owns a fixed fortnight that the composer pill reads
   * every minute; a browse three months ahead must not replace what the pill is counting down
   * to. So this collects, shapes and returns without touching `events`, `errors` or
   * `syncedAt`, and without recording per-account failures on the stored account — a browse
   * is not evidence that an account is broken. It decides the way the tick does (readable
   * accounts only, a gone source costs no launch), on a list of sources up to a minute old, and
   * does not log a gone source: the tick already did, once.
   *
   * Serialized like every other EventKit call, even though it only reads: a browse queued
   * behind a tick sees the accounts that tick settled on, rather than a store read mid-way
   * through a connect or a disconnect.
   */
  async function fetchRange(from: Date, to: Date): Promise<EventsView> {
    return serialized(async () => {
      const stored = await load();
      const collected: Event[] = [];
      const failures: SyncError[] = [];
      const readable = stored.accounts.filter(isReadable);
      const fail = (account: StoredAccount, error: unknown) => {
        const message = messageOf(error);
        failures.push({ accountId: account.id, message, code: errorCodeOf(error) });
        deps.log(`calendar: range fetch for ${name(account)} failed: ${message}`);
      };
      let live: CalendarSource[] | null = null;
      let listFailure: unknown = null;
      if (!available()) listFailure = new CodedError("macos_required", MACOS_REQUIRED);
      else if (readable.length > 0) {
        try {
          live = await liveSources(SOURCES_TTL_MS);
        } catch (error) {
          listFailure = error;
        }
      }
      for (const account of readable) {
        if (listFailure) {
          fail(account, listFailure);
          continue;
        }
        if (!live?.some((entry) => entry.id === account.sourceId)) {
          failures.push({ accountId: account.id, message: SOURCE_MISSING, code: "source_gone" });
          continue;
        }
        try {
          collected.push(...(await fetchEvents(account, stored, from, to)));
        } catch (error) {
          fail(account, error);
        }
      }
      return viewOf(stored, collected, new Date(now()).toISOString(), [...failures, ...storeErrors()]);
    });
  }

  async function tick(): Promise<EventsView> {
    const stored = await load();
    const { from, to } = windowFor(now());
    const collected: Event[] = [];
    const failures: SyncError[] = [];
    const record = (account: StoredAccount, error: unknown) => {
      const message = messageOf(error);
      account.errorCode = errorCodeOf(error);
      account.lastError = message;
      failures.push({ accountId: account.id, message, code: account.errorCode });
    };

    // One `sources` launch for the whole tick, and only when some account is to be read: which
    // accounts are on this Mac is one question, not one per account.
    const at = new Date(now()).toISOString();
    let live: CalendarSource[] | null = null;
    let listFailure: unknown = null;
    if (!available()) listFailure = new CodedError("macos_required", MACOS_REQUIRED);
    else if (stored.accounts.some(isReadable)) {
      try {
        // A read's budget once a dialog cannot appear: see helperTimeoutMs.
        live = await liveSources(0, access === "granted" ? "read" : "access");
      } catch (error) {
        listFailure = error;
        deps.log(`calendar: listing this Mac's calendar accounts failed: ${messageOf(error)}`);
      }
      // A list proves access, and a list refused for access proves the opposite. Without this a
      // status read that failed at start left "unknown" for the daemon's life: Settings offering
      // Allow access, ChatGPT told access was missing, and a later revoke never noticed. A dialog
      // on screen ("asking") is left for its own answer to settle.
      if (access !== "asking") {
        if (live) access = "granted";
        else if (errorCodeOf(listFailure) === "access_needed") access = "denied";
      }
    }

    // Per account, deliberately: one account timing out leaves the other's day on the
    // board. A single try/catch around the loop would blank everything.
    for (const account of stored.accounts) {
      const source = live?.find((entry) => entry.id === account.sourceId);
      // Kind and title follow the live source; this is what fills `kind` for a migrated row.
      if (live && source) {
        account.missingSince = "";
        account.kind = source.kind;
        account.title = source.title;
      }
      if (live && !source) {
        // missingSince persists across ticks and restarts, so the gone state is logged once.
        if (!account.missingSince) {
          account.missingSince = at;
          deps.log(`calendar: ${name(account)} (source ${account.sourceId}) is no longer on this Mac`);
        }
        account.errorCode = "source_gone";
        account.lastError = SOURCE_MISSING;
        if (isReadable(account)) failures.push({ accountId: account.id, message: SOURCE_MISSING, code: "source_gone" });
        continue;
      }
      // Switched off: not read, and so carries no error. A gone source is only cleared by a
      // list that has it again.
      if (!isReadable(account)) {
        if (live || account.errorCode !== "source_gone") {
          account.errorCode = "";
          account.lastError = "";
        }
        continue;
      }
      if (listFailure) {
        record(account, listFailure);
        continue;
      }
      try {
        const fetched = await fetchEvents(account, stored, from, to);
        collected.push(...fetched);
        account.errorCode = "";
        account.lastError = "";
        account.lastSyncAt = at;
        readAt.set(account.id, at);
        if (!account.owner) account.owner = ownerFrom(fetched);
      } catch (error) {
        record(account, error);
        deps.log(`calendar: ${name(account)} failed: ${messageOf(error)}`);
      }
    }

    // stop() may have landed while the loop above was still awaiting a fetch. If so the
    // caller was already told sync stopped, so this tick's write and publish are both
    // skipped rather than landing after the fact — checked once before each.
    if (stopped) return last;
    try {
      await persist(stored);
    } catch (error) {
      // Published all the same, for the reason below; lastText still holds what is on disk, so
      // the next tick tries the same write again.
      deps.log(`calendar: the stored settings could not be saved: ${messageOf(error)}`);
    }
    if (stopped) return last;
    // Published even while the store is broken, or cannot be written: reading is allowed, only
    // writing is not.
    events = collected;
    errors = [...failures, ...storeErrors()];
    syncedAt = new Date(now()).toISOString();
    last = view(stored);
    held = { from, to };
    return last;
  }

  /**
   * The real connect, run detached from the RPC that asked for it.
   *
   * Reports failure as words and a code rather than throwing: its only caller is the
   * fire-and-forget in connect(), where an unhandled rejection would take the daemon down
   * instead of landing on the screen waiting to show it. Still inside serialized(), so it keeps
   * its turn behind the background tick and every other mutation.
   */
  async function runConnect(input: { sourceId: string }): Promise<{ error: string; code: ErrorCode }> {
    return serialized(async () => {
      try {
        const stored = await load();
        // First, before the helper is reached: a connect on a broken store could not be saved,
        // so it must not ask anybody for anything.
        if (broken) throw new CodedError("store_broken", storeBrokenMessage());
        if (!available()) throw new CodedError("macos_required", MACOS_REQUIRED);
        if (!input.sourceId) throw new Error(SOURCE_REQUIRED);
        // Resolved from the live list rather than trusted from the client: a source removed
        // in System Settings since Settings listed it must fail here, with its own words,
        // instead of connecting an account whose calendars would always come back empty.
        const source = (await liveSources(0)).find((entry) => entry.id === input.sourceId);
        if (!source) throw new CodedError("source_gone", SOURCE_GONE);
        const calendars = await fetchCalendars(input.sourceId);
        // Identified by its source, never by its title: macOS reports titles like the bare word
        // "Exchange", so two different accounts collide on it and the second would silently
        // overwrite the first.
        const index = stored.accounts.findIndex((entry) => entry.sourceId === input.sourceId);
        const account = mergeAccount(index >= 0 ? stored.accounts[index] : undefined, {
          sourceId: source.id,
          title: source.title,
          kind: source.kind,
          calendars,
        });
        // Replaced in place: stored order decides which copy of a merged meeting survives, so a
        // reconnect must not move the row to the end.
        if (index >= 0) stored.accounts[index] = account;
        else stored.accounts.push(account);
        await persist(stored);
        return { error: "", code: "" };
      } catch (error) {
        return { error: messageOf(error), code: errorCodeOf(error) };
      }
    });
  }

  const api: Sync = {
    async start() {
      stopped = false;
      // What macOS already thinks, asked without raising anything, so the screen can skip the
      // permission step on a Mac that has granted it and offer it on one that has not. Not
      // awaited: a first board should not wait on a helper spawn to draw.
      if (available()) {
        void (deps.accessStatus ?? eventkitStatus)()
          .then((status) => {
            // Never downgrade a live answer: a request that finished while this was in flight
            // knows more than a status read that started before it.
            if (access === "unknown") access = status;
          })
          .catch(() => {});
      }
      timer ??= setInterval(() => {
        void this.refresh().catch((error) => deps.log(`calendar: tick failed: ${String(error)}`));
      }, TICK_MS);
      await this.refresh();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stopped = true;
    },
    refresh() {
      // A browse's cached ranges are dropped here, not aged out: refresh is the explicit
      // "show me the truth now" gesture, and a month view still showing a minute-old copy
      // after it would be the one place this cache could actually mislead.
      ranges.clear();
      running ??= serialized(tick).finally(() => {
        running = null;
      });
      return running;
    },
    snapshot() {
      return last;
    },
    async settings() {
      // Read directly, not through load(): this runs outside the queue, so it must not move
      // lastText or broken.
      const read = await deps.read();
      const stored = read.stored;
      // Only once access is granted: never raise the macOS dialog from a settings read, and the
      // helper's `sources` itself calls requestAccess(). A failed list finds nothing, and says so.
      let foundFailed = false;
      const live =
        access === "granted" && available()
          ? await liveSources(SOURCES_TTL_MS, "read").catch(() => {
              foundFailed = true;
              return null;
            })
          : null;
      const connectedIds = new Set(stored.accounts.map((account) => account.sourceId));
      // A source a row matched is not also listed to add: one tap on "Add" for the moved
      // Exchange would make a second row with every calendar shown, Birthdays included.
      const { offers, matched } = live
        ? await relinkOffers(stored.accounts, live, connectedIds)
        : { offers: stored.accounts.map(() => null), matched: new Set<string>() };
      return {
        accounts: stored.accounts.map((account, index) => ({
          id: account.id,
          sourceId: account.sourceId,
          title: account.title,
          owner: account.owner,
          kind: account.kind,
          calendars: account.calendars,
          // Live even when the tick that read it had nothing worth writing.
          lastSyncAt: readAt.get(account.id) ?? account.lastSyncAt,
          lastError: account.lastError,
          errorCode: account.errorCode,
          missingSince: account.missingSince,
          relinkTo: offers[index] ?? null,
        })),
        pillLeadMinutes: stored.pillLeadMinutes,
        defaultView: stored.defaultView,
        access,
        connect: job,
        found: live ? live.filter((entry) => !connectedIds.has(entry.id) && !matched.has(entry.id)) : [],
        foundFailed,
        storeBroken: read.broken,
        storeAside: read.broken ? read.aside : "",
        accessError,
      };
    },
    async range(from, to) {
      // A delete ends by starting a refresh it does not wait for, a connect's runs after its RPC
      // has answered, and an edit or a create stops waiting for theirs at the post-write cap; a
      // read right after any of them must not see the state it replaced.
      // A failed refresh leaves `last` as it was, which the freshness bound below still judges.
      if (running) await running.catch(() => undefined);
      // Fresh by the same bound a schedule reports `stale` by: a snapshot that stopped updating
      // is not trusted, and the providers are asked instead.
      const syncedMs = Date.parse(last.syncedAt);
      if (held && !Number.isNaN(syncedMs) && now() - syncedMs <= STALE_AFTER_MS && coveredBy(held, from, to)) {
        return sliceView(last, from, to);
      }
      const key = `${from.toISOString()}|${to.toISOString()}`;
      const hit = ranges.get(key);
      if (hit && now() - hit.at < RANGE_TTL_MS) return hit.view;
      const fresh = await fetchRange(from, to);
      ranges.set(key, { at: now(), view: fresh });
      // Bounded so a long session of paging through a year cannot grow without limit. The
      // oldest insertion goes, which for back-and-forth browsing is the one least likely to
      // be wanted next.
      if (ranges.size > MAX_CACHED_RANGES) {
        const oldest = ranges.keys().next().value;
        if (oldest !== undefined) ranges.delete(oldest);
      }
      return fresh;
    },

    async requestAccess() {
      if (!available()) {
        access = "denied";
        return { access };
      }
      // Already on screen: asking again would stack a second dialog behind the first.
      if (access === "asking") return { access };
      access = "asking";
      accessError = "";
      void (async () => {
        try {
          access = (await (deps.askAccess ?? eventkitAccess)()) ? "granted" : "denied";
        } catch (error) {
          // The helper could not ask: not built (no Xcode Command Line Tools), not launched, or
          // out of time with the dialog still up. None of that is a refusal, so the button stays
          // and Settings shows why instead of sending anybody to Privacy & Security.
          deps.log(`calendar: access request failed: ${String(error)}`);
          access = "unknown";
          accessError = messageOf(error);
        }
      })();
      return { access };
    },

    async connect(input) {
      if (job?.state === "running") return { started: false, error: CONNECT_BUSY };
      job = { sourceId: input.sourceId, state: "running", error: "", code: "" };
      // Deliberately not awaited. runConnect still goes through serialized(), so it keeps its
      // turn behind the tick and every other mutation; what changes is only that the caller
      // is no longer holding an RPC open while it waits its turn and reads the source.
      void runConnect(input).then(
        async ({ error, code }) => {
          // Done only once the board's snapshot has the new row's meetings, so the screen that
          // sees "done" and reads the board again finds them there. The account is on disk
          // already, so a refresh that fails or runs long does not make this a failed connect.
          if (!error) await settle("connect");
          job = { sourceId: input.sourceId, state: error ? "failed" : "done", error, code };
        },
        (thrown) => {
          const error = messageOf(thrown);
          deps.log(`calendar: connect failed: ${error}`);
          job = { sourceId: input.sourceId, state: "failed", error, code: errorCodeOf(thrown) };
        },
      );
      return { started: true, error: "" };
    },

    async update(input) {
      const result = await serialized(async () => {
        try {
          const stored = await load();
          const account = stored.accounts.find((entry) => entry.id === input.accountId);
          if (!account) throw new Error(ACCOUNT_GONE);
          // The server's own guard, independent of the button the client chose to draw. The
          // snapshot is what it has to go on, and an event it cannot find is refused rather
          // than written to blind.
          const known = events.find((event) => event.accountId === input.accountId && event.id === input.eventId);
          if (!known) throw new Error(EVENT_GONE);
          if (known.recurring) throw new Error(SERIES_NOT_EDITED);
          if (known.allDay) throw new Error(ALL_DAY_NOT_EDITED);

          await applyUpdate(account, stored, { ...input });
          return { error: "" };
        } catch (error) {
          return { error: messageOf(error) };
        }
      });
      // Outside the task, for setCalendars' reason, and waited for so the answer already has the
      // change in the snapshot: the board and the composer pill both read it again the moment
      // this answers, and a change the user just made is exactly the moment they will look. A
      // failed or slow refresh only means the next tick reads it, and must not report a meeting
      // that has already moved as one that did not (settle()).
      if (!result.error) await settle("update");
      return result;
    },

    async remove(input) {
      return serialized(async () => {
        try {
          const stored = await load();
          const account = stored.accounts.find((entry) => entry.id === input.accountId);
          if (!account) throw new Error(ACCOUNT_GONE);
          // The same guards as update, and for a sharper reason: there is nothing to correct
          // after deleting the wrong thing.
          const known = events.find((event) => event.accountId === input.accountId && event.id === input.eventId);
          if (!known) throw new Error(EVENT_GONE);
          if (known.recurring) throw new Error(SERIES_NOT_DELETED);

          await applyRemove(account, stored, input);
          // Dropped from the snapshot at once rather than waiting for the refetch: the board
          // is the thing somebody is looking at, and a meeting that is still listed after
          // being deleted reads as a delete that failed. Every copy merged into its row goes,
          // not only the one deleted: the board drew them as one row, so another account's copy
          // left in memory would surface as that row, and the delete would look as if it had
          // failed. A copy that really remains comes back with the refresh started below. The same
          // account's other meeting under the same title and time stays: it was a row of its own.
          const row = new Set(copiesMergedWith(events, known));
          events = events.filter((event) => !row.has(event));
          last = view(stored);
          void api.refresh().catch((error) => deps.log(`calendar: refresh after delete failed: ${String(error)}`));
          return { error: "" };
        } catch (error) {
          return { error: messageOf(error) };
        }
      });
    },

    async setPillLead(minutes) {
      return serialized(async () => {
        const stored = await load();
        stored.pillLeadMinutes = minutes;
        await persist(stored);
        return api.settings();
      });
    },

    async setDefaultView(view) {
      return serialized(async () => {
        const stored = await load();
        stored.defaultView = view;
        await persist(stored);
        return api.settings();
      });
    },

    async disconnect(accountId) {
      return serialized(async () => {
        const stored = await load();
        stored.accounts = stored.accounts.filter((account) => account.id !== accountId);
        // Refused while broken, and then the board is left alone too: an account that is
        // still on disk must not vanish from the screen as if the disconnect had happened.
        if (!(await persist(stored))) return false;
        readAt.delete(accountId);
        // A month browsed in the last minute still holds this account's meetings and errors.
        ranges.clear();
        events = events.filter((event) => event.accountId !== accountId);
        // Scrub the removed account's own errors too: view() reads this closure variable
        // as-is, so without this a stale entry would sit in snapshot().errors for up to
        // TICK_MS, pointing at an account that no longer exists.
        errors = errors.filter((entry) => entry.accountId !== accountId);
        // Recomputed here rather than via refresh(): every event this needs is already in
        // memory, and a disconnect only removes rows — a fresh read through the helper would buy
        // nothing a caller couldn't already see from what's left of `events`.
        last = view(stored);
        return true;
      });
    },
    async relink(accountId, sourceId) {
      try {
        // The offer settings() showed is never trusted: the source and its calendars are read
        // afresh here, the same rules are applied to them, and every refusal returns before
        // anything is written. A wrong relink would show another account's meetings under this
        // row with nothing on screen to say so.
        const refused = await serialized(async (): Promise<string> => {
          const stored = await load();
          // Thrown, as connect throws it, although relink's answer has no field for its code: the
          // catch below turns it into the same { error, settings: null } as any other refusal.
          if (broken) throw new CodedError("store_broken", storeBrokenMessage());
          if (!available()) return MACOS_REQUIRED;
          const account = stored.accounts.find((entry) => entry.id === accountId);
          if (!account) return ACCOUNT_GONE;
          // Fresh, never the settings cache: the source may have gone or been renamed since.
          const live = await liveSources(0);
          // Already done: a second tap, or a retry after an answer that was lost, finds the row on
          // the very source it asks for. Refusing would say a relink that worked had failed.
          if (account.sourceId === sourceId && live.some((entry) => entry.id === sourceId)) return "";
          const connected = new Set(stored.accounts.map((entry) => entry.sourceId));
          if (relinkSuspect(account, live, connected)?.id !== sourceId) return RELINK_REFUSED;
          if (claimedByAnother(stored.accounts, accountId, sourceId, live, connected)) return RELINK_REFUSED;
          // Uncached too, unlike the offer: these names decide what is written.
          const calendars = await fetchCalendars(sourceId);
          const target = relinkCandidate(account, live, connected, calendars.map((calendar) => calendar.name));
          if (!target || target.id !== sourceId) return RELINK_REFUSED;
          // Same row, same id: the board's event keys and every hidden choice survive the move.
          account.sourceId = target.id;
          account.calendars = carryShown(account.calendars, calendars);
          account.title = target.title;
          account.kind = target.kind;
          // The old mailbox's address would stay on the row for good: the tick learns an owner
          // only while there is none. Emptied, the refresh below learns it from the new source's
          // own self attendee, and the row, the card and ChatGPT's targets name the right mailbox.
          account.owner = "";
          account.missingSince = "";
          account.errorCode = "";
          account.lastError = "";
          await persist(stored);
          return "";
        });
        if (refused) return { error: refused, settings: null };
        // Outside the task, for setCalendars' reason. Waited for so the answer already shows the
        // moved row's meetings and its learned owner; a failure only means the next tick reads
        // them, and must not report a relink that is already on disk as one that failed.
        await settle("relink");
        return { error: "", settings: await api.settings() };
      } catch (error) {
        return { error: messageOf(error), settings: null };
      }
    },
    async setCalendars(accountId, shown) {
      // The write is inside serialized() and the refresh is not: refresh() joins the same
      // queue, and awaiting it from inside this task would wait on its own turn to end
      // before its turn can end (see the note on serialized() above).
      const found = await serialized(async () => {
        const stored = await load();
        const account = stored.accounts.find((entry) => entry.id === accountId);
        if (!account) return false;
        account.calendars = account.calendars.map((calendar) => ({
          ...calendar,
          shown: shown[calendar.id] ?? calendar.shown,
        }));
        // False only when a broken store refused the write: nothing changed, so no refresh.
        return await persist(stored);
      });
      if (found) await settle("a calendar toggle");
      return this.settings();
    },
    async create(input) {
      const result = await serialized(async () => {
        const stored = await load();
        const account = stored.accounts.find((entry) => entry.id === input.accountId);
        if (!account) return { event: null, error: "no such account" };
        if (readOnlyKind(account.kind)) return { event: null, error: READ_ONLY_ACCOUNT };
        try {
          const created = await createEvent(account, stored, input);
          return { event: created, error: "" };
        } catch (error) {
          return { event: null, error: messageOf(error) };
        }
      });
      // As in update(): outside the task, and waited for so the new meeting is in the snapshot by
      // the time the board and the pill read it again. The event this call already created must
      // not be reported as a failure because the refresh afterwards failed or ran long.
      if (!result.error) await settle("create");
      return result;
    },
  };

  return api;
}
