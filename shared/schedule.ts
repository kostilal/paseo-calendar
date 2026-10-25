import { accountLabel } from "./accounts.ts";
import type { ErrorCode, EventsView, EventView, ScheduleEvent, ScheduleSource, ScheduleView } from "./calendar.ts";
import { copiesOf, isCancelledTitle } from "./meeting.ts";
import { clashes } from "./overlap.ts";

/**
 * The schedule as somebody asks for it out loud: one day or a short period of the board's rows,
 * in the asked zone. Pure, so every rule below — the zone, what is left out, who could not be
 * read — is tested without a calendar, a Mac or a clock. Which copies are one meeting and which
 * meetings collide are the board's rules (shared/meeting.ts, shared/overlap.ts), not this file's,
 * so a meeting the board shows twice is read out twice and one it shows once is read out once.
 *
 * It carries less than the board does on purpose. A schedule read aloud needs a title, a time
 * and where it came from; a description, a location and the guest list are other people's
 * words that the listener did not ask for, so they never leave the daemon through here.
 */

/** A month is the most anyone reads aloud; more is a browse, which the board is for. */
export const MAX_PERIOD_DAYS = 31;
/** Two ticks and a minute: one missed tick is noise, two is a calendar that stopped updating. */
export const STALE_AFTER_MS = 11 * 60_000;
/** The summary is what a voice reads first; God Mode cuts a read's text at 1,500 characters. */
const SUMMARY_MAX = 1_200;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Text put into a line ChatGPT reads, on one line. A title is written by whoever sent the
 * invitation, and an ICS summary can carry an escaped line break: left alone, "Standup\nAll
 * calendars read." would forge a line of its own in the summary.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
