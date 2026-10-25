import { accountLabel } from "../shared/accounts.ts";
import type { AccessState, AccountView, ConnectJob, ErrorCode, SourceView } from "../shared/calendar.ts";
import type { Strings } from "../shared/i18n.ts";
import { ERROR_RETRY_MS, dayKey, formatClock, formatStamp } from "../shared/period.ts";

export { ERROR_RETRY_MS };

/**
 * What the Settings screen says about each account, worked out apart from drawing it so every
 * rule here can be tested without a renderer.
 */

/** The tone of a row's dot: StatusDot's own four. */
export type Health = "ok" | "idle" | "warn" | "bad";

// Product names, so the same in every locale: they are what each service calls itself.
const EXCHANGE = "Exchange";
const ICLOUD = "iCloud";
const GOOGLE = "Google";
const CALDAV = "CalDAV";

/**
 * The kind of a source in words. macOS files Google and iCloud both under CalDAV, so the title
 * (and, for a Google account renamed by hand, the mailbox) is what tells them apart.
 */
export function kindWords(source: { kind: string; title: string; owner?: string }, strings: Strings): string {
  switch (source.kind) {
    case "exchange":
      return EXCHANGE;
    case "icloud":
      return ICLOUD;
    case "caldav":
      if (/icloud/i.test(source.title)) return ICLOUD;
      if (/google|gmail/i.test(source.title) || /@(gmail|googlemail)\.com$/i.test(source.owner ?? "")) return GOOGLE;
      return CALDAV;
    case "local":
      return strings.kindLocal;
    case "subscribed":
      return strings.kindSubscribed;
    case "birthdays":
      return strings.kindBirthdays;
    default:
      return strings.kindOther;
  }
}

/**
 * Decided by the error code and by what the row shows, never by a "connected" flag. A row whose
 * source is gone is quiet grey unless there is somewhere to move it, which is worth a warning.
 */
export function healthOf(account: Pick<AccountView, "errorCode" | "missingSince" | "calendars" | "relinkTo">): Health {
  if (account.missingSince !== "") return account.relinkTo ? "warn" : "idle";
  switch (account.errorCode) {
    case "access_needed":
    case "macos_required":
      return "warn";
    case "helper_failed":
    case "unknown":
    case "store_broken":
      return "bad";
  }
  if (!account.calendars.some((calendar) => calendar.shown)) return "idle";
  return "ok";
}

/** "Oct 20, 2026": a day without a time, for how long a source has been gone. */
export function formatDay(iso: string, locale: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

export interface AccountRowModel {
  id: string;
  label: string;
  subtitle: string;
  health: Health;
  /** Drawn faded: the source is gone and nothing on this Mac could take its place. */
  greyed: boolean;
  relink: { sourceId: string; title: string } | null;
  /**
   * A row with no stored calendars is never read and never listed under Found, so without this
   * offer the only repair would be Disconnect, then Add. Only while its source is on this Mac:
   * a connect to a gone source would only fail.
   */
  reread: boolean;
}

export function accountRow(account: AccountView, strings: Strings, locale: string): AccountRowModel {
  const gone = account.missingSince !== "";
  const shown = account.calendars.filter((calendar) => calendar.shown).length;
  return {
    id: account.id,
    label: accountLabel(account),
    subtitle: gone
      ? strings.notOnMacSince(formatDay(account.missingSince, locale))
      : `${kindWords(account, strings)} · ${strings.calendarsShown(shown, account.calendars.length)}`,
    health: healthOf(account),
    greyed: gone && account.relinkTo === null,
    relink: account.relinkTo && { sourceId: account.relinkTo.sourceId, title: account.relinkTo.title },
    reread: account.calendars.length === 0 && account.sourceId !== "" && !gone,
  };
}

/** The most recent clean read across every row, or "" when none was ever read. */
export function latestSync(accounts: readonly Pick<AccountView, "lastSyncAt">[]): string {
  let latest = "";
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const { lastSyncAt } of accounts) {
    const ms = Date.parse(lastSyncAt);
    if (Number.isNaN(ms) || ms <= latestMs) continue;
    latest = lastSyncAt;
    latestMs = ms;
  }
  return latest;
}

