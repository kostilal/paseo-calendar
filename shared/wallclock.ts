/**
 * The wall clock the create form holds, as something other than a string to be typed.
 *
 * `create-input.ts` takes the start as "YYYY-MM-DDTHH:mm" read in the client's own zone, and
 * that is still what it takes — the format is a contract with the server and is not changing.
 * What changes is that nobody has to type it. These are the pieces a picker needs to move a
 * date or a time without ever assembling that string by hand, which is where the off-by-one
 * month and the missing leading zero come from.
 */

export interface WallClock {
  year: number;
  /** 1-12, as a person counts them — not Date's 0-11. Converting once, here, is the point. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

// The separator is accepted as either "T" or a space, because the parser this replaced
// accepted both and collapsing two implementations should not quietly narrow what either one
// took. Output is always "T", which is the form the server contract names.
const PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** `null` for anything that is not exactly the format the server is promised. */
export function parseWallClock(text: string): WallClock | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  // A day that does not exist in its month — 31 April, 30 February — would be normalised by
  // Date into the next month without complaint, which is exactly the silent slip this rejects.
  const probe = new Date(year, month - 1, day);
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return { year, month, day, hour, minute };
}

export function formatWallClock(when: WallClock): string {
  return `${when.year}-${pad(when.month)}-${pad(when.day)}T${pad(when.hour)}:${pad(when.minute)}`;
}

export function wallClockOf(date: Date): WallClock {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

/** Local, deliberately: the form's start is a wall clock, not an instant. */
export function dateOfWallClock(when: WallClock): Date {
  return new Date(when.year, when.month - 1, when.day, when.hour, when.minute);
}

/** Move the day, keep the time. */
export function withDate(when: WallClock, date: Date): WallClock {
  return { ...when, year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** Move the time, keep the day. */
export function withTime(when: WallClock, hour: number, minute: number): WallClock {
  return { ...when, hour, minute };
}