export function offsetMs(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The zone's calendar date at this instant, YYYY-MM-DD. */
export function localDate(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

export function localTime(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(ms),
  );
}

/**
 * The instant a date's midnight happens in the zone. Asked twice because the offset at the
 * UTC guess can differ from the offset at the answer on a day the clocks change.
 */
export function zonedMidnight(date: string, zone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetMs(guess, zone);
  return guess - offsetMs(first, zone);
}

export function addDays(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

function realDate(text: string): boolean {
  return DATE.test(text) && addDays(text, 0) === text;
}

const RELATIVE: Record<string, number> = {
  today: 0,
  tomorrow: 1,
  yesterday: -1,
  сегодня: 0,
  завтра: 1,
  вчера: -1,
  // The earlier Apple Calendar plugin's extra words, kept so nothing ChatGPT learned to say there
  // stops working here.
  послезавтра: 2,
  dzisiaj: 0,
  dziś: 0,
  jutro: 1,
  wczoraj: -1,
  pojutrze: 2,
};

/** Indexed as getUTCDay() counts, Sunday first. */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface ScheduleWindow {
  /** First day, YYYY-MM-DD in the zone. */
  from: string;
  /** Last day, inclusive. */
  to: string;
  startMs: number;
  /** The midnight after the last day. */
  endMs: number;
}

/**
 * A day as somebody names it, against `today` (YYYY-MM-DD in the zone): empty is today, a word
 * is relative to it, and a weekday name is its next occurrence with today included, so "sunday"
 * said on a Sunday is today — what someone means when they plan the rest of their day.
 */
export function dayOf(text: string, today: string): string | null {
  const word = text.trim().toLowerCase();
  if (word === "") return today;
  // Own keys only: `in` also finds "constructor" on the prototype, and addDays(today, undefined) throws.
  if (Object.hasOwn(RELATIVE, word)) return addDays(today, RELATIVE[word]);
  const wanted = WEEKDAYS.indexOf(word);
  if (wanted >= 0) {
    const current = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, (wanted - current + 7) % 7);
  }
  return realDate(word) ? word : null;
}

/**
 * One day (`date`) or a period (`from` and `to`, both inclusive). An empty `date` is today in
 * the zone, not in UTC: at 00:30 in Warsaw UTC is still on yesterday.
 */
export function resolveWindow(
  input: { date?: string; from?: string; to?: string },
  nowMs: number,
  zone: string,
): ScheduleWindow | { error: string } {
  const today = localDate(nowMs, zone);
  const period = Boolean(input.from || input.to);
  const from = dayOf(period ? (input.from ?? "") : (input.date ?? ""), today);
  const to = period ? dayOf(input.to || input.from || "", today) : from;
  if (!from || !to) {
    return { error: `${period ? "from and to take" : "date takes"} YYYY-MM-DD, today, tomorrow, yesterday or a weekday name` };
  }
  if (from > to) return { error: `the period ends (${to}) before it starts (${from})` };
  if (addDays(from, MAX_PERIOD_DAYS - 1) < to) return { error: `a period is at most ${MAX_PERIOD_DAYS} days` };
  return { from, to, startMs: zonedMidnight(from, zone), endMs: zonedMidnight(addDays(to, 1), zone) };
}

export interface ScheduleAccount {
  id: string;
  sourceId: string;
  title: string;
  owner: string;
  kind: string;
  errorCode: ErrorCode;
  missingSince: string;
  /** Some calendar of it is shown. One with every calendar hidden is never read, and so never fails. */
  readable: boolean;
}

interface Item {
  event: EventView;
  startMs: number;
  endMs: number;
  /** The day it is listed under, clipped to the window. */
  day: string;
  calendars: string[];
  conflicts: string[];
}

function sourceName(account: ScheduleAccount | undefined): string {
  return account ? accountLabel(account) : "unknown account";
}

/**
 * Short, and for every failure a person can fix, an instruction instead of a message. Decided by
 * the code sync gave the failure, never by the message's English, which the helper may reword.
 */
export function failureNote(code: ErrorCode, message: string, since: string): string {
  switch (code) {
    case "source_gone":
      return `not found on this Mac${since ? ` since ${since}` : ""}: add it back in System Settings → Internet Accounts with Calendars on, or re-link it on Paseo's Calendar settings screen`;
    case "access_needed":
      return "macOS calendar access is not granted to the Calendar helper: allow it on Paseo's Calendar settings screen";
    case "macos_required":
      return "Apple Calendar can only be read on a Mac";
    case "store_broken":
      return "the Calendar plugin's settings file could not be read in full: some calendars may be missing, and nothing is saved until it is fixed";
    default: {
      const line = oneLine(message);
      return line.length > 140 ? `${line.slice(0, 139)}…` : line;
    }
  }
}

interface Failure {
  code: ErrorCode;
  message: string;
}

/**
 * The account's entry in the view's errors. Sync lists a vanished account there only while one of
 * its calendars is shown, so for a readable account the errors are the whole answer; an account
 * with every calendar hidden falls back on its own source_gone, because it is still not read.
 */
function failureOf(account: ScheduleAccount, errors: ReadonlyMap<string, Failure>): Failure | undefined {
  const listed = errors.get(account.id);
  if (listed) return listed;
  return !account.readable && account.errorCode === "source_gone" ? { code: "source_gone", message: "" } : undefined;
}

/**
 * Two rows that read one mailbox: one macOS source, or one owner address. Never the title, which
 * says only what kind of account it is: every Exchange account is called "Exchange".
 */
export function sameMailbox(
  left: Pick<ScheduleAccount, "id" | "sourceId" | "owner">,
  right: Pick<ScheduleAccount, "id" | "sourceId" | "owner">,
): boolean {
  return (
    left.id !== right.id &&
    ((left.sourceId !== "" && left.sourceId === right.sourceId) ||
      (left.owner !== "" && left.owner.toLowerCase() === right.owner.toLowerCase()))
  );
}

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000);
  return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h${total % 60 ? ` ${total % 60} min` : ""}`;
}

function weekday(date: string): string {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00.000Z`));
  return `${name} ${date}`;
}

