import { accountLabel } from "../shared/accounts.ts";
import {
  isSameAdded,
  overlapsOf,
  planEvent,
  resolveTarget,
  targetLabel,
  targetsOf,
  type PlannedEvent,
} from "../shared/add-event.ts";
import type {
  AccountView,
  AddEventAnswer,
  AddEventInput,
  CalendarsAnswer,
  EventsView,
  EventView,
  SettingsView,
} from "../shared/calendar.ts";
import { addDays, failureNote, localDate, localTime, oneLine, sameMailbox, zonedMidnight } from "../shared/schedule.ts";
import { waitAtMost, type Sync } from "./sync.ts";

/**
 * What ChatGPT reads, through God Mode, to find a calendar and add one event to it: `calendars`,
 * `event_preview` and `add_event`, under the ids and words an earlier Apple Calendar plugin for
 * God Mode used, answered from this plugin's own accounts and its own EventKit create. English
 * only, like the schedule: ChatGPT reads these, Paseo's UI never shows them.
 *
 * The add is guarded the way that plugin guarded it, minus its file of past adds: one exact
 * calendar, a read of the target day for a copy that is already there, and a read back after the
 * write. A retry after a lost answer is caught by that first read. The add queue below holds the
 * retry until the first try's create and read-back are done, and that read-back has waited for
 * the refresh create() fires, so the copy the first try made is already in it. Every answer goes
 * out within ADD_ANSWER_MS, before the plugin host's cut-off.
 */

export const ACCESS_HELP =
  "macOS has not given “JobbyJobs Calendar Helper” access to calendars. On the Mac open System Settings → Privacy & Security → " +
  "Calendars and switch it on (Full Access), or press Allow access in Paseo's Calendar settings, then ask again.";

/** The earlier plugin's words, verbatim: ChatGPT has already learned what they mean. */
export const SYNC_NOTE =
  "Saved in Apple Calendar on this Mac and read back. macOS uploads it to the account in the background; EventKit does not report " +
  "whether the provider has accepted it, so provider sync is not confirmed here (check the provider's own calendar, or ask again in a minute).";

/**
 * The longest add_event and event_preview take to answer, counted from the call, whatever sync
 * does inside. The plugin host cuts an RPC off at 30 seconds, and God Mode then tells ChatGPT it
 * does not know whether the add took effect, which is the answer most likely to be retried. One
 * account whose helper is stuck holds every refresh for its 15-second read budget, and an add waits
 * for one refresh before it reads the day and for another after it writes (create() for up to
 * POST_WRITE_WAIT_MS, then range() for the rest of it), so a single stuck account is enough to
 * pass 30 seconds.
 *
 * At the cut-off the answer says what is true at that moment. If the add has not reached
 * create(), it says nothing was added, and the add then never calls create(). If it has, the
 * answer says the save is not confirmed and to check the calendar before adding it again. Either
 * way the add runs on behind its answer and keeps its place in the add queue below.
 */
export const ADD_ANSWER_MS = 25_000;
const SECONDS = ADD_ANSWER_MS / 1000;

/** The cut-off came while the add was still reading: nothing was written, and nothing will be. */
const READ_LATE =
  `the calendars on this Mac did not answer within ${SECONDS} seconds (an account may be slow or stuck), so the day could not ` +
  "be checked for a copy; nothing was added. Try again in a minute.";
/** The cut-off came while the add was still waiting behind an earlier one, which may be this same event. */
const QUEUED_LATE =
  `an earlier add was still running ${SECONDS} seconds after this request came in, so this one could not check the day for a ` +
  "copy; nothing was added by this request. Try again in a minute: if the earlier add saved this event, the answer then says " +
  "it is already there.";

/**
 * How long a real add waits for the refresh it starts before reading the day, and again after a
 * save that reported an error. Past it the add goes on to range(). The real sync's range() waits
 * on its own for a refresh in flight, so against createSync this cap does not make the add any
 * shorter. ADD_ANSWER_MS is what bounds the answer. This cap bounds only the assistant's own wait,
 * for a sync whose range() answers from what it holds.
 */
export const PRE_WRITE_WAIT_MS = 5_000;

/** What the assistant needs from sync, so a test can hand in its own. */
export type AssistantSync = Pick<Sync, "settings" | "range" | "create" | "refresh">;

