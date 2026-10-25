import type { EventView } from "./calendar.ts";
import { dayKey } from "./period.ts";

/**
 * Whether a meeting is already behind you.
 *
 * Its own module, and pure, for the same reason overlap.ts is: the board dims a past row so
 * the next one stands out, and "past" is a claim about wall-clock time that has to be right
 * at the two edges — an all-day event, and the minute a meeting ends — rather than a styling
 * detail buried in a component nothing can test.
 *
 * `now` is passed in rather than read here so the answer is reproducible, and so the board
 * can advance it on its own tick: a row that went grey when it was drawn and never again
 * would be worse than no dimming at all.
 */
export function hasPassed(event: Pick<EventView, "end" | "allDay">, now: Date): boolean {
  if (event.allDay) {
    // An all-day end is a bare date and EXCLUSIVE — the day after the last one covered (see
    // shared/event.ts). Compared as written, against today's local key: parsing it through
    // Date would read it as UTC midnight and retire the day early for anyone east of
    // Greenwich, which is the same trap views.tsx's byDay sidesteps.
    return dayKey(now) >= event.end.slice(0, 10);
  }
  const end = Date.parse(event.end);
  // An end nobody can parse is not evidence the meeting is over. Left undimmed: showing a
  // finished meeting at full strength is a smaller lie than greying out one still to come.
  return Number.isNaN(end) ? false : end <= now.getTime();
}
