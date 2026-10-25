export type Response = "accepted" | "declined" | "tentative" | "unknown";

export interface Attendee {
  name: string;
  email: string;
  response: Response;
  /** The account holder themselves. */
  self: boolean;
  organiser: boolean;
}

export interface Event {
  id: string;
  accountId: string;
  calendarId: string;
  calendarName: string;
  title: string;
  /** RFC 3339 in UTC for timed events; a bare YYYY-MM-DD for all-day ones. */
  start: string;
  /**
   * Same shape as `start`. For an all-day event this is EXCLUSIVE — the day after the last
   * day the event actually covers — never the last day itself. EventKit's inclusive end is
   * pushed forward one day by eventkit.ts's toExclusiveEnd before it reaches here. groupByDay
   * relies on this to expand a multi-day all-day event across every day it covers, not just
   * its first.
   */
  end: string;
  allDay: boolean;
  /**
   * One occurrence of a repeating series, rather than a meeting of its own.
   *
   * Editing is offered only for the one-off kind: changing an occurrence and changing the
   * series are different operations, EventKit makes you say which at save time, and guessing
   * wrong rewrites every future occurrence of a standup. Naming the state is what lets the
   * card refuse honestly instead of the button being greyed for no stated reason.
   */
  recurring: boolean;
  /**
   * You are the one who called this meeting.
   *
   * Editing is offered only for your own: changing somebody else's meeting through their
   * calendar is not what the button looks like it does.
   *
   * An event with no attendees at all is yours by construction — it is time you blocked out,
   * not a meeting anyone was called to.
   */
  mine: boolean;
  attendees: Attendee[];
  location: string;
  description: string;
  webLink: string;
  myResponse: Response;
}
