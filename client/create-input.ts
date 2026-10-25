import { readOnlyKind } from "../shared/accounts.ts";
import type { AccountView } from "../shared/calendar.ts";
import { dateOfWallClock, parseWallClock } from "../shared/wallclock.ts";

/**
 * Everything calendar.create takes, described structurally rather than derived from the
 * contract's Zod schema. A type-only import of shared/calendar.ts is erased under
 * verbatimModuleSyntax, which is what lets this module — and its tests — run under
 * `node --test` without pulling Zod or the plugin SDK in behind it. The call site passes
 * these straight to the RPC, so the compiler still checks the two agree.
 */
export interface CreateFields {
  accountId: string;
  calendarId: string;
  title: string;
  /** RFC 3339, UTC. */
  start: string;
  /** RFC 3339, UTC. */
  end: string;
  description: string;
}

/** The form's fields exactly as a person typed them, before any of it is believed. */
export interface CreateDraft {
  accountId: string;
  calendarId: string;
  title: string;
  /** A wall clock, "YYYY-MM-DDTHH:mm", read in the client's own time zone. */
  start: string;
  /** Whole minutes. */
  duration: string;
  description: string;
}

export type CreateProblem = "calendar" | "title" | "start" | "duration";

export type BuiltCreate = { ok: true; fields: CreateFields } | { ok: false; problems: CreateProblem[] };

/** Only what a picker needs; the rest of AccountView is not this module's business. */
export type AccountChoice = Pick<AccountView, "id" | "kind" | "errorCode" | "calendars">;

export interface Selection {
  accountId: string;
  calendarId: string;
}

const QUARTER_MS = 15 * 60_000;

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** The next quarter hour strictly after `now`, as the start field's own text format, so the
 *  field opens on a time that is still ahead rather than one that has just gone. */
export function defaultStartText(now: Date): string {
  const slot = new Date(Math.floor(now.getTime() / QUARTER_MS) * QUARTER_MS + QUARTER_MS);
  return `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}T${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
}

/**
 * Turns the form into the RPC's input, or into every reason it cannot be. EventKit's
 * ISO8601DateFormatter parses the instant, not the wall clock — it reads a UTC instant back
 * as the local time it names — so the conversion happens once, here, rather than being left
 * to the store that receives it.
 */
export function buildCreateInput(draft: CreateDraft): BuiltCreate {
  const problems: CreateProblem[] = [];
  if (!draft.accountId || !draft.calendarId) problems.push("calendar");

  const title = draft.title.trim();
  if (!title) problems.push("title");

  const startWall = parseWallClock(draft.start);
  const start = startWall ? dateOfWallClock(startWall) : null;
  if (!start) problems.push("start");

  const duration = /^\d+$/.test(draft.duration.trim()) ? Number(draft.duration.trim()) : 0;
  if (duration <= 0) problems.push("duration");

  if (problems.length > 0 || !start) return { ok: false, problems };

  return {
    ok: true,
    fields: {
      accountId: draft.accountId,
      calendarId: draft.calendarId,
      title,
      start: start.toISOString(),
      end: new Date(start.getTime() + duration * 60_000).toISOString(),
      description: draft.description.trim(),
    },
  };
}

/**
 * The accounts a new event can be written to: not a subscribed or birthday source, not one the
 * Mac no longer lists, and one with a calendar to put it in. A calendar switched off in Settings
 * stays a target (it is an agenda preference, not a permission), so `shown` is not read here.
 */
export function writableAccounts<T extends AccountChoice>(accounts: readonly T[]): T[] {
  return accounts.filter(
    (entry) => !readOnlyKind(entry.kind) && entry.errorCode !== "source_gone" && entry.calendars.length > 0,
  );
}

/**
 * The account and calendar actually in force, given whatever the picker last held. Derived
 * on every render rather than stored, so a calendar id left over from another account can
 * never reach createEvent — writing to a calendar the chosen account does not own is the
 * one mistake this picker can make that a user would not notice until afterwards. Takes the
 * list writableAccounts already filtered, so every entry here is one that can be written to.
 */
export function pickSelection(accounts: readonly AccountChoice[], wanted: Selection): Selection {
  if (accounts.length === 0) return { accountId: "", calendarId: "" };
  const account = accounts.find((entry) => entry.id === wanted.accountId) ?? accounts[0]!;
  const calendars = account.calendars;
  // `shown` is an agenda preference, not a permission: a calendar hidden from the board is
  // still a legitimate place to put something, so it is only ever the last choice.
  const calendar =
    calendars.find((entry) => entry.id === wanted.calendarId) ??
    calendars.find((entry) => entry.shown) ??
    calendars[0];
  return { accountId: account.id, calendarId: calendar?.id ?? "" };
}

/**
 * True when the selected calendar exists and is switched off in Settings. The board reads shown
 * calendars only, so an event written to a hidden one lands where the board does not show it,
 * and the confirmation says so before it is written (ChatGPT's add_event refuses a hidden
 * calendar outright; here it is allowed, and told).
 */
export function isHiddenTarget(accounts: readonly AccountChoice[], selection: Selection): boolean {
  const account = accounts.find((entry) => entry.id === selection.accountId);
  const calendar = account?.calendars.find((entry) => entry.id === selection.calendarId);
  return calendar?.shown === false;
}

/** Why a save failed, as far as the form words it differently. */
export type CreateFailure = "read_only" | "calendar_missing" | "other";

/**
 * Sorts a failed create's message into the cases the form has its own copy for. The read-only
 * texts are EventKit's own localized ones for its read-only and no-new-events save errors, read
 * from EventKit.framework/Resources/Localizable.loctable, plus the server guard's own message.
 * Only the English, Russian and Ukrainian texts are matched: on a Mac in any other language the
 * same refusal falls to "other" and is shown as createFailed with EventKit's own words. The
 * calendar-missing one is the helper's `create` refusal.
 */
export function classifyCreateError(message: string): CreateFailure {
  if (
    /read[- ]only|does not allow events to be added|только для чтения|не предусматривает добавление событий|лише для перегляду|не дозволяє додавання подій/i.test(
      message,
    )
  ) {
    return "read_only";
  }
  if (/calendar not found/i.test(message)) return "calendar_missing";
  return "other";
}

/**
 * How a create ended, as far as the form can tell. An answer with an error is the daemon saying
 * nothing was written. No answer at all is different: the daemon writes, refreshes and only then
 * answers, so a connection lost in between (the phone over the relay, the host's 30 s cut-off)
 * loses only the answer, and a plain retry would make a second real event.
 */
export function createOutcome(ended: { answer?: { error: string }; thrown?: unknown }): "created" | "refused" | "uncertain" {
  if (!ended.answer) return "uncertain";
  return ended.answer.error ? "refused" : "created";
}
