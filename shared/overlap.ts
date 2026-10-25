import type { Event } from "./event.ts";
import { sameMeetingKey, type MeetingCopy } from "./meeting.ts";

/**
 * What a collision is decided on: the times, whether the hour is claimed, and what the same-key
 * skip below reads, the meeting key and the accounts. An event, or a row mergeMeetings made of
 * several accounts' copies of one meeting: `alsoIn` says which other accounts the row stands for,
 * so it is not taken for a copy of a meeting one of those accounts holds a second time. Structural,
 * so the board's events and the schedule's rows go through one rule and come back as themselves.
 */
export type Timed = Pick<Event, "id" | "accountId" | "title" | "start" | "end" | "allDay" | "myResponse"> & {
  alsoIn?: readonly MeetingCopy[];
};

/** `a` and `b` are the very objects clashes() was handed; `a` starts first (on a tie, came first). */
export interface Clash<T extends Timed = Event> {
  a: T;
  b: T;
  overlapMs: number;
}

/**
 * An all-day event is a label on the day, not a claim on an hour, and a declined
 * invitation is a meeting you are not at. Counting either would make the board cry wolf
 * every day, and a warning that is always on is not a warning.
 */
function counts(event: Timed): boolean {
  return !event.allDay && event.myResponse !== "declined";
}

function accountsOf(event: Timed): Set<string> {
  return new Set([event.accountId, ...(event.alsoIn ?? []).map((copy) => copy.accountId)]);
}

export function clashes<T extends Timed>(events: readonly T[]): Clash<T>[] {
  const relevant = events
    .filter(counts)
    .map((event) => ({
      event,
      start: Date.parse(event.start),
      end: Date.parse(event.end),
      key: sameMeetingKey(event),
      accounts: accountsOf(event),
    }))
    .filter((entry) => !Number.isNaN(entry.start) && !Number.isNaN(entry.end))
    .sort((left, right) => left.start - right.start);

  const found: Clash<T>[] = [];
  for (let i = 0; i < relevant.length; i += 1) {
    for (let j = i + 1; j < relevant.length; j += 1) {
      // Sorted by start, so once one event begins after this one ends, so does every
      // event after it.
      if (relevant[j].start >= relevant[i].end) break;
      // An equal id is one event handed over twice, not two meetings.
      if (relevant[i].event.id === relevant[j].event.id) continue;
      // Every account invited to a meeting hands over a copy of its own, under its own id, so
      // two copies are known by what they share: the meeting key (shared/meeting.ts), title,
      // start and end. Only across accounts, though. Within one account two events with one
      // key are two meetings, two invitations to an interview at 10:00, and that collision is
      // exactly the double booking the board is here to show. A merged row counts as every
      // account it stands for, so it still collides with a second same-key meeting of any of
      // them.
      if (relevant[i].key === relevant[j].key && disjoint(relevant[i].accounts, relevant[j].accounts)) continue;
      const overlapMs = Math.min(relevant[i].end, relevant[j].end) - relevant[j].start;
      if (overlapMs > 0) {
        found.push({ a: relevant[i].event, b: relevant[j].event, overlapMs });
      }
    }
  }
  return found;
}

function disjoint(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const id of left) if (right.has(id)) return false;
  return true;
}