/**
 * The screen's one "Updated" line. A clock alone on yesterday's read would present stale data as
 * fresh, so anything not from today carries its date as well.
 */
export function updatedText(
  accounts: readonly Pick<AccountView, "lastSyncAt">[],
  nowMs: number,
  strings: Strings,
  locale: string,
): string {
  const latest = latestSync(accounts);
  if (!latest) return "";
  const when = new Date(latest);
  const sameDay = dayKey(when) === dayKey(new Date(nowMs));
  return strings.lastSync(sameDay ? formatClock(when, locale) : formatStamp(when, locale));
}

/**
 * How many reads "unknown" is polled for. The status read at daemon start takes about a second,
 * so thirty seconds is plenty; past that, "unknown" is a read that failed or a Mac nobody has
 * asked since the helper was rebuilt, and only Allow access changes it (or the next tick, once it
 * lists sources). Polling it forever cost a settings read every 1.5 s while the screen was open.
 */
export const UNKNOWN_POLL_READS = 20;

/**
 * Polled only while something is in flight: a connect and a permission dialog both finish on
 * their own schedule and neither can report back through the RPC that started it. "unknown"
 * with rows is a status read still on its way, for the first UNKNOWN_POLL_READS reads; with no
 * rows it means nobody has asked yet, and polling it would never stop. A read that failed, and a
 * list of this Mac's accounts that failed, are asked again more slowly, because the screen says
 * they are being retried. `reads` is how many answers this screen has had (react-query's
 * dataUpdateCount); `failed` that the last read rejected.
 */
export function settingsPollMs(
  view:
    | {
        connect: { state: "running" | "failed" | "done" } | null;
        access: AccessState;
        accounts: readonly unknown[];
        foundFailed?: boolean;
      }
    | undefined,
  state: { failed?: boolean; reads?: number } = {},
): number | false {
  if (state.failed) return ERROR_RETRY_MS;
  if (!view) return false;
  if (view.connect?.state === "running") return 1500;
  if (view.access === "asking") return 1500;
  if (view.access === "unknown" && view.accounts.length > 0 && (state.reads ?? 0) < UNKNOWN_POLL_READS) return 1500;
  if (view.foundFailed) return ERROR_RETRY_MS;
  return false;
}

/**
 * A connect this screen watched has just finished well. The daemon marks it done once its
 * snapshot has the new row's meetings, so this is the moment the board and the pill are told to
 * read again; a job already done when the screen opened is not news.
 */
export function connectFinished(previous: string | undefined, next: string | undefined): boolean {
  return previous === "running" && next === "done";
}

/** A found source's second line: its kind and how many calendars it holds. */
export function foundDetail(source: Pick<SourceView, "kind" | "title" | "calendars">, strings: Strings): string {
  return `${kindWords(source, strings)} · ${strings.calendarCount(source.calendars)}`;
}

/** What identifies one failed connect, so a later visit to Settings can tell it was shown; "". */
export function connectFailureKey(job: ConnectJob | null | undefined): string {
  return job?.state === "failed" ? `${job.sourceId}|${job.code}|${job.error}` : "";
}

/**
 * The banner for a connect that failed, or null. The daemon keeps the job until the next connect,
 * so without `seen` a failure from Monday would greet every visit for the rest of the week; it is
 * shown on the visit that saw it happen (or the first one after) and not again. It names the
 * account: a found source by its title, a row being read again by its label. A refusal because
 * the store is broken is already the store banner's to say.
 */
export function connectIssue(
  job: ConnectJob | null | undefined,
  accounts: readonly Pick<AccountView, "sourceId" | "owner" | "title">[],
  found: readonly Pick<SourceView, "id" | "title">[],
  shown: { seen: boolean; storeBanner: boolean },
): { code: ErrorCode; message: string; label: string } | null {
  if (job?.state !== "failed" || shown.seen) return null;
  if (job.code === "store_broken" && shown.storeBanner) return null;
  const source = found.find((entry) => entry.id === job.sourceId);
  const row = accounts.find((entry) => entry.sourceId === job.sourceId);
  const label = source?.title ?? (row ? accountLabel(row) : "");
  return { code: job.code, message: job.error, label };
}
