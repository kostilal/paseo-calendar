import type { EventView, EventsView } from "../shared/calendar.ts";
import { keepUnchanged, sinceOf } from "./events-cache.ts";
import { type PillState, type PillStrings, pillState, samePillState } from "./pill-state.ts";

/** Runs `tick` every `intervalMs` and hands back the way to stop it. Injectable so a test
 *  can drive the clock by hand rather than wait on a real one. */
export type Ticker = (tick: () => void, intervalMs: number) => () => void;

/** How often the pill is worked out again from what it already holds. A minute is counted
 *  in whole minutes, so a quarter of one is as late as the label or the lead time can be. */
export const EVALUATE_MS = 15_000;
/** Evaluations per events poll: once a minute, the board's own cadence. */
export const POLL_EVERY = 4;
/** Evaluations per lead-time read: every ten minutes, to catch a change made on another
 *  device. calendar.settings launches the helper, so it is not something to ask every minute. */
export const LEAD_EVERY = 40;
/** The lead time until settings answer: the default choice rather than 0, so with the default
 *  lead a pill does not flash into view on every launch only to hide itself a moment later. With
 *  another lead it can still appear or vanish once, when the first settings read lands. */
export const DEFAULT_LEAD_MINUTES = 30;

export interface PillWatchDeps {
  /** `since` is the version of the answer held, so a minute that changed nothing costs a few
   *  bytes rather than the whole fortnight; nothing before the first answer. */
  loadEvents(since: string | undefined): Promise<EventsView>;
  loadLead(): Promise<number>;
  /** Read once per evaluation, for every pill at once. */
  strings(): PillStrings;
  now?: () => number;
  ticker?: Ticker;
}

export interface PillWatch {
  /** Stable across the watch's life, so `useSyncExternalStore` may hold it. */
  subscribe(listener: () => void): () => void;
  /** Referentially stable until the pill actually changes, for the same reason. */
  snapshot(): PillState;
  stop(): void;
}

const realTicker: Ticker = (tick, intervalMs) => {
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
};

/** Every watch that has not stopped. Module-level because the screens that change events or
 *  the lead time are in this same bundle but have no handle on the watch the entry built. */
const live = new Set<{ poll(): void; adoptLead(minutes: number): void }>();

/**
 * Re-poll every live watch now. Called by each client path that has just changed what the
 * board shows, after its own invalidation; without it a deleted, moved or new next meeting
 * would stay on the pill until the next minute's poll.
 *
 * The re-poll reads the daemon's snapshot (`refresh: false`), so it sees the change only
 * because the RPC behind each of these paths answers once the change is in that snapshot: a
 * delete and a disconnect patch it in place, an edit, a create, a calendar toggle and a relink
 * wait for their own refresh before answering (server/sync.ts, up to its post-write cap), and the
 * board's refresh is that refresh. A connect answers before its work is done, so Settings nudges
 * when its poll sees the job done, which the daemon reports only after the refresh that reads
 * the new row.
 */
export function nudgePill(): void {
  for (const watch of [...live]) watch.poll();
}

/** Hand every live watch the lead time Settings just saved, rather than have it wait up to
 *  ten minutes for its own read. */
export function announcePillLead(minutes: number): void {
  for (const watch of [...live]) watch.adoptLead(minutes);
}

/**
 * The pill's data and clock, outside React and outside any pill.
 *
 * The poll used to live in the pill's icon component, and that could not survive the pill
 * hiding itself: the host drops an invisible button from the list it renders (`buttonMatches`
 * refuses one whose `visible` is false), so the icon unmounts, so nothing inside it runs — a
 * hidden pill came back only after the next agent update in that chat, and never in an idle
 * one. Whatever decides visibility has to keep running while the pill is gone, which means
 * here, in the client entry, where the registrations themselves are held.
 *
 * One timer drives everything. Every tick re-evaluates from what is already held, which costs
 * no RPC; every fourth also polls the events, every fortieth re-reads the lead time.
 *
 * A failed poll keeps the last events rather than falling back to "nothing next". The daemon
 * being briefly unreachable, or the plugin mid-reload, is not the same fact as an empty day,
 * and treating it as one would take the pill away and put it back on the next good poll.
 */
export function createPillWatch(deps: PillWatchDeps): PillWatch {
  const now = deps.now ?? Date.now;
  const ticker = deps.ticker ?? realTicker;
  const listeners = new Set<() => void>();
  /** The last answer, whole: its version is what the next poll sends as `since`, and an
   *  `unchanged` answer is read against it (events-cache.ts). */
  let held: EventsView | undefined;
  let events: EventView[] = [];
  let lead = DEFAULT_LEAD_MINUTES;
  let current = pillState([], now(), lead, deps.strings());
  let polling = false;
  let again = false;
  let stopped = false;
  let ticks = 0;

  function evaluate() {
    if (stopped) return;
    const next = pillState(events, now(), lead, deps.strings());
    if (samePillState(current, next)) return;
    current = next;
    for (const listener of [...listeners]) listener();
  }

  function poll() {
    if (stopped) return;
    // One poll at a time. A nudge or a tick that lands mid-poll queues exactly one more: the
    // poll in flight may have been answered from before the change that asked for this one.
    if (polling) {
      again = true;
      return;
    }
    polling = true;
    deps
      .loadEvents(sinceOf(held))
      .then(
        (view) => {
          if (stopped) return;
          held = keepUnchanged(held, view);
          events = held.events;
          evaluate();
        },
        () => {
          // Keep what we had; see above.
        },
      )
      .finally(() => {
        polling = false;
        if (again) {
          again = false;
          poll();
        }
      });
  }

  function adoptLead(minutes: number) {
    if (stopped) return;
    lead = minutes;
    evaluate();
  }

  function readLead() {
    deps.loadLead().then(
      (minutes) => adoptLead(minutes),
      () => {
        // Keep the lead we had.
      },
    );
  }

  const cancel = ticker(() => {
    ticks += 1;
    evaluate();
    if (ticks % POLL_EVERY === 0) poll();
    if (ticks % LEAD_EVERY === 0) readLead();
  }, EVALUATE_MS);

  const self = { poll, adoptLead };
  poll();
  readLead();
  live.add(self);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => current,
    stop() {
      stopped = true;
      cancel();
      listeners.clear();
      live.delete(self);
    },
  };
}
