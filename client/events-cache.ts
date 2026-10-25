import type { EventsView } from "../shared/calendar.ts";

/**
 * The `since` to send for the answer held now: its version, or nothing when none is held or the
 * daemon had computed none (an empty version), so the first ask is always answered in full.
 */
export function sinceOf(held: EventsView | undefined): string | undefined {
  return held?.version || undefined;
}

/**
 * The view to hold after an answer to `since`. A full answer replaces what was held. An
 * `unchanged` one carries empty lists that mean "keep what you hold", so the held meetings stay
 * (the very same array, so nothing downstream re-renders or re-sorts), and only the sync time
 * moves, so the board's "last sync" stamp keeps advancing at every tick.
 */
export function keepUnchanged(held: EventsView | undefined, answer: EventsView): EventsView {
  // Without held there is nothing to keep; since only ever comes from held, so this is a guard.
  if (!answer.unchanged || !held) return answer;
  return held.syncedAt === answer.syncedAt ? held : { ...held, syncedAt: answer.syncedAt };
}

/**
 * How old the daemon's last pass may be before a focus asks EventKit again. The daemon ticks
 * every five minutes on its own, so a focus soon after one would only re-ask what it said a
 * moment ago; two minutes is short enough that coming back to Paseo after a coffee still sees
 * the Mac's calendar as it is.
 */
export const FOCUS_PASS_AFTER_MS = 120_000;

/**
 * Whether a focus should ask for a provider pass, given the `syncedAt` of the board's held
 * answer. A stamp nobody can read (or none) counts as old, since there is nothing to trust. One
 * ahead of this device's clock gives a negative age, so it does not count as old: a skewed clock
 * must not turn every focus into a pass.
 */
export function providerPassDue(syncedAt: string, nowMs: number): boolean {
  const at = Date.parse(syncedAt);
  if (Number.isNaN(at)) return true;
  return nowMs - at >= FOCUS_PASS_AFTER_MS;
}
