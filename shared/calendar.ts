import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Period } from "./period.ts";

/**
 * Which of the board's three views opens first.
 *
 * The same three names shared/period.ts already counts in, as a value rather than a type so
 * the choice can be stored and sent — and annotated against `Period` so the two cannot drift
 * apart in silence.
 */
export const boardView = z.enum(["agenda", "day", "month"]) satisfies z.ZodType<Period>;

export const attendeeView = z.object({
  name: z.string(),
  email: z.string(),
  response: z.enum(["accepted", "declined", "tentative", "unknown"]),
  self: z.boolean(),
  organiser: z.boolean(),
  /** Null for colleagues and free mail; see company.ts. */
  company: z.string().nullable(),
});

export const eventView = z.object({
  id: z.string(),
  accountId: z.string(),
  calendarId: z.string(),
  calendarName: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  /** One occurrence of a series. Editing is offered for one-off meetings only. */
  recurring: z.boolean().default(false),
  /** You called this meeting. Editing is offered for your own only. */
  mine: z.boolean().default(false),
  attendees: z.array(attendeeView),
  location: z.string(),
  description: z.string(),
  webLink: z.string(),
  myResponse: z.enum(["accepted", "declined", "tentative", "unknown"]),
  joinUrl: z.string(),
  joinKind: z.enum(["meet", "teams", "zoom", "other", "none"]),
  /**
   * Calendars this meeting was also found in, through other accounts' copies merged into this
   * row (server/sync.ts viewOf): one entry per copy, with its account, because a name alone
   * cannot tell two mailboxes' "Calendar" apart.
   */
  alsoIn: z.array(z.object({ accountId: z.string(), calendarId: z.string(), calendarName: z.string() })).default([]),
});

export const calendarView = z.object({
  id: z.string(),
  name: z.string(),
  shown: z.boolean(),
});

export const sourceView = z.object({
  id: z.string(),
  title: z.string(),
  /** exchange | caldav | icloud | local | subscribed | birthdays | other. */
  kind: z.string(),
  calendars: z.number().int().nonnegative(),
});

/**
 * macOS calendar permission, as the daemon last saw it. "asking" means the system dialog is
 * on screen right now and a person has not answered it — a state that only exists because
 * requesting is no longer allowed to block the RPC that started it.
 */
export const accessState = z.enum(["unknown", "asking", "granted", "denied"]);

/**
 * What went wrong, as something to act on. The code is what the screen, the board banner and
 * the schedule decide by; the message beside it is for people. "" means no error.
 */
export const errorCode = z.enum(["", "source_gone", "access_needed", "macos_required", "helper_failed", "store_broken", "unknown"]);

/** A live source on this Mac that a row whose own source is gone could be moved onto. */
export const relinkTarget = z.object({
  sourceId: z.string(),
  title: z.string(),
  calendars: z.number().int().nonnegative(),
});

/**
 * One stored account, as the screen sees it. Every field after `title` is defaulted so a newer
 * client still parses an older daemon's answer.
 */
export const accountView = z.object({
  id: z.string(),
  /** The macOS calendar source this account reads. */
  sourceId: z.string().default(""),
  /** What macOS calls the source, often just "Exchange". */
  title: z.string(),
  /** The mailbox this account is, learned from the attendee EventKit marks as `self`; "" until then. */
  owner: z.string().default(""),
  /** The source's kind, as sourceView has it; "" on a row migrated from v1 until a tick sees its source. */
  kind: z.string().default(""),
  calendars: z.array(calendarView).default([]),
  /** When this account was last read cleanly; a failing read leaves the last good one. */
  lastSyncAt: z.string().default(""),
  lastError: z.string().default(""),
  errorCode: errorCode.default(""),
  /** When a tick first found this account's source missing from the Mac; "" while it is there. */
  missingSince: z.string().default(""),
  relinkTo: relinkTarget.nullable().default(null),
});

/**
 * A connect in flight, and how it ended.
 *
 * Connecting cannot be the RPC's own return value. The plugin host gives a handler thirty
 * seconds (REQUEST_TIMEOUT_MS in Paseo's own bundle), and the macOS permission dialog can
 * legitimately take longer: it waits on someone finding it behind their windows. The old
 * blocking handler therefore reported "Plugin RPC timed out" while the work went on happily
 * in the background and even finished — the account appeared, but only after a reload, and
 * the screen had already said it failed. So the RPC starts the work and this reports on it.
 */