type Added = NonNullable<AddEventAnswer["event"]>;

/** The day a gone account was first missed, in the zone; "" when that is not known. */
function missingDate(account: AccountView, zone: string): string {
  const ms = Date.parse(account.missingSince);
  return Number.isNaN(ms) ? "" : localDate(ms, zone);
}

/** One instruction per account that is not read in full, with the fix a person can make. */
function warningOf(account: AccountView, label: string, since: string): string {
  if (account.errorCode === "source_gone") {
    // A row macOS moved has its fix one tap away in Settings, and System Settings would not help.
    if (account.relinkTo) {
      return (
        `${label} is on this Mac under a new entry ("${account.relinkTo.title}"), so its events are NOT included yet. ` +
        "Fix: open Paseo's Calendar settings and accept the account found on this Mac for that row."
      );
    }
    return (
      `${label} is not on this Mac${since ? ` since ${since}` : ""}, so its events are NOT included. ` +
      "Fix: System Settings → Internet Accounts → that account → turn Calendars on (re-add the account if it was removed)."
    );
  }
  return account.errorCode ? `${label} could not be read: ${account.lastError || account.errorCode}` : "";
}

/**
 * Every connected account under its mailbox, each calendar marked with whether add_event can add
 * to it, then what the Mac has that Paseo does not read, then the warnings. The marks come from
 * the same targetsOf the add resolves against, so this list and the add cannot disagree.
 */
export async function answerCalendars(sync: Pick<Sync, "settings">, zone: string): Promise<CalendarsAnswer> {
  const settings = await sync.settings();
  if (settings.access !== "granted") {
    return { summary: "", access: settings.access, time_zone: zone, sources: [], not_connected: [], warnings: [], error: ACCESS_HELP };
  }

  const lines = [
    `Calendar access: granted. Time zone: ${zone}. [w] = add_event can add to it; [hidden] = switched off in Paseo, not read.`,
  ];
  const warnings: string[] = [];
  const sources = settings.accounts.map((account) => {
    const label = accountLabel(account);
    const kind = account.kind || "unknown";
    const gone = account.errorCode === "source_gone";
    // targetsOf keeps the account's calendar order, so index i is calendar i.
    const targets = targetsOf([account]);
    const calendars = account.calendars.map((calendar, index) => ({
      name: calendar.name,
      shown: calendar.shown,
      writable: targets[index].blocked === "",
    }));
    const names = calendars.map((calendar) => `${calendar.name}${calendar.writable ? " [w]" : calendar.shown ? "" : " [hidden]"}`);
    const since = missingDate(account, zone);
    const where = gone ? ` — not on this Mac${since ? ` since ${since}` : ""}` : "";
    lines.push(`- ${label} (${kind}): ${names.join(", ") || "no calendars"}${where}`);
    const warning = warningOf(account, label, since);
    if (warning) warnings.push(warning);
    return { account: label, title: account.title, kind, on_this_mac: !gone, calendars };
  });

  if (settings.found.length) {
    const found = settings.found.map((source) => `${source.title} (${source.kind || "unknown"})`);
    lines.push(`On this Mac, not connected in Paseo: ${found.join(", ")}.`);
  }
  lines.push(...warnings.map((warning) => `Warning: ${warning}`));

  return {
    summary: lines.join("\n"),
    access: settings.access,
    time_zone: zone,
    sources,
    not_connected: settings.found.map((source) => source.title),
    warnings,
    error: "",
  };
}

/**
 * Nothing was added. The summary says so in words as well as the status: a God Mode older than
 * 0.10 reads no `outcome`, announces any answer to an action as done, and reads the summary out.
 */
function refused(error: string): AddEventAnswer {
  return {
    ok: false,
    status: "refused",
    summary: `Not added: ${error}`,
    would_create: null,
    event: null,
    conflicts: [],
    provider_sync: "",
    error,
  };
}

/**
 * Saved, or perhaps saved, and not confirmed the way a clean save is. `ok` stays true: God Mode
 * takes false as "not done", and that invites the retry that adds a second copy.
 */
function unverified(summary: string, event: Added, conflicts: AddEventAnswer["conflicts"]): AddEventAnswer {
  return {
    ok: true,
    status: "saved_unverified",
    summary,
    would_create: null,
    event,
    conflicts,
    provider_sync: "not_confirmed",
    error: "",
  };
}

