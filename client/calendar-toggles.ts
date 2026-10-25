/** One chip's wish: this calendar of this account should read `shown`. */
export interface CalendarToggle {
  accountId: string;
  calendarId: string;
  shown: boolean;
}

/** `"<accountId>:<calendarId>"`: the key a chip's pending state and its row error share. */
export function toggleKey(toggle: Pick<CalendarToggle, "accountId" | "calendarId">): string {
  return `${toggle.accountId}:${toggle.calendarId}`;
}

/**
 * The view as it reads once the toggles are in. Only the accounts and calendars a toggle names
 * are copied, so every other row keeps its identity, and a view nothing matched comes back as
 * the very same object. It is the one way the settings cache is written for a calendar chip:
 * forward for the optimistic change, forward again over the server's answer for the toggles
 * still in flight, and inverted to roll one back, so a neighbouring chip's change survives any
 * of them.
 */
export function applyToggles<A extends { id: string; calendars: { id: string; name: string; shown: boolean }[] }, V extends { accounts: A[] }>(
  view: V,
  toggles: readonly CalendarToggle[],
): V {
  let changed = false;
  const accounts = view.accounts.map((account) => {
    // Later toggles of one calendar win, as they would applied one after another.
    const wanted = new Map<string, boolean>();
    for (const toggle of toggles) if (toggle.accountId === account.id) wanted.set(toggle.calendarId, toggle.shown);
    if (wanted.size === 0) return account;
    let touched = false;
    const calendars = account.calendars.map((calendar) => {
      const shown = wanted.get(calendar.id);
      if (shown === undefined || shown === calendar.shown) return calendar;
      touched = true;
      return { ...calendar, shown };
    });
    if (!touched) return account;
    changed = true;
    return { ...account, calendars };
  });
  return changed ? { ...view, accounts } : view;
}
