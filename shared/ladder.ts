/** Ten minutes: enough to close what you are doing and walk to a room. */
export const WARM_MS = 10 * 60_000;
/** Five minutes: enough to finish a thought, not enough to start one. */
export const URGENT_MS = 5 * 60_000;
/** One minute: it is starting, and nothing else is going to get done first. */
export const HOT_MS = 60_000;

export type Step = "calm" | "warm" | "urgent" | "hot";

/**
 * Which rung the pill is on, once it is on screen at all. Whether it is on screen is
 * pillVisible's question, and a separate one: the rungs describe urgency, not presence.
 */
export function step(startMs: number, nowMs: number): Step {
  const remaining = startMs - nowMs;
  if (remaining <= HOT_MS) return "hot";
  if (remaining <= URGENT_MS) return "urgent";
  if (remaining <= WARM_MS) return "warm";
  return "calm";
}

/**
 * How the pill breathes at each rung, as numbers rather than as a branch inside a component,
 * so the escalation can be read and tested in one place.
 *
 * Escalation is carried by both depth and speed, because either alone is easy to miss out of
 * the corner of an eye: ten minutes out is a slow, shallow breath that does not demand
 * anything; one minute out is fast and nearly dark, and hard to ignore on purpose. `null` is
 * calm — not a pulse of zero amplitude, but no animation running at all, so nothing is
 * scheduled for the twenty-three hours a day when the next meeting is far away.
 */
export function pulseFor(step: Step): { dim: number; durationMs: number } | null {
  switch (step) {
    case "warm":
      return { dim: 0.75, durationMs: 900 };
    case "urgent":
      return { dim: 0.5, durationMs: 550 };
    case "hot":
      return { dim: 0.25, durationMs: 300 };
    case "calm":
      return null;
  }
}

/**
 * The least an event has to be for this module to reason about it. Stated structurally so
 * that both the server's `Event` and the client's `EventView` satisfy it and neither side
 * needs a cast — a cast here would be hiding exactly the mismatch worth catching.
 */
export interface Occurrence {
  start: string;
  end: string;
  allDay: boolean;
  myResponse: string;
}

function counts(event: Occurrence): boolean {
  return !event.allDay && event.myResponse !== "declined";
}

/**
 * What the pill is about. A meeting already under way beats one that has not started —
 * being late to the one you are in matters more than being early to the next.
 */
export function pickNext<T extends Occurrence>(events: T[], nowMs: number): { event: T; running: boolean } | null {
  const upcoming = events
    .filter(counts)
    .map((event) => ({ event, start: Date.parse(event.start), end: Date.parse(event.end) }))
    .filter((entry) => !Number.isNaN(entry.start) && !Number.isNaN(entry.end) && entry.end > nowMs)
    .sort((left, right) => left.start - right.start);

  const running = upcoming.find((entry) => entry.start <= nowMs);
  if (running) return { event: running.event, running: true };
  return upcoming.length > 0 ? { event: upcoming[0].event, running: false } : null;
}

/** A lead time of zero means the pill never hides — the behaviour this setting replaced. */
export const LEAD_ALWAYS = 0;

/**
 * Whether the pill belongs on screen at all.
 *
 * It used to be there always, carrying the next meeting all day in neutral styling, on the
 * argument that a pill which materialises is itself an interruption. That holds right up
 * until you notice it is also occupying the composer for the twenty-three hours a day when
 * the next meeting is tomorrow. So presence became a setting, with the old behaviour kept as
 * one of its choices rather than taken away.
 *
 * A meeting already under way ignores the setting entirely. Being late to the one you are in
 * is the single thing this pill exists to tell you, and hiding it because the lead time has
 * elapsed would hide it exactly when it matters most.
 */
export function pillVisible<T extends Occurrence>(
  next: { event: T; running: boolean } | null,
  nowMs: number,
  leadMinutes: number,
): boolean {
  if (!next) return false;
  if (next.running) return true;
  if (leadMinutes <= LEAD_ALWAYS) return true;
  const start = Date.parse(next.event.start);
  if (Number.isNaN(start)) return false;
  return start - nowMs <= leadMinutes * 60_000;
}