function planned(plan: PlannedEvent, zone: string, calendar: string, eventId = ""): Added {
  return {
    title: plan.title,
    date: plan.date,
    start: localTime(plan.startMs, zone),
    end: localTime(plan.endMs, zone),
    timezone: zone,
    calendar,
    ...(eventId ? { event_id: eventId } : {}),
  };
}

/** An event as it was read back, rather than as it was asked for. */
function presented(event: EventView, zone: string, calendar: string, eventId: string): Added {
  const startMs = Date.parse(event.start);
  return {
    title: event.title,
    date: localDate(startMs, zone),
    start: localTime(startMs, zone),
    end: localTime(Date.parse(event.end), zone),
    timezone: zone,
    calendar,
    event_id: eventId,
  };
}

function when(event: Added, zone: string): string {
  return `${oneLine(event.title)}, ${event.date} ${event.start}–${event.end} ${zone}`;
}

/**
 * The accounts other than the target that the day's read could not see, as one sentence, or "".
 * An overlap there is unknown, and "No overlaps" over a calendar nobody read is how somebody gets
 * double-booked. A failed account whose mailbox another account did read is not missing anything
 * (the schedule's own rule, sameMailbox); a failure that belongs to no account, such as the
 * settings file, is named as the problem it is.
 */
function unreadNote(day: EventsView, settings: SettingsView, targetAccountId: string): string {
  const failed = new Set(day.errors.map((entry) => entry.accountId));
  const read = settings.accounts.filter(
    (account) => !failed.has(account.id) && account.calendars.some((calendar) => calendar.shown),
  );
  const names: string[] = [];
  const problems: string[] = [];
  for (const entry of day.errors) {
    if (entry.accountId === targetAccountId) continue;
    const account = settings.accounts.find((candidate) => candidate.id === entry.accountId);
    if (!account) {
      problems.push(`Problem: ${failureNote(entry.code, entry.message, "")}.`);
      continue;
    }
    if (read.some((other) => sameMailbox(account, other))) continue;
    const name = oneLine(accountLabel(account));
    if (!names.includes(name)) names.push(name);
  }
  const unread = names.length ? `Not read: ${names.join("; ")} — overlaps there are unknown.` : "";
  return [unread, ...problems].filter(Boolean).join(" ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The adds, one at a time, across every caller. God Mode gives up on a call after 60 seconds and
 * tells ChatGPT it does not know whether it took effect, while this handler goes on; ChatGPT
 * retries with the same confirmation, which God Mode accepts for 120. range() waits for a refresh
 * in flight but not for a create in flight, so a retry reading the day beside the first call would
 * find no copy and add a second. Queued, its read comes after the first call's create and the
 * refresh create() waits for, finds the event, and answers already_exists.
 *
 * The queue holds each add's whole work, not its answer. An add answered at ADD_ANSWER_MS still
 * holds the next one until its create and its read-back are done, so the cut-off cannot let a
 * retry read the day before the first try's event is in it. Never rejects, so one failed add
 * cannot stall the ones behind it.
 */
let adding: Promise<unknown> = Promise.resolve();

/** How far one call has got, so that the answer at ADD_ANSWER_MS says what is true at that moment. */
interface Progress {
  /** Set at the cut-off. An add that has not called create() by then never calls it. */
  cancelled: boolean;
  /** The answer if the cut-off comes now. */
  late: () => AddEventAnswer;
}

/**
 * Whichever comes first, the work's own answer or ADD_ANSWER_MS. The cut-off sets `cancelled` and
 * reads `late` in one synchronous step, so the work cannot reach create() in between: it either
 * called create() before, and `late` already says so, or it finds `cancelled` set and stops.
 */
function answeredInTime(work: Promise<AddEventAnswer>, progress: Progress): Promise<AddEventAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutOff = new Promise<AddEventAnswer>((resolve) => {
    timer = setTimeout(() => {
      progress.cancelled = true;
      resolve(progress.late());
    }, ADD_ANSWER_MS);
  });
  return Promise.race([work, cutOff]).finally(() => clearTimeout(timer));
}

/**
 * Preview (dry_run) or add one timed event. Every check runs before anything is written, and in
 * the same order for both, so a preview that answered "Would create" is what the add will do —
 * unless the day changed in between, which the add then reads for itself. A preview writes
 * nothing, so it does not wait behind an add.
 *
 * Either one answers within ADD_ANSWER_MS of this call. Sync can be a promise of one: the daemon
 * hands in the one it is still starting, so that a slow first read counts against the same bound.
 */
export function answerAddEvent(
  sync: AssistantSync | PromiseLike<AssistantSync>,
  input: AddEventInput,
  nowMs: number,
  zone: string,
): Promise<AddEventAnswer> {
  const progress: Progress = { cancelled: false, late: () => refused(input.dry_run ? READ_LATE : QUEUED_LATE) };
  const work = async (): Promise<AddEventAnswer> => {
    progress.late = () => refused(READ_LATE);
    const ready = await sync;
    // Its answer has already gone out: it was queued behind a long add, or the daemon was slow to start.
    if (progress.cancelled) return progress.late();
    return addOrPreview(ready, input, nowMs, zone, progress);
  };
  if (input.dry_run) return answeredInTime(work(), progress);
  const run = adding.then(work);
  adding = run.catch(() => undefined);
  return answeredInTime(run, progress);
}

async function addOrPreview(
  sync: AssistantSync,
  input: AddEventInput,
  nowMs: number,
  zone: string,
  progress: Progress,
): Promise<AddEventAnswer> {
  // A throw before the write is still an answer: nothing was added, and saying so plainly keeps
  // God Mode from reporting "unknown whether it took effect", which invites a retry.
  let settings: SettingsView;
  try {
    settings = await sync.settings();
  } catch (error) {
    return refused(`could not read Paseo's Calendar settings: ${messageOf(error)}; nothing was added.`);
  }
  if (settings.access !== "granted") return refused(ACCESS_HELP);
  const plan = planEvent(input, nowMs, zone);
  if ("error" in plan) return refused(plan.error);
  const target = resolveTarget(targetsOf(settings.accounts), input.calendar);
  if ("error" in target) return refused(target.error);
  const label = oneLine(targetLabel(target));

  // The whole day, and past midnight when the event runs over it: a copy, and every overlap.
  const from = new Date(zonedMidnight(plan.date, zone));
  const to = new Date(Math.max(zonedMidnight(addDays(plan.date, 1), zone), plan.endMs));
  // Before a write, the day is read fresh rather than from the snapshot, which can be minutes old:
  // an event added on the phone since then must still be found as the copy it is. A preview reads
  // what is held, since it writes nothing. A refresh that fails leaves range() to decide. One still
  // running after PRE_WRITE_WAIT_MS is waited for by the real range() itself, within ADD_ANSWER_MS.
  if (!input.dry_run) await waitAtMost(sync.refresh(), PRE_WRITE_WAIT_MS);
  let day: EventsView;
  try {
    day = await sync.range(from, to);
  } catch (error) {
    return refused(`could not read ${label} to check for a copy first: ${messageOf(error)}; nothing was added.`);
  }
  // Not read means a copy there could not be seen: adding anyway is how a retry makes two.
  const failed = day.errors.find((entry) => entry.accountId === target.accountId);
  if (failed) return refused(`could not read ${label} to check for a copy first: ${failed.message}`);

  const existing = day.events.find((event) => isSameAdded(event, target, plan));
  if (existing) {
    const event = presented(existing, zone, label, existing.id);
    return {
      ok: true,
      status: "already_exists",
      summary: `Already in ${label}: ${when(event, zone)}. Nothing new was created.`,
      would_create: null,
      event,
      conflicts: [],
      provider_sync: "",
      error: "",
    };
  }

  const owners = new Map(settings.accounts.map((account) => [account.id, accountLabel(account)] as const));
  const conflicts = overlapsOf(day.events, plan).map((event) => ({
    title: event.title,
    start: localTime(Date.parse(event.start), zone),
    end: localTime(Date.parse(event.end), zone),
    calendar: `${event.calendarName} (${owners.get(event.accountId) ?? "unknown account"})`,
  }));
  const unread = unreadNote(day, settings, target.accountId);
  const conflictText =
    (conflicts.length
      ? ` Overlaps: ${conflicts.map((item) => `${oneLine(item.title)} ${item.start}–${item.end} [${oneLine(item.calendar)}]`).join("; ")}.`
      : unread
        ? " No overlaps in the calendars read."
        : " No overlaps.") + (unread ? ` ${unread}` : "");

  const preview = planned(plan, zone, label);
  if (input.dry_run) {
    return {
      ok: true,
      status: "dry_run",
      summary: `Would create: ${when(preview, zone)} in ${label}.${conflictText}`,
      would_create: preview,
      event: null,
      conflicts,
      provider_sync: "",
      error: "",
    };
  }

  // The cut-off came while the day was being read, and that answer said nothing was added. This
  // check, the switch of `late` and the call to create() run in one synchronous step.
  if (progress.cancelled) return progress.late();
  progress.late = () =>
    unverified(
      `Saving to ${label} had not answered after ${SECONDS} seconds, so it is not confirmed: ${when(preview, zone)}. ` +
        "Check that calendar before adding it again.",
      preview,
      conflicts,
    );
  const result = await sync
    .create({
      accountId: target.accountId,
      calendarId: target.calendarId,
      title: plan.title,
      start: new Date(plan.startMs).toISOString(),
      end: new Date(plan.endMs).toISOString(),
      description: "",
    })
    .catch((error: unknown) => ({ event: null, error: messageOf(error) }));
  if (result.error) {
    // A helper that timed out may have saved anyway, and create() skips its refresh after an
    // error, so the snapshot cannot say. A fresh pass, waited for no longer than the one before
    // the write, and a second read decide: "nothing added" while the event is there is exactly
    // the answer that makes ChatGPT add it again. For the same reason a cut-off during that read
    // does not say "nothing added" either.
    progress.late = () =>
      unverified(
        `Saving to ${label} reported an error (${result.error}), and the read that would show whether it was saved anyway ` +
          `did not finish within ${SECONDS} seconds. Check that calendar before adding it again.`,
        preview,
        conflicts,
      );
    await waitAtMost(sync.refresh(), PRE_WRITE_WAIT_MS);
    const again = await sync.range(from, to).catch(() => null);
    const landed = again?.events.find((event) => isSameAdded(event, target, plan));
    if (!landed) return refused(result.error);
    const event = presented(landed, zone, label, landed.id);
    return unverified(
      `Saving to ${label} reported an error (${result.error}), but it is there now: ${when(event, zone)}. ` +
        "Check that calendar before adding it again.",
      event,
      conflicts,
    );
  }

  // create() waited for its refresh for at most POST_WRITE_WAIT_MS, and range() waits for
  // whatever of that refresh is still running, so the new event is in what this reads. If that
  // takes past ADD_ANSWER_MS, the answer has already gone out as unverified. A read that fails
  // here is reported as unverified too, never as a failure: the event was saved, and an answer
  // that says otherwise is what makes ChatGPT add it a second time.
  const createdId = result.event?.id ?? "";
  progress.late = () =>
    unverified(
      `Saved in ${label}, but reading it back did not finish within ${SECONDS} seconds. Check that calendar before adding it again.`,
      planned(plan, zone, label, createdId),
      conflicts,
    );
  const back = await sync.range(from, to).catch(() => null);
  const found = back
    ? ((createdId ? back.events.find((event) => event.accountId === target.accountId && event.id === createdId) : undefined) ??
      back.events.find((event) => isSameAdded(event, target, plan)))
    : undefined;
  if (!found) {
    return unverified(
      `Saved in ${label}, but reading it back did not find it. Check that calendar before adding it again.`,
      planned(plan, zone, label, createdId),
      conflicts,
    );
  }
  // A row kept from another account's copy carries that copy's id; the one create() named is the target's.
  const event = presented(found, zone, label, createdId || found.id);
  return {
    ok: true,
    status: "saved_locally_verified",
    // SYNC_NOTE last: God Mode cuts an answer at 800 characters, and this is the part to lose first.
    summary: `Created in ${label}: ${when(event, zone)}. Verified by reading it back from Apple Calendar.${conflictText} ${SYNC_NOTE}`,
    would_create: null,
    event,
    conflicts,
    provider_sync: "not_confirmed",
    error: "",
  };
}
