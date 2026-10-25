/**
 * The arithmetic behind the day and month views: which window to fetch, which cells to
 * draw, and where a step forwards or backwards lands.
 *
 * Everything here works in the viewer's own local time, deliberately. A calendar grid is a
 * wall calendar: the row a meeting sits in is the day it is on where the reader is, not the
 * day it is on in UTC. Doing this in UTC puts an 02:00 meeting on the wrong row for anyone
 * east of Greenwich, which is the same class of bug eventkit.swift.ts's allDayString exists
 * to avoid.
 */

export type Period = "agenda" | "day" | "month";

/**
 * How often an open agenda re-reads the daemon's snapshot. The tick itself runs every five
 * minutes; this only keeps a board open for a while from drifting behind it.
 */
export const AGENDA_POLL_MS = 60_000;

/** How soon a read that failed is tried again, where the screen says it is being retried. */
export const ERROR_RETRY_MS = 10_000;

/** The daemon's snapshot: local midnight today and this many days on (server/sync.ts). */
export const SNAPSHOT_DAYS = 14;

/**
 * How often a browsed view re-reads itself while it stays on screen. A day inside the fortnight
 * is a slice of the daemon's snapshot and costs nothing, so the day view keeps the agenda's
 * cadence and shows a tick's news, its banners included, within a minute. A month, or a day
 * outside the fortnight, is a provider pass and does not go stale while it is looked at, so it
 * waits for a navigation. A read that failed is asked again soon whatever the view, because the
 * screen says it is being retried.
 */
export function browseRefetchMs(period: Period, cursor: Date, now: Date, failed = false): number | false {
  if (failed) return ERROR_RETRY_MS;
  if (period !== "day") return false;
  const today = startOfDay(now);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + SNAPSHOT_DAYS);
  const day = startOfDay(cursor);
  return day >= today && day < end ? AGENDA_POLL_MS : false;
}

/** Local midnight starting the day `date` falls in. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * The window a view needs fetched. Half-open — `to` is the first instant NOT included — which
 * matches how every other range in this plugin is expressed (see shared/event.ts on all-day
 * ends) and means a month's window ends exactly where the next one's begins.
 *
 * `agenda` has no window of its own: it reads the daemon's rolling fortnight, which is
 * already warm and is what the composer pill counts against.
 */
export function rangeFor(period: Period, cursor: Date): { from: Date; to: Date } | null {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  switch (period) {
    case "agenda":
      return null;
    case "day": {
      const from = startOfDay(cursor);
      return { from, to: new Date(year, month, cursor.getDate() + 1) };
    }
    case "month":
      return { from: new Date(year, month, 1), to: new Date(year, month + 1, 1) };
  }
}

/**
 * One step forwards or backwards in whatever the current view counts in.
 *
 * A month step lands on the first of the month rather than carrying the day across,
 * because carrying it is how "31 January, next month" becomes 3 March: Date normalises the
 * overflow silently and the view skips February entirely.
 */
export function shift(period: Period, cursor: Date, delta: number): Date {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  switch (period) {
    case "agenda":
      return cursor;
    case "day":
      return new Date(year, month, cursor.getDate() + delta);
    case "month":
      return new Date(year, month + delta, 1);
  }
}

/** Monday, because every locale this plugin speaks starts its week there. */
const WEEK_STARTS_ON = 1;

/**
 * The cells of a month grid: whole weeks, so every row has seven columns and the month is
 * padded at both ends with the neighbouring days rather than with blanks. A blank leading
 * cell loses the information that the 1st is a Thursday, which is most of what a month grid
 * is for.
 */
export function monthGrid(cursor: Date): Date[][] {
  const first = startOfMonth(cursor);
  const lead = (first.getDay() - WEEK_STARTS_ON + 7) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
  const weeks: Date[][] = [];
  const cell = new Date(start);
  // Six rows covers every arrangement a month can take; fewer would clip a 31-day month that
  // starts on a Sunday, and a variable row count makes the grid jump height as you page.
  for (let week = 0; week < 6; week++) {
    const row: Date[] = [];
    for (let day = 0; day < 7; day++) {
      row.push(new Date(cell.getFullYear(), cell.getMonth(), cell.getDate()));
      cell.setDate(cell.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

/** "2026-09-14" in local time — the key events are bucketed by, everywhere in this plugin. */
export function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * Every clock in this plugin, in one place and on a 24-hour face.
 *
 * `hourCycle: "h23"` rather than `hour12: false`, which is not quite the same promise: the
 * latter leaves the choice between an 0–23 and a 1–24 face to the locale, and a meeting at
 * "24:00" would be nobody's idea of midnight. h23 says which one.
 *
 * Centralised because the alternative had been seven call sites across five files each
 * spelling out its own options — the kind of thing that agrees today and disagrees after the
 * next edit.
 */
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** "15:30" — a time on its own, for an agenda row or an event's own hours. */
export function formatClock(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, CLOCK).format(date);
}

/** "14 Sept 2026, 15:30" — a moment in full, for "updated at". */
export function formatStamp(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(date);
}

/** An RFC 3339 stamp (a sync's syncedAt, say) drawn as formatStamp draws it; "" for none or garbage. */
export function formatIsoStamp(iso: string, locale: string): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatStamp(parsed, locale);
}
