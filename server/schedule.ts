import type { EventsView, ScheduleView, SettingsView } from "../shared/calendar.ts";
import { buildSchedule, resolveWindow, validTimeZone } from "../shared/schedule.ts";

export interface ScheduleInput {
  date: string;
  from: string;
  to: string;
  time_zone: string;
  with_links: boolean;
  include_declined: boolean;
}

/** The two things a schedule needs from sync, so a test can hand in its own. */
export interface ScheduleSync {
  range(from: Date, to: Date): Promise<EventsView>;
  settings(): Promise<SettingsView>;
}

/** The zone the daemon's Mac runs in; ChatGPT asks for "today" meaning the user's today. */
export function daemonTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function refusal(zone: string, error: string): ScheduleView {
  return {
    summary: "",
    time_zone: zone,
    from: "",
    to: "",
    as_of: "",
    stale: false,
    events: [],
    conflicts: [],
    sources: [],
    hidden: { declined: 0, duplicates: 0 },
    error,
  };
}

/**
 * The asked day or period, midnight to midnight in the asked zone, is always read through
 * range(), and range() decides between memory and EventKit: a window inside the fortnight the
 * tick keeps warm, while that is fresh, is a slice of it; anything else is EventKit's local
 * replica, well under a second for an Apple Calendar account, and the same window asked again
 * within a minute is answered from that read.
 */
export async function readSchedule(sync: ScheduleSync, input: ScheduleInput, nowMs: number): Promise<ScheduleView> {
  const zone = input.time_zone.trim() || daemonTimeZone();
  if (!validTimeZone(zone)) return refusal(zone, `unknown time zone ${zone}; use an IANA name such as Europe/Warsaw`);
  const window = resolveWindow(input, nowMs, zone);
  if ("error" in window) return refusal(zone, window.error);

  const view = await sync.range(new Date(window.startMs), new Date(window.endMs));
  const settings = await sync.settings();

  return buildSchedule({
    view,
    accounts: settings.accounts.map(({ id, sourceId, title, owner, kind, errorCode, missingSince, calendars }) => ({
      id,
      sourceId,
      title,
      owner,
      kind,
      errorCode,
      missingSince,
      // Sync's own rule (isReadable): an account is read only when some calendar of it is shown.
      readable: calendars.some((calendar) => calendar.shown),
    })),
    window,
    zone,
    nowMs,
    withLinks: input.with_links,
    includeDeclined: input.include_declined,
  });
}
