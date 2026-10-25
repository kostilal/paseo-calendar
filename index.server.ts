import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addEvent,
  connectAccount,
  createEvent,
  deleteEvent,
  disconnectAccount,
  getEvents,
  getSchedule,
  getSettings,
  listCalendars,
  openJoin,
  relinkAccount,
  requestAccess,
  setCalendars,
  setDefaultView,
  setPillLead,
  updateEvent,
} from "./shared/calendar.ts";
import { sweepHelperLeftovers } from "./server/eventkit.ts";
import { answerSince, createSync, type Sync } from "./server/sync.ts";
import { answerAddEvent, answerCalendars } from "./server/assistant.ts";
import { describeCalendar, describeRpc } from "./server/capabilities.ts";
import { openJoinUrl } from "./server/open.ts";
import { daemonTimeZone, readSchedule } from "./server/schedule.ts";
import { readStored, writeStored } from "./server/store.ts";

export default function contribute(server: PluginServerContext) {
  const sync: Sync = createSync({
    read: () => readStored(),
    write: (stored) => writeStored(stored),
    log: (line) => console.log(line),
  });

  // Kick off the first fetch as soon as the daemon loads the plugin, so the first client to
  // open the board finds a day already on it, rather than waiting for the first RPC to ask.
  // Every handler below awaits this same promise instead of calling start() again, so a slow
  // connect() later (the macOS permission prompt waits on a human) only delays its own turn in
  // sync's queue and never re-triggers startup.
  // A read's temp file holds its meetings' notes and guests; one a stopped daemon left behind
  // goes now. Best-effort, and never in the way of the first board.
  void sweepHelperLeftovers().catch(() => 0);

  const started: Promise<Sync> = sync.start().then(
    () => sync,
    (error: unknown) => {
      console.error(`calendar: start failed: ${String(error)}`);
      return sync;
    },
  );

  server.handle(getSettings, async () => (await started).settings());
  server.handle(connectAccount, async (input) => (await started).connect(input));
  // Not routed through sync: opening a link is neither a read of calendar state nor a write
  // to it, and queueing it behind a connect waiting on the macOS permission dialog would be absurd.
  server.handle(openJoin, async ({ url }) => openJoinUrl(url));
  server.handle(requestAccess, async () => (await started).requestAccess());
  // ok is false when a broken store refused the write: the row is still there, and saying so
  // beats a success the next settings read contradicts.
  server.handle(disconnectAccount, async ({ accountId }) => ({ ok: await (await started).disconnect(accountId) }));
  server.handle(relinkAccount, async ({ accountId, sourceId }) => (await started).relink(accountId, sourceId));
  server.handle(setCalendars, async ({ accountId, shown }) => (await started).setCalendars(accountId, shown));
  server.handle(getEvents, async ({ refresh, from, to, since }) => {
    const instance = await started;
    if (from && to) {
      const start = new Date(from);
      const end = new Date(to);
      // An unparseable bound would reach the providers as "Invalid Date" and come back as a
      // provider error about a malformed time; falling through to the snapshot answers with
      // something true instead.
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) return instance.range(start, end);
    }
    // `refresh: true` answers with the snapshot too, so since applies to it as well.
    return answerSince(refresh ? await instance.refresh() : instance.snapshot(), since);
  });
  // eventView's company and join fields only come from sync's own view(), so a half-shaped
  // event here would be a second code path for the same data — the client refetches instead.
  server.handle(createEvent, async (input) => {
    const result = await (await started).create(input);
    return { event: null, error: result.error };
  });

  server.handle(deleteEvent, async (input) => (await started).remove(input));
  server.handle(setPillLead, async ({ minutes }) => (await started).setPillLead(minutes));
  server.handle(setDefaultView, async ({ view }) => (await started).setDefaultView(view));
  server.handle(updateEvent, async (input) => (await started).update(input));
  // For ChatGPT, through God Mode: the merged schedule, the calendars, a preview and the one write
  // it may ask for — adding an event, which God Mode always confirms with the user first (see
  // server/capabilities.ts). The zone is read on every call, so a Mac that changed zone is followed.
  server.handle(getSchedule, async (input) => readSchedule(await started, input, Date.now()));
  server.handle(listCalendars, async () => answerCalendars(await started, daemonTimeZone()));
  server.handle(addEvent, async (input) => answerAddEvent(await started, input, Date.now(), daemonTimeZone()));
  server.handle(describeRpc, () => describeCalendar());

  return () => {
    sync.stop();
  };
}
