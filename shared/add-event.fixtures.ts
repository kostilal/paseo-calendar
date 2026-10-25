import type { AccountView, EventView } from "./calendar.ts";

/**
 * Fixtures shared by shared/add-event.test.ts and server/assistant.test.ts, so both read the
 * same accounts and the same meeting. Not a test file: node's runner only picks up `.test.`.
 */

export const ZONE = "Europe/Warsaw";
export const NOW = Date.parse("2026-10-25T09:00:00.000Z"); // Sunday 10:00 in Warsaw, CET since 03:00
export function account(over: Partial<AccountView>): AccountView {
  return { id: "", sourceId: "", title: "", owner: "", kind: "", calendars: [], lastSyncAt: "", lastError: "",
    errorCode: "", missingSince: "", relinkTo: null, ...over };
}
export const ACCOUNTS: AccountView[] = [
  account({ id: "ex", sourceId: "s-ex", title: "Exchange", owner: "me@example.com", kind: "exchange",
    calendars: [{ id: "c-ex", name: "Calendar", shown: true }, { id: "c-bd", name: "Birthdays", shown: false }] }),
  account({ id: "ic", sourceId: "s-ic", title: "iCloud", kind: "icloud",
    calendars: [{ id: "c-home", name: "Home", shown: true }, { id: "c-ic", name: "Calendar", shown: true }] }),
  account({ id: "old", sourceId: "s-old", title: "Google", owner: "me@example.org", kind: "caldav", errorCode: "source_gone",
    missingSince: "2026-10-20T08:00:00.000Z", calendars: [{ id: "c-w", name: "Work", shown: true }] }),
];
export function meeting(over: Partial<EventView>): EventView {
  return { id: "e1", accountId: "ex", calendarId: "c-ex", calendarName: "Calendar", title: "Dentist",
    start: "2026-10-27T09:00:00.000Z", end: "2026-10-27T09:30:00.000Z", allDay: false, recurring: false, mine: true,
    attendees: [], location: "", description: "", webLink: "", myResponse: "accepted", joinUrl: "", joinKind: "none",
    alsoIn: [], ...over };
}