export const connectJob = z.object({
  sourceId: z.string().default(""),
  state: z.enum(["running", "failed", "done"]),
  error: z.string().default(""),
  /** Why a failed connect failed, for the screen to word; "" while running and once done. */
  code: errorCode.default(""),
});

export const settingsView = z.object({
  accounts: z.array(accountView),
  access: accessState,
  /** Minutes before a meeting that the composer pill appears; 0 means always. */
  pillLeadMinutes: z.number().int().min(0),
  /** The view the board opens on, before anybody taps a different chip. */
  defaultView: boardView,
  /** Null when nothing has been attempted since the daemon started. */
  connect: connectJob.nullable(),
  /**
   * The Mac's sources that no row reads, listed once access is granted. A source some row
   * matched for a relink is left out, even when two rows matched it and neither is offered it:
   * adding it would make another row for the same account.
   */
  found: z.array(sourceView).default([]),
  /**
   * Listing this Mac's sources failed on this read, so `found` is empty for want of an answer, not
   * because every account is already a row.
   */
  foundFailed: z.boolean().default(false),
  /**
   * The store read as broken, so nothing is saved: every change made on the screen snaps back.
   * True with or without a copy; `storeAside` says which.
   */
  storeBroken: z.boolean().default(false),
  /**
   * The path of the copy a broken store was set aside as, while the last read was broken; ""
   * otherwise, and also when a broken file could not be copied.
   */
  storeAside: z.string().default(""),
  /**
   * Why the last Allow access could not ask macOS at all (the helper would not build, launch or
   * answer); "" otherwise. A refusal is `access: "denied"`, never this.
   */
  accessError: z.string().default(""),
});

/**
 * event.id alone is only promised unique within one account's own calendar, so two connected
 * accounts can each hand back an event under the same id. A clash side used to carry only that
 * bare id, which meant resolving it back to an event had to guess which of the two was meant
 * and silently kept whichever one a Map happened to visit last. Carrying the accountId here too
 * — the same composite shared/group.ts's eventKey already builds everywhere else — removes
 * the guess entirely.
 */
export const clashSide = z.object({ accountId: z.string(), id: z.string() });

export const clashView = z.object({
  a: clashSide,
  b: clashSide,
  overlapMs: z.number().int().nonnegative(),
});

export const eventsView = z.object({
  events: z.array(eventView),
  clashes: z.array(clashView),
  syncedAt: z.string().default(""),
  errors: z.array(z.object({ accountId: z.string(), message: z.string(), code: errorCode.default("") })),
  /**
   * A hash of the events, clashes and errors, and of nothing else: syncedAt moves every tick
   * whether or not anything did. A caller holding an answer sends this back as `since`. Empty
   * until the daemon has computed a view, and an empty version never matches a `since`.
   */
  version: z.string(),
  /**
   * True only on the answer to a `since` that matched `version`. The lists are then empty and
   * mean "keep what you hold", not "there is nothing"; syncedAt is still the current one.
   */
  unchanged: z.boolean().default(false),
});

export type AccessState = z.output<typeof accessState>;
export type ErrorCode = z.output<typeof errorCode>;
export type BoardView = z.output<typeof boardView>;
export type ConnectJob = z.output<typeof connectJob>;
export type SourceView = z.output<typeof sourceView>;
export type EventView = z.output<typeof eventView>;
export type AccountView = z.output<typeof accountView>;
export type SettingsView = z.output<typeof settingsView>;
export type EventsView = z.output<typeof eventsView>;

export const getSettings = defineRpc({
  name: "calendar.settings",
  input: z.object({}),
  output: settingsView,
});

export const connectAccount = defineRpc({
  name: "calendar.connect",
  // Which macOS source to read. Chosen from settings' `found`, never guessed: connecting without
  // it used to mean taking every calendar on the machine.
  input: z.object({ sourceId: z.string().default("") }),
  // Not the finished account: see connectJob. `started` is false when another connect is
  // already running, which is the one refusal this can answer immediately.
  output: z.object({ started: z.boolean(), error: z.string().default("") }),
});

