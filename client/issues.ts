import { accountLabel } from "../shared/accounts.ts";
import type { AccountView, ErrorCode, EventsView } from "../shared/calendar.ts";
import type { Strings } from "../shared/i18n.ts";

/**
 * What the board and Settings say about a failure, decided by its code and never by its words.
 * The message beside a code is written for the log, in English, and is quoted only where no
 * code explains it: matching its text would break the day a server message is reworded.
 */

/** The pane the macOS refusal sends people to, rather than describing the route to it. */
export const PRIVACY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";

/**
 * Whether PRIVACY_URL can open here: in the desktop app, which is a web build running on the Mac.
 * A phone cannot open the scheme, and the setting lives on the Mac anyway, so there the banner
 * says where to do it instead of offering a button that does nothing.
 */
export function privacyActionAvailable(platformOS: string): boolean {
  return platformOS === "web";
}

export type IssueAction = { kind: "relink"; accountId: string; sourceId: string } | { kind: "privacy" } | null;

export interface Issue {
  key: string;
  tone: "info" | "warn" | "bad";
  text: string;
  action: IssueAction;
  actionLabel: string;
}

/**
 * The name of the copy a broken store was set aside as, when the message carries one, else "".
 * store.ts adds `-2` and up to a name already taken in the same second; that suffix is part of
 * the copy's name. Nothing else in a message looks like this, and only a name found here is ever
 * claimed as a copy: telling somebody a copy is kept when none is would make deleting the only
 * one look safe.
 */
export function asideName(text: string): string {
  return /[^\s/]*\.broken-\d{8}T\d{6}(?:-\d+)?/.exec(text)?.[0] ?? "";
}

/** One code in words. `label` names the account; "" when no row is known for it. */
export function issueText(code: ErrorCode, message: string, label: string, strings: Strings): string {
  switch (code) {
    case "source_gone":
      return strings.issueGone(label);
    case "access_needed":
      return strings.calendarAccessRefused;
    case "macos_required":
      return strings.issueMacos;
    case "helper_failed":
      return strings.issueHelper(message);
    case "store_broken":
      return strings.issueStoreBroken(asideName(message));
    case "unknown":
    case "":
      return label ? strings.issueAccount(label, message) : strings.syncIssue(message);
  }
}

/**
 * What an account row says went wrong, or "". A gone source says nothing here: the row's own
 * subtitle names the day it went, and its relink banner, when there is one, says where it went.
 */
export function rowProblem(
  account: Pick<AccountView, "errorCode" | "lastError" | "owner" | "title">,
  strings: Strings,
): string {
  if (account.errorCode === "" || account.errorCode === "source_gone") return "";
  return issueText(account.errorCode, account.lastError, accountLabel(account), strings);
}

/** Said once whatever number of accounts reported them: each is about this Mac, not one account. */
const MACHINE_WIDE: Partial<Record<ErrorCode, Issue["tone"]>> = {
  access_needed: "warn",
  macos_required: "bad",
  helper_failed: "bad",
  store_broken: "bad",
};

/**
 * The board's banners, in the order the errors came. A source that is simply gone is not one of
 * them: the tick reports it every five minutes, and a banner that never leaves is one nobody
 * reads, so the board speaks only when there is something to do (a relink) and Settings keeps
 * the quiet grey row. This is the one place that rule lives.
 */
export function boardIssues(
  errors: EventsView["errors"],
  accounts: readonly AccountView[],
  strings: Strings,
): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const push = (issue: Issue) => {
    if (seen.has(issue.key)) return;
    seen.add(issue.key);
    issues.push(issue);
  };
  for (const error of errors) {
    const row = accounts.find((account) => account.id === error.accountId);
    const label = row ? accountLabel(row) : "";
    if (error.code === "source_gone") {
      if (!row?.relinkTo) continue;
      push({
        key: `relink:${row.id}`,
        tone: "warn",
        text: strings.issueMoved(label),
        action: { kind: "relink", accountId: row.id, sourceId: row.relinkTo.sourceId },
        actionLabel: strings.relinkOffer(row.relinkTo.title),
      });
      continue;
    }
    const tone = MACHINE_WIDE[error.code];
    if (tone) {
      const privacy = error.code === "access_needed";
      push({
        key: error.code,
        tone,
        // The first message wins for helper_failed: one helper, one reason, however many asked.
        text: issueText(error.code, error.message, "", strings),
        action: privacy ? { kind: "privacy" } : null,
        actionLabel: privacy ? strings.openPrivacy : "",
      });
      continue;
    }
    push({
      key: `account:${error.accountId}`,
      tone: "warn",
      text: issueText(error.code, error.message, label, strings),
      action: null,
      actionLabel: "",
    });
  }
  return issues;
}

/**
 * Whether the board's copy of Settings is due a re-read, given the events snapshot's `syncedAt`
 * it last saw and the one it sees now. boardIssues joins live errors to the rows in that copy,
 * and nothing else refreshes it on the board: without this, a source macOS re-added while the
 * board was open would report `source_gone` against a cached row with no `relinkTo`, and its
 * meetings would vanish with no banner. Once per tick (when `syncedAt` moves) rather than on a
 * timer, because a Settings read can launch the helper. Never on the first sight, when the
 * settings query is already fetching on mount.
 */
export function settingsStale(prev: string | undefined, next: string | undefined): boolean {
  return prev !== undefined && next !== undefined && next !== prev;
}