export function buildSchedule(params: {
  view: EventsView;
  accounts: ScheduleAccount[];
  window: ScheduleWindow;
  zone: string;
  nowMs: number;
  withLinks: boolean;
  includeDeclined: boolean;
}): ScheduleView {
  const { view, window, zone, nowMs } = params;
  const accounts = new Map(params.accounts.map((account) => [account.id, account] as const));
  const hidden = { declined: 0, duplicates: 0 };

  // The view's events are the board's rows: viewOf merged each meeting's copies across accounts
  // (mergeMeetings) before range() handed them over. Merging again here would join a merged row
  // to a same-titled twin its own account holds at the same time, and lose the twin.
  const items: Item[] = [];
  for (const event of view.events) {
    let startMs: number;
    let endMs: number;
    let day: string;
    if (event.allDay) {
      // Bare dates with an exclusive end (shared/event.ts): compared as dates, never as
      // instants, so an all-day event cannot slide into the neighbouring day by a zone.
      if (!(event.start <= window.to && event.end > window.from)) continue;
      startMs = zonedMidnight(event.start, zone);
      endMs = zonedMidnight(event.end, zone);
      day = event.start < window.from ? window.from : event.start;
    } else {
      startMs = Date.parse(event.start);
      endMs = Date.parse(event.end);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
      if (!(startMs < window.endMs && endMs > window.startMs)) continue;
      const startDay = localDate(startMs, zone);
      day = startDay < window.from ? window.from : startDay;
    }
    // viewOf leaves these off the board already; checked again so no path into the schedule
    // can read a cancelled meeting out as one to attend. Not counted: viewOf dropped them before
    // this saw them, so a count would always be zero, and "0 cancelled" reads as "none was".
    if (isCancelledTitle(event.title)) continue;
    if (event.myResponse === "declined" && !params.includeDeclined) {
      hidden.declined += 1;
      continue;
    }
    // The copies folded into this row, each one a meeting the listener is not told twice.
    hidden.duplicates += event.alsoIn.length;
    items.push({
      event,
      startMs,
      endMs,
      day,
      // One entry per copy, each named by its own account: two accounts' calendars that are both
      // called "Calendar" are two entries, told apart by the account.
      calendars: copiesOf(event).map((copy) => `${copy.calendarName} (${sourceName(accounts.get(copy.accountId))})`),
      conflicts: [],
    });
  }

  items.sort((left, right) => {
    if (left.day !== right.day) return left.day.localeCompare(right.day);
    if (left.event.allDay !== right.event.allDay) return left.event.allDay ? -1 : 1;
    return left.startMs - right.startMs || left.event.title.localeCompare(right.event.title);
  });

  // The board's rule (shared/overlap.ts), over the listed rows in their listed order, so a tie
  // is named in the order it is read out.
  const conflicts: string[] = [];
  const itemOf = new Map<EventView, Item>(items.map((item) => [item.event, item] as const));
  const clock = (item: Item) => `${localTime(item.startMs, zone)}–${localTime(item.endMs, zone)}`;
  for (const clash of clashes(items.map((item) => item.event))) {
    const first = itemOf.get(clash.a);
    const second = itemOf.get(clash.b);
    if (!first || !second) continue;
    first.conflicts.push(second.event.title);
    second.conflicts.push(first.event.title);
    conflicts.push(
      `${first.day} ${clock(first)} ${oneLine(first.event.title)} × ${clock(second)} ${oneLine(second.event.title)} (${minutes(clash.overlapMs)})`,
    );
  }

  const events: ScheduleEvent[] = items.map((item) => {
    const event = item.event;
    const lastDay = event.allDay ? addDays(event.end, -1) : localDate(item.endMs - 1, zone);
    return {
      date: item.day,
      start: event.allDay ? "" : localTime(item.startMs, zone),
      end: event.allDay ? "" : localTime(item.endMs, zone),
      ...(event.allDay ? {} : localDate(item.startMs, zone) !== item.day ? { started: localDate(item.startMs, zone) } : {}),
      ...(lastDay > item.day ? { until: lastDay } : {}),
      all_day: event.allDay,
      title: event.title,
      calendar: item.calendars.join("; "),
      ...(event.joinKind !== "none" ? { join: event.joinKind } : {}),
      ...(params.withLinks && event.joinUrl ? { join_url: event.joinUrl } : {}),
      ...(event.myResponse === "tentative" || event.myResponse === "declined" ? { response: event.myResponse } : {}),
      ...(item.conflicts.length ? { conflicts_with: item.conflicts } : {}),
    };
  });

  const errors = new Map(view.errors.map((entry) => [entry.accountId, { code: entry.code, message: entry.message }] as const));
  // Read means read: no failure is not enough, since an account with every calendar hidden has none.
  const read = params.accounts.filter((account) => account.readable && failureOf(account, errors) === undefined);
  const sources: ScheduleSource[] = params.accounts.map((account) => {
    const failure = failureOf(account, errors);
    const base = {
      name: sourceName(account),
      kind: `Apple Calendar on this Mac${account.kind ? ` (${account.kind})` : ""}`,
      ok: failure === undefined,
    };
    if (!failure) return base;
    // Nothing is missing when the same mailbox came in through another account that was read.
    if (read.some((other) => sameMailbox(account, other))) {
      return { ...base, note: "the same mailbox is read through another account on this Mac", covered: true };
    }
    const missingMs = Date.parse(account.missingSince);
    const since = Number.isNaN(missingMs) ? "" : localDate(missingMs, zone);
    return { ...base, note: failureNote(failure.code, failure.message, since) };
  });
  // A failure of the plugin itself, such as its settings file, belongs to no account, and a
  // schedule that reads complete while some calendars may be missing is worse than none.
  const listed = new Set(params.accounts.map((account) => account.id));
  const problems = view.errors
    .filter((entry) => !listed.has(entry.accountId))
    .map((entry) => `Problem: ${failureNote(entry.code, entry.message, "")}.`);

  const syncedMs = Date.parse(view.syncedAt);
  const stale = Number.isNaN(syncedMs) || nowMs - syncedMs > STALE_AFTER_MS;
  const asOf = Number.isNaN(syncedMs) ? "" : `${localDate(syncedMs, zone)} ${localTime(syncedMs, zone)}`;

  return {
    summary: summarize({ window, zone, events, conflicts, sources, problems, hidden, stale, asOf }),
    time_zone: zone,
    from: window.from,
    to: window.to,
    as_of: asOf,
    stale,
    events,
    conflicts,
    sources,
    hidden,
    error: "",
  };
}

