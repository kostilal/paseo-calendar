/**
 * Pure rules about accounts: when a stored one has moved to a new macOS source, which calendars
 * stay hidden across that move, and what to call a row.
 *
 * macOS can re-add the same mailbox under a new source id (and a new id for each calendar in
 * it), after which the stored row points at a source that is gone. Matching the new source to
 * the old row is by its title and kind, then confirmed by the calendar names, and the result is
 * only ever an offer, never an automatic relink: a wrong one would show another account's
 * meetings under this row, and nothing on screen would say so. So every rule below leans toward
 * answering null, and two equally good matches are no match.
 */

/** What a stored account contributes to the match: where it was, what it was called, what it held. */
export interface RelinkAccount {
  sourceId: string;
  title: string;
  /** Empty for a row migrated from before kinds were stored; it then matches on title alone. */
  kind: string;
  calendars: readonly { name: string }[];
}

interface Matchable {
  id: string;
  title: string;
  kind: string;
}

/**
 * The one live source this account may have moved to, judged without its calendar names, which
 * sync does not have until it has chosen which source to ask. Null unless the row's own source
 * is gone from the Mac, the row has calendars to confirm by under names that tell them apart,
 * and exactly one source nobody reads matches its title (and its kind, when it knows one).
 */
export function relinkSuspect<S extends Matchable>(
  account: RelinkAccount,
  live: readonly S[],
  connectedSourceIds: ReadonlySet<string>,
): S | null {
  if (live.some((source) => source.id === account.sourceId)) return null;
  if (account.calendars.length === 0) return null;
  const stored = new Set(account.calendars.map((calendar) => calendar.name));
  if (stored.size !== account.calendars.length) return null;

  const title = account.title.trim();
  const matches = live.filter(
    (source) =>
      !connectedSourceIds.has(source.id) &&
      source.title.trim() === title &&
      (account.kind === "" || source.kind === account.kind),
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * The suspect, once its calendars are known: every stored calendar name must be in the source
 * exactly once. Extra calendars on the source are fine (a new one was added meanwhile); a
 * repeated name is not, because it could not say which copy is which.
 */
export function relinkCandidate<S extends Matchable>(
  account: RelinkAccount,
  live: readonly S[],
  connectedSourceIds: ReadonlySet<string>,
  candidateCalendarNames: readonly string[],
): S | null {
  const suspect = relinkSuspect(account, live, connectedSourceIds);
  if (!suspect) return null;
  const seen = new Map<string, number>();
  for (const name of candidateCalendarNames) seen.set(name, (seen.get(name) ?? 0) + 1);
  return account.calendars.every((calendar) => seen.get(calendar.name) === 1) ? suspect : null;
}

/**
 * The fresh calendars in their own order and under their fresh ids, each keeping whether it was
 * shown. Ids change across a move, names do not, so names are the thread. A name the old list
 * never had is shown; a name the old copies disagreed about is shown too, since hiding on a
 * guess would silently drop meetings.
 */
export function carryShown(
  old: readonly { id: string; name: string; shown: boolean }[],
  fresh: readonly { id: string; name: string }[],
): { id: string; name: string; shown: boolean }[] {
  const byName = new Map<string, boolean>();
  const disagreed = new Set<string>();
  for (const calendar of old) {
    const before = byName.get(calendar.name);
    if (before !== undefined && before !== calendar.shown) disagreed.add(calendar.name);
    byName.set(calendar.name, calendar.shown);
  }
  return fresh.map((calendar) => ({
    id: calendar.id,
    name: calendar.name,
    shown: disagreed.has(calendar.name) ? true : (byName.get(calendar.name) ?? true),
  }));
}

/** How a row is named: by its mailbox once learned, else by what macOS calls it. */
export function accountLabel(account: { owner: string; title: string }): string {
  return account.owner.trim() || account.title;
}

/**
 * EventKit's subscribed and birthday sources never accept a new event. Per-calendar writability
 * is not knowable here: the helper's `calendars` emits only `{id, name}`, and the Swift is
 * frozen. A read-only calendar inside a writable account is caught at save time instead.
 */
export const READ_ONLY_KINDS: readonly string[] = ["subscribed", "birthdays"];

export function readOnlyKind(kind: string): boolean {
  return READ_ONLY_KINDS.includes(kind);
}
