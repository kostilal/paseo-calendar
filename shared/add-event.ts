import { readOnlyKind } from "./accounts.ts";
import type { AccountView, AddEventInput, EventView } from "./calendar.ts";
import { copiesOf, isCancelledTitle } from "./meeting.ts";
import { dayOf, localDate, localTime, offsetMs } from "./schedule.ts";

/**
 * The rules for adding one event on ChatGPT's word, ported from an earlier Apple Calendar plugin
 * for God Mode: which calendar a name means, when the event is, whether it is already there and
 * what it collides with. Pure, so every refusal is tested without a calendar, a Mac or a clock.
 *
 * Each rule leans toward refusing. A wrong calendar puts a private appointment in a shared
 * mailbox, a guessed hour across a clock change is an hour off, and a missed copy is a second
 * one in somebody's calendar; each is cheaper to ask again about than to undo.
 */

/** One calendar an event could be addressed to, and why it may not be, if it may not. */
export interface Target {
  accountId: string;
  calendarId: string;
  calendarName: string;
  accountTitle: string;
  owner: string;
  /**
   * "" when an event may be added. Hidden: the board would not show what was added. Gone: the
   * account is not on this Mac, so there is nothing to write to. Read only: a subscribed or
   * birthdays source, which EventKit never lets anyone add to.
   */
  blocked: "" | "hidden" | "gone" | "read_only";
}

export interface PlannedEvent {
  title: string;
  /** YYYY-MM-DD in the zone it was planned in. */
  date: string;
  startMs: number;
  endMs: number;
}

/** Compared as people type names: case, and spacing, do not matter. */
function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function targetsOf(accounts: AccountView[]): Target[] {
  return accounts.flatMap((account) =>
    account.calendars.map((calendar) => ({
      accountId: account.id,
      calendarId: calendar.id,
      calendarName: calendar.name,
      accountTitle: account.title,
      owner: account.owner,
      blocked:
        account.errorCode === "source_gone"
          ? ("gone" as const)
          : readOnlyKind(account.kind)
            ? ("read_only" as const)
            : !calendar.shown
              ? ("hidden" as const)
              : ("" as const),
    })),
  );
}

/** "Exchange/Calendar (me@example.com)": the account's title alone does not tell two Exchanges apart. */
export function targetLabel(target: Target): string {
  return `${target.accountTitle}/${target.calendarName}${target.owner ? ` (${target.owner})` : ""}`;
}

/**
 * Most specific first: an owner address names one mailbox, "Account/Calendar" one calendar in
 * it, a calendar's own name may be shared ("Calendar" is in every account), and an account's
 * title names all of its calendars at once. Exact matches only, never a substring, so "Google"
 * cannot quietly mean some other account whose name contains it.
 */
const TIERS: ((target: Target, q: string) => boolean)[] = [
  (target, q) => target.owner !== "" && norm(target.owner) === q,
  (target, q) =>
    norm(`${target.accountTitle}/${target.calendarName}`) === q ||
    (target.owner !== "" && norm(`${target.owner}/${target.calendarName}`) === q),
  (target, q) => norm(target.calendarName) === q,
  (target, q) => norm(target.accountTitle) === q,
];

/** The hits of the first tier that has any, or none. */
function firstHits(targets: Target[], q: string): Target[] {
  for (const tier of TIERS) {
    const hits = targets.filter((target) => tier(target, q));
    if (hits.length) return hits;
  }
  return [];
}

/**
 * Exactly one calendar an event may be added to, or why not. Two equally good matches are a
 * question back, never a pick; a name that only matches a calendar that may not be added to
 * says which of the three reasons it is, so the fix can be named.
 */