function summarize(parts: {
  window: ScheduleWindow;
  zone: string;
  events: ScheduleEvent[];
  conflicts: string[];
  sources: ScheduleSource[];
  problems: string[];
  hidden: ScheduleView["hidden"];
  stale: boolean;
  asOf: string;
}): string {
  const { window, events } = parts;
  const single = window.from === window.to;
  const lines: string[] = [];
  const span = single ? weekday(window.from) : `${window.from} to ${window.to}`;
  const count = events.length === 1 ? "1 event" : `${events.length} events`;
  lines.push(`${span}, ${parts.zone} time: ${events.length ? count : "nothing scheduled"}.`);

  let day = "";
  for (const event of events) {
    if (!single && event.date !== day) {
      day = event.date;
      lines.push(`${weekday(day)}:`);
    }
    const when = event.all_day
      ? `all day${event.until ? ` until ${event.until}` : ""}`
      : `${event.started ? `${event.started} ` : ""}${event.start}–${event.until ? `${event.until} ` : ""}${event.end}`;
    const extra = [
      event.join ? event.join : "",
      event.response ? event.response : "",
      event.conflicts_with ? "overlaps" : "",
    ].filter(Boolean);
    lines.push(`${when} ${oneLine(event.title)}${extra.length ? ` (${extra.join(", ")})` : ""}`);
  }
  for (const conflict of parts.conflicts) lines.push(`Overlap: ${conflict}`);

  // What could not be read, or may be old, is said even when the list itself has to be cut:
  // a short list that sounds complete is worse than a long one that says it is not.
  const down = parts.sources.filter((source) => !source.ok && !source.covered);
  const notesWith = (unread: string): string[] => {
    const notes: string[] = [];
    if (parts.hidden.declined) notes.push(`Left out: ${parts.hidden.declined} declined.`);
    if (unread) notes.push(unread);
    notes.push(...parts.problems);
    if (parts.sources.length === 0) notes.push("No calendar is connected in Paseo's Calendar plugin.");
    if (parts.stale) notes.push(`Data as of ${parts.asOf || "never"}: may be out of date.`);
    return notes;
  };
  const marker = "\n… the rest is in events.";
  // The first line, the day and how many events, is never given up for the notes: when every
  // unread account's own note does not fit beside it, they are counted instead, and `sources`
  // names each one.
  let tail = notesWith(down.length ? `Not read: ${down.map((source) => `${oneLine(source.name)} (${source.note})`).join("; ")}.` : "").join("\n");
  if (lines[0]!.length + marker.length + 1 + tail.length > SUMMARY_MAX) {
    tail = notesWith(`Not read: ${down.length} accounts (each is named in sources).`).join("\n");
  }

  const budget = SUMMARY_MAX - tail.length - 1;
  let body = lines.join("\n");
  if (body.length > budget) {
    const kept = [lines[0]!];
    let used = lines[0]!.length + marker.length;
    for (const line of lines.slice(1)) {
      if (used + 1 + line.length > budget) break;
      kept.push(line);
      used += 1 + line.length;
    }
    body = `${kept.join("\n")}${marker}`;
  }
  return tail ? `${body}\n${tail}` : body;
}
