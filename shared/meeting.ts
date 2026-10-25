import { accountLabel } from "./accounts.ts";
import type { Event } from "./event.ts";

/**
 * Which rows are the same meeting. One rule for the board, clashes, the pill and the schedule,
 * so none of them can count a meeting the others merged.
 *
 * The same meeting reaches this Mac through every account invited to it (an Exchange mailbox and
 * the Google one it forwards to, say), each copy under its own id; what the copies share is the
 * title and the times. The title is compared trimmed, lower-cased and with its spacing collapsed,
 * because two servers do not always agree on either. A timed event compares instants rather than
 * strings, so "10:00:00Z" and "10:00:00.000Z" are one time; the raw strings stand in only when
 * one of them is not a time at all. An all-day event compares its bare dates (shared/event.ts)
 * and is tagged apart, so it never matches a timed event that starts at midnight.
 */
export function sameMeetingKey(event: Pick<Event, "title" | "start" | "end" | "allDay">): string {
  const title = event.title.trim().toLowerCase().replace(/\s+/g, " ");
  if (event.allDay) return `day|${title}|${event.start}|${event.end}`;
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return Number.isNaN(start) || Number.isNaN(end)
    ? `time|${title}|${event.start}|${event.end}`
    : `time|${title}|${start}|${end}`;
}

/**
 * Exchange keeps a meeting its organiser cancelled on the attendee's calendar, retitled, until
 * somebody removes it, and EventKit hands it over like any other, so the title is the only signal
 * this side has. The prefixes are the ones Outlook writes in the languages this calendar actually
 * meets.
 */
const CANCELLED = /^\s*(canceled|cancelled|отменено|отменена|скасовано|anulowane|anulowano|odwołane|abgesagt)\s*[:：]/i;

export function isCancelledTitle(title: string): boolean {
  return CANCELLED.test(title);
}

/** One account's copy of a meeting, as the card and the add-event check name it. */
export interface MeetingCopy {
  accountId: string;
  calendarId: string;
  calendarName: string;
}

/** A row as mergeMeetings leaves it: its own copy's fields, and every other copy merged into it. */
export type MeetingRow = MeetingCopy & { alsoIn: readonly MeetingCopy[] };

/**
 * Which events are drawn as one row, as groups of indices into `events`.
 *
 * Copies of one meeting are only ever looked for across accounts. Within one account two events
 * with one key are two meetings — two invitations to an interview at 10:00 — and merging them
 * would hide a double booking. So each account's same-key events are lined up by id, and the
 * n-th of every account is one row: one copy per account, and an account's second interview is
 * a row of its own, which still collides with its first. Lining up by id rather than by arrival
 * keeps a row's members, and with them its kept copy, the same from one tick to the next.
 */
function rowsOf(events: readonly Event[]): number[][] {
  const byKey = new Map<string, Map<string, number[]>>();
  events.forEach((event, index) => {
    const key = sameMeetingKey(event);
    let accounts = byKey.get(key);
    if (!accounts) byKey.set(key, (accounts = new Map()));
    const own = accounts.get(event.accountId);
    if (own) own.push(index);
    else accounts.set(event.accountId, [index]);
  });
  const rows: number[][] = [];
  for (const accounts of byKey.values()) {
    const lines = [...accounts.values()].map((line) =>
      [...line].sort((left, right) => compareIds(events[left].id, events[right].id) || left - right),
    );
    const depth = Math.max(...lines.map((line) => line.length));
    for (let slot = 0; slot < depth; slot += 1) {
      rows.push(
        lines
          .filter((line) => slot < line.length)
          .map((line) => line[slot])
          .sort((left, right) => left - right),
      );
    }
  }
  return rows;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyOf(event: MeetingCopy): MeetingCopy {
  return { accountId: event.accountId, calendarId: event.calendarId, calendarName: event.calendarName };
}

/**
 * One row per meeting: the copies of one meeting reached through different accounts (rowsOf)
 * become the copy from the account listed first in `accountOrder`, with every other copy in
 * `alsoIn`.
 *
 * An account missing from the order ranks after every listed one, and a tie goes to the smaller
 * id, so which copy is kept — and with it the row's eventKey and where the pill's focus lands —
 * depends on the accounts and the ids alone, never on the order the copies happened to arrive in.
 * The kept copies come back in their input order. `alsoIn` names each other copy by account and
 * calendar, in input order: a row holds one copy per account, so no entry repeats another or the
 * kept copy's own, and two accounts' calendars that are both called "Calendar" stay two entries.
 */
export function mergeMeetings<T extends Event>(events: T[], accountOrder: string[]): (T & { alsoIn: MeetingCopy[] })[] {
  const rankOf = new Map<string, number>();
  accountOrder.forEach((id, index) => {
    if (!rankOf.has(id)) rankOf.set(id, index);
  });
  const rank = (event: T) => rankOf.get(event.accountId) ?? Infinity;

  const alsoInOf = new Map<number, MeetingCopy[]>();
  for (const row of rowsOf(events)) {
    let kept = row[0];
    for (const index of row.slice(1)) {
      const candidate = events[index];
      const best = events[kept];
      if (rank(candidate) < rank(best) || (rank(candidate) === rank(best) && candidate.id < best.id)) kept = index;
    }
    alsoInOf.set(
      kept,
      row.filter((index) => index !== kept).map((index) => copyOf(events[index])),
    );
  }

  const merged: (T & { alsoIn: MeetingCopy[] })[] = [];
  events.forEach((event, index) => {
    const alsoIn = alsoInOf.get(index);
    if (alsoIn) merged.push({ ...event, alsoIn });
  });
  return merged;
}

/**
 * The event `target` names and every other account's copy drawn in its row, by the same rule
 * mergeMeetings uses; empty when `target` is not in `events`. For dropping a deleted meeting from
 * memory: all of its copies, and not an account's other meeting that merely shares its key.
 */
export function copiesMergedWith<T extends Event>(events: readonly T[], target: { accountId: string; id: string }): T[] {
  const at = events.findIndex((event) => event.accountId === target.accountId && event.id === target.id);
  if (at < 0) return [];
  const row = rowsOf(events).find((indices) => indices.includes(at)) ?? [at];
  return row.map((index) => events[index]);
}

/** Every copy a row was found in, the kept copy first. */
export function copiesOf(event: MeetingRow): MeetingCopy[] {
  return [copyOf(event), ...event.alsoIn.map(copyOf)];
}

/** The calendar of every copy, kept copy first; a name two accounts share appears twice. */
export function calendarNamesOf(event: MeetingRow): string[] {
  return copiesOf(event).map((copy) => copy.calendarName);
}

/**
 * What the card shows for each copy: "<calendar> · <account>", because the calendar name alone
 * is no help when every Exchange mailbox calls its default calendar "Calendar". An account the
 * client does not know (Settings not read yet, or the row just disconnected) shows the calendar
 * alone rather than a guess.
 */
export function copyLabelsOf(
  event: MeetingRow,
  accounts: readonly { id: string; owner: string; title: string }[],
): string[] {
  return copiesOf(event).map((copy) => {
    const account = accounts.find((entry) => entry.id === copy.accountId);
    return account ? `${copy.calendarName} · ${accountLabel(account)}` : copy.calendarName;
  });
}