export function resolveTarget(targets: Target[], query: string): Target | { error: string } {
  const asked = query.trim();
  const q = norm(asked);
  if (!q) return { error: "calendar is required: name the exact calendar or account (see the calendars read)" };

  const open = targets.filter((target) => target.blocked === "");
  const hits = firstHits(open, q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    return { error: `"${asked}" matches several calendars: ${hits.map(targetLabel).join("; ")}. Name one of them exactly.` };
  }

  const [blocked] = firstHits(
    targets.filter((target) => target.blocked !== ""),
    q,
  );
  switch (blocked?.blocked) {
    case "hidden":
      return { error: `"${asked}" is switched off in Paseo's Calendar settings; switch it on there to add events to it.` };
    case "read_only":
      return { error: `"${asked}" is read-only in Apple Calendar; events cannot be added to it.` };
    case "gone":
      return {
        error: `"${asked}" is not on this Mac right now (its account is missing from Internet Accounts); nothing was added.`,
      };
  }
  const choices = open.length ? open.map(targetLabel).join("; ") : "none";
  return { error: `no calendar you can add to is called "${asked}". Calendars you can add to: ${choices}.` };
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a wall clock names in the zone, ported from that plugin's wallTimeToInstant.
 *
 * The zone's offset differs either side of a clock change, so every offset seen within half a day
 * is tried and only instants that read back as the asked wall clock are kept: none means the
 * clocks skipped it, two means it happened twice — refused rather than guessed, as it did.
 */
export function wallClockInstant(date: string, time: string, zone: string): number | { error: string } {
  const match = TIME.exec(time.trim());
  if (!match) return { error: `bad time "${time}": use HH:MM, 24-hour` };
  const [year, month, day] = date.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
  const wanted = `${match[1].padStart(2, "0")}:${match[2]}`;
  const hits = new Set<number>();
  for (const hours of [-12, 0, 12]) {
    const at = naive - offsetMs(naive + hours * 3_600_000, zone);
    if (localDate(at, zone) === date && localTime(at, zone) === wanted) hits.add(at);
  }
  if (hits.size === 0) return { error: `${date} ${wanted} does not exist in ${zone} (clocks jump forward); pick another time` };
  if (hits.size > 1) return { error: `${date} ${wanted} happens twice in ${zone} (clocks go back); pick another time` };
  return [...hits][0];
}

/** Five minutes' grace: "now" said aloud has reached the past by the time it arrives. */
const PAST_GRACE_MS = 5 * 60_000;

export function planEvent(
  input: Pick<AddEventInput, "title" | "date" | "start_time" | "duration_minutes">,
  nowMs: number,
  zone: string,
): PlannedEvent | { error: string } {
  const title = input.title.trim();
  if (!title) return { error: "title is required" };
  // The board leaves such a title off as a meeting Outlook cancelled, so the read-back and every
  // later duplicate check could not see it, and a retry would add a second one.
  if (isCancelledTitle(title)) {
    return { error: `"${title}" starts like a cancelled meeting ("Cancelled:"), which the board hides; reword the title` };
  }
  const date = dayOf(input.date, localDate(nowMs, zone));
  if (date === null) {
    return { error: `cannot understand date "${input.date}"; use YYYY-MM-DD, today, tomorrow, yesterday or a weekday name` };
  }
  const startMs = wallClockInstant(date, input.start_time, zone);
  if (typeof startMs !== "number") return startMs;
  if (startMs < nowMs - PAST_GRACE_MS) return { error: `${date} ${input.start_time.trim()} ${zone} is in the past` };
  return { title, date, startMs, endMs: startMs + input.duration_minutes * 60_000 };
}

/**
 * The planned event is already in the target calendar: same title, same instants, and one of the
 * row's copies is that very calendar. By account and calendar id only, never by calendar name, so
 * the target's copy is found even when the row kept another account's, and another account's
 * "Calendar" is never taken for the target's.
 */
export function isSameAdded(event: EventView, target: Target, plan: PlannedEvent): boolean {
  return (
    !event.allDay &&
    norm(event.title) === norm(plan.title) &&
    Date.parse(event.start) === plan.startMs &&
    Date.parse(event.end) === plan.endMs &&
    copiesOf(event).some((copy) => copy.accountId === target.accountId && copy.calendarId === target.calendarId)
  );
}

/**
 * What the planned event would collide with, earliest first. All-day events, meetings the user
 * declined and ones Outlook kept after their cancellation do not take the time, as on the board.
 */
export function overlapsOf(events: EventView[], plan: PlannedEvent): EventView[] {
  return events
    .filter(
      (event) =>
        !event.allDay &&
        event.myResponse !== "declined" &&
        !isCancelledTitle(event.title) &&
        Date.parse(event.start) < plan.endMs &&
        Date.parse(event.end) > plan.startMs,
    )
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}
