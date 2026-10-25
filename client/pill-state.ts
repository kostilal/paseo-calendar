import { eventKey } from "../shared/group.ts";
import type { Strings } from "../shared/i18n.ts";
import { type Occurrence, type Step, pickNext, pillVisible, step } from "../shared/ladder.ts";

/** The only words the pill ever says. */
export type PillStrings = Pick<Strings, "nothingToday" | "pillNow" | "pillIn">;

/**
 * Everything any pill shows, worked out once for all of them. `label` and `visible` are the
 * host's half, pushed through PluginButtonRegistration.update(); `level` and `running` are
 * the icon's half, drawn as its colour and pulse; `target` is where a press lands.
 */
export interface PillState {
  label: string;
  visible: boolean;
  level: Step;
  running: boolean;
  /** The next meeting's eventKey, or null when there is none. */
  target: string | null;
}

export function pillState(
  events: ReadonlyArray<Occurrence & { accountId: string; id: string; title: string }>,
  nowMs: number,
  leadMinutes: number,
  strings: PillStrings,
): PillState {
  const next = pickNext([...events], nowMs);
  // A meeting already under way is off the ladder entirely, not a rung on it: step() would
  // happily keep returning "hot" for a negative remainder, but the countdown it counts down
  // is over, so running is read separately rather than trusted through step(). The icon still
  // gives it its own colour — distinct from calm's and from the ladder's — so a meeting six
  // hours away and one you are late to never render as the same thing; what it does not get
  // is escalation or a pulse, because there is nothing left to warn about once it has begun.
  const level: Step = next && !next.running ? step(Date.parse(next.event.start), nowMs) : "calm";
  const minutes = next ? Math.max(0, Math.round((Date.parse(next.event.start) - nowMs) / 60_000)) : 0;
  // Never empty, even with nothing next: the host's validateButton throws on an empty label.
  // "Nothing next" reuses the board's own empty-agenda copy rather than a bespoke string, so
  // the two never say it differently.
  const label = !next
    ? strings.nothingToday
    : next.running
      ? strings.pillNow(next.event.title)
      : strings.pillIn(next.event.title, minutes);
  return {
    label,
    visible: pillVisible(next, nowMs, leadMinutes),
    level,
    running: next?.running ?? false,
    target: next ? eventKey(next.event) : null,
  };
}

export function samePillState(a: PillState, b: PillState): boolean {
  return (
    a.label === b.label &&
    a.visible === b.visible &&
    a.level === b.level &&
    a.running === b.running &&
    a.target === b.target
  );
}

/**
 * What to push to the host, given what was pushed last: null when the host's half has not
 * moved. A rung change alone is the icon's business, drawn by the icon from the same state,
 * and pushing an unchanged label and visibility to every pill for it would be work for the
 * host with nothing to show for it.
 */
export function pillPatch(
  pushed: { label: string; visible: boolean } | null,
  next: PillState,
): { label: string; visible: boolean } | null {
  if (pushed && pushed.label === next.label && pushed.visible === next.visible) return null;
  return { label: next.label, visible: next.visible };
}