/**
 * Ask macOS for calendar access, as its own step rather than a side effect of listing.
 *
 * Returns as soon as the dialog is up, for the same reason connect does — nobody answers a
 * permission prompt inside thirty seconds if it opened behind their editor. The answer
 * arrives through settings().access.
 */
export const requestAccess = defineRpc({
  name: "calendar.access",
  input: z.object({}),
  output: z.object({ access: accessState }),
});

/**
 * Open a meeting's join link on the daemon's machine.
 *
 * It has to be the daemon. A plugin client on the 0.8 SDK cannot open anything outside Paseo
 * (openExternalUrl came in 0.9, and on the desktop it opens the system browser, not the Teams
 * app), so handing the URL to `Linking.openURL` put it in a window inside the app, with none of
 * the browser session a call needs: Meet answered "You can't join this video call" and Teams
 * answered with its retired web entry point. The daemon opens it, and picks the Teams app over
 * a browser when it is installed.
 */
export const openJoin = defineRpc({
  name: "calendar.join",
  input: z.object({ url: z.string().min(1) }),
  output: z.object({ via: z.enum(["app", "browser"]), error: z.string().default("") }),
});

export const disconnectAccount = defineRpc({
  name: "calendar.disconnect",
  input: z.object({ accountId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Move a row onto the source its macOS account moved to, as offered by its `relinkTo`.
 *
 * Never automatic: only this RPC does it, on a person's tap. The server does not trust the offer
 * the client is holding; it re-checks every rule from shared/accounts.ts against a fresh
 * `sources` and `calendars <id>` read, and refuses without writing if the source is no longer
 * this row's one match. The row id survives, so the board's event keys and every hidden choice
 * survive with it. `settings` is null whenever `error` is not empty.
 */
export const relinkAccount = defineRpc({
  name: "calendar.relink",
  input: z.object({ accountId: z.string(), sourceId: z.string() }),
  output: z.object({ error: z.string(), settings: settingsView.nullable() }),
});

export const setCalendars = defineRpc({
  name: "calendar.calendars",
  input: z.object({ accountId: z.string(), shown: z.record(z.string(), z.boolean()) }),
  output: settingsView,
});

export const getEvents = defineRpc({
  name: "calendar.events",
  input: z.object({
    refresh: z.boolean().default(false),
    /**
     * An explicit window, for the day and month views. Both bounds or neither: absent means
     * the daemon's own rolling fortnight, which is what the agenda and the composer pill
     * read and what the background tick keeps warm.
     *
     * A window inside that fortnight, while the tick's read is fresh, is answered from it: the
     * day view of a day this fortnight costs no launch. Anything else is fetched and cached
     * briefly, and does not disturb the snapshot. Apple's Calendar can answer any range
     * instantly because it queries a local replica that something else keeps in sync; EventKit
     * is exactly that replica, and a year costs about the same as a fortnight (measured: 163ms
     * against 132ms), so such a range is fetched on demand rather than kept permanently warm.
     */
    from: z.string().optional(),
    to: z.string().optional(),
    /**
     * The version of the answer the caller already holds. When it still matches the snapshot,
     * the answer is a few bytes with `unchanged: true` instead of the whole fortnight: about
     * 150 KB that did not change is no longer resent every minute to the board and the pill.
     * Ignored for a range, which is always answered in full; a range whose bounds do not parse
     * is answered from the snapshot instead, and then this applies.
     */
    since: z.string().optional(),
  }),
  output: eventsView,
});

/**
 * Change an existing one-off meeting.
 *
 * Only one-off: an occurrence and its series are different things to change, EventKit makes
 * the caller say which at save time, and guessing wrong rewrites every future occurrence of a
 * standup. The client hides the button for a series, the server refuses one, and the Swift
 * helper refuses again — three guards for one mistake nobody can undo from here. An all-day
 * event is refused by the card and the server as well: `start` and `end` here are instants, and
 * its bare dates would be written back as UTC midnights. So is any meeting outside the snapshot's
 * fortnight, which is all the server can check an id against.
 */
export const updateEvent = defineRpc({
  name: "calendar.update",
  input: z.object({
    accountId: z.string(),
    eventId: z.string(),
    calendarId: z.string(),
    title: z.string().min(1),
    start: z.string(),
    end: z.string(),
    description: z.string().default(""),
  }),
  output: z.object({ error: z.string().default("") }),
});

/**
 * Remove a one-off meeting.
 *
 * The same three guards as updateEvent, for a sharper reason: deleting a series removes every
 * occurrence of it, and unlike a mistimed edit there is nothing left to correct afterwards.
 */
export const deleteEvent = defineRpc({
  name: "calendar.delete",
  input: z.object({
    accountId: z.string(),
    eventId: z.string(),
    calendarId: z.string(),
  }),
  output: z.object({ error: z.string().default("") }),
});

/**
 * How early the composer pill appears. Zero keeps it on screen all the time, which is what it
 * did before this was a choice — kept as an option rather than taken away.
 */
export const setPillLead = defineRpc({
  name: "calendar.pill-lead",
  input: z.object({ minutes: z.number().int().min(0).max(24 * 60) }),
  output: settingsView,
});

/**
 * Which view the board opens on.
 *
 * Stored rather than remembered per client, because the answer is about how somebody reads
 * their day and not about which device they happen to be holding — the same reasoning that
 * put the pill's lead time in the store instead of in component state.
 */
export const setDefaultView = defineRpc({
  name: "calendar.default-view",
  input: z.object({ view: boardView }),
  output: settingsView,
});

/**
 * One row of a schedule read aloud. Deliberately narrower than eventView: no description, no
 * location, no guests — see shared/schedule.ts for why.
 */
export const scheduleEvent = z.object({
  /** The day it is listed under, YYYY-MM-DD in the schedule's zone. */
  date: z.string(),
  /** HH:MM in the schedule's zone; empty for an all-day event. */
  start: z.string(),
  end: z.string(),
  /** Set when a timed event began before `date` (it runs over midnight into the window). */
  started: z.string().optional(),
  /** The last day it covers, when that is after `date`. */
  until: z.string().optional(),
  all_day: z.boolean(),
  title: z.string(),
  /** Every calendar it was found in, after merging copies of the same meeting. */
  calendar: z.string(),
  join: z.enum(["meet", "teams", "zoom", "other"]).optional(),
  join_url: z.string().optional(),
  response: z.enum(["tentative", "declined"]).optional(),
  conflicts_with: z.array(z.string()).optional(),
});

export const scheduleSource = z.object({
  name: z.string(),
  kind: z.string(),
  ok: z.boolean(),
  note: z.string().optional(),
  /** Failed, but the same mailbox is read through another account that was, so nothing is missing. */
  covered: z.boolean().optional(),
});

export const scheduleView = z.object({
  summary: z.string(),
  time_zone: z.string(),
  from: z.string(),
  to: z.string(),
  as_of: z.string(),
  stale: z.boolean(),
  events: z.array(scheduleEvent),
  conflicts: z.array(z.string()),
  sources: z.array(scheduleSource),
  /**
   * Declined meetings left out, and copies folded into another row. Cancelled ones are left out
   * too and not counted: the board drops them before a schedule sees them.
   */
  hidden: z.object({ declined: z.number().int(), duplicates: z.number().int() }),
  /** Not empty when the request itself could not be answered (a bad date or zone). */
  error: z.string(),
});

export type ScheduleEvent = z.output<typeof scheduleEvent>;
export type ScheduleSource = z.output<typeof scheduleSource>;
export type ScheduleView = z.output<typeof scheduleView>;

const scheduleDay = z
  .string()
  .default("")
  .describe("YYYY-MM-DD, today, tomorrow, yesterday or an English weekday name (the next one, today included). Empty: today");

/**
 * Read only: the merged schedule for a day or a period, for a listener rather than the board.
 * The arguments are snake_case because a voice assistant is what fills them in.
 */
export const getSchedule = defineRpc({
  name: "calendar.schedule",
  input: z.object({
    date: scheduleDay,
    from: scheduleDay.describe("First day of a period: YYYY-MM-DD, today, tomorrow, yesterday or an English weekday name"),
    // resolveWindow allows to = from + 30: thirty-one days counting both ends.
    to: scheduleDay.describe("Last day of a period, inclusive; at most 30 days after from (31 days in all)"),
    time_zone: z.string().default("").describe("IANA zone such as Europe/Warsaw. Empty: the Mac's own zone"),
    with_links: z.boolean().default(false).describe("Include each meeting's join link"),
    include_declined: z.boolean().default(false).describe("Also list meetings the user declined"),
  }),
  output: scheduleView,
});

/**
 * One timed event to add, in the argument shape an earlier Apple Calendar plugin for God Mode
 * used, because that is what ChatGPT was taught to send. `dry_run` has no default on purpose: God Mode always fixes it (true for the
 * preview, false for the add), and a caller that leaves it out is refused by validation rather
 * than defaulted into a write it never meant, or into a preview it mistakes for a write.
 */
export const addEventInput = z.object({
  title: z.string().min(1).max(200).describe("Event title."),
  // min(1): an empty date would mean today, and the confirmation built from these arguments would
  // ask the user about an event "on  at 10:00", naming no day at all.
  date: z.string().min(1).max(40).describe("Day: YYYY-MM-DD, 'today', 'tomorrow', 'yesterday' or an English weekday name."),
  start_time: z.string().max(5).describe("Start, HH:MM 24-hour, in the Mac's own time zone."),
  duration_minutes: z.number().int().min(5).max(720).describe("Length in minutes."),
  calendar: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Exact target calendar: owner email (e.g. name@example.com), 'Account/Calendar', or exact calendar title. See the calendars read.",
    ),
  dry_run: z.boolean().describe("True: only resolve the calendar and check duplicates and overlaps; nothing is created."),
});

/** Every connected account and its calendars, worded for ChatGPT to pick an add_event target from. */
export const calendarsAnswer = z.object({
  summary: z.string(),
  access: accessState,
  time_zone: z.string(),
  sources: z.array(
    z.object({
      /** The mailbox once learned, else what macOS calls the source (accountLabel). */
      account: z.string(),
      title: z.string(),
      kind: z.string(),
      on_this_mac: z.boolean(),
      calendars: z.array(z.object({ name: z.string(), shown: z.boolean(), writable: z.boolean() })),
    }),
  ),
  /** Sources on this Mac that no account in Paseo reads. */
  not_connected: z.array(z.string()),
  warnings: z.array(z.string()),
  error: z.string(),
});

/** Times are HH:MM in `timezone`; `event_id` only once there is an event to name. */
export const addedEvent = z.object({
  title: z.string(),
  date: z.string(),
  start: z.string(),
  end: z.string(),
  timezone: z.string(),
  calendar: z.string(),
  event_id: z.string().optional(),
});

export const addEventAnswer = z.object({
  /**
   * False only when nothing was added. A save that could not be read back is still true: God Mode
   * takes false as "not done", and that invites the retry that adds a second copy.
   */
  ok: z.boolean(),
  status: z.enum(["dry_run", "already_exists", "saved_locally_verified", "saved_unverified", "refused"]),
  summary: z.string(),
  would_create: addedEvent.nullable(),
  event: addedEvent.nullable(),
  conflicts: z.array(z.object({ title: z.string(), start: z.string(), end: z.string(), calendar: z.string() })),
  /** "not_confirmed" once saved: EventKit never says whether the provider accepted it. */
  provider_sync: z.enum(["", "not_confirmed"]),
  error: z.string(),
});

export type AddEventInput = z.output<typeof addEventInput>;
export type CalendarsAnswer = z.output<typeof calendarsAnswer>;
export type AddEventAnswer = z.output<typeof addEventAnswer>;

/**
 * For ChatGPT, through God Mode: the accounts and calendars an event may be added to. Not
 * `calendar.calendars`, which is the board's toggle of which calendars are shown.
 */
export const listCalendars = defineRpc({
  name: "calendar.accounts",
  input: z.object({}),
  output: calendarsAnswer,
});

/**
 * For ChatGPT, through God Mode: preview (dry_run) or add one timed event. Not `calendar.create`,
 * which is the board's create, addressed by account and calendar id rather than by name.
 */
export const addEvent = defineRpc({
  name: "calendar.add",
  input: addEventInput,
  output: addEventAnswer,
});

/**
 * EventKit sends no invitations and has no conferencing field, so the request carries neither;
 * zod strips the old `attendees` and `conferencing` keys if an older client still sends them.
 */
export const createEvent = defineRpc({
  name: "calendar.create",
  input: z.object({
    accountId: z.string(),
    calendarId: z.string(),
    title: z.string().min(1),
    start: z.string(),
    end: z.string(),
    description: z.string().default(""),
  }),
  output: z.object({ event: eventView.nullable(), error: z.string().default("") }),
});
