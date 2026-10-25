import type { EventView } from "../shared/calendar.ts";
import type { Strings } from "../shared/i18n.ts";

/**
 * What the card offers on a meeting you organise, worked out apart from drawing it so the rule
 * can be tested without a renderer.
 *
 * `held` is whether the meeting is in the board's events snapshot: the fortnight the daemon keeps,
 * from local midnight today to fourteen days on. The server changes or deletes only a meeting it
 * can find there (server/sync.ts update and remove), so a meeting opened from a past day or a
 * month ahead would be refused every time, however often the user refreshed; it is sent to
 * Calendar instead of being offered buttons that cannot work.
 *
 * A series is neither edited nor deleted: only the whole of it could be. An all-day event can be
 * deleted but not edited: the form's start and duration are instants, and saving would write its
 * bare dates back as UTC midnights, which moves the event a day west of Greenwich and stretches it
 * over two days east of it.
 */
export interface OwnActions {
  /** The Edit and Delete row is drawn at all. */
  offered: boolean;
  /** Edit is enabled (it is drawn, greyed, whenever the row is). */
  edit: boolean;
  /** Delete is drawn. */
  remove: boolean;
  /** Why something is not offered, each said once under the buttons. */
  notes: ("outside" | "series" | "allDay")[];
}

export function ownActions(event: Pick<EventView, "recurring" | "allDay">, held: boolean): OwnActions {
  if (!held) return { offered: false, edit: false, remove: false, notes: ["outside"] };
  return {
    offered: true,
    edit: !event.recurring && !event.allDay,
    remove: !event.recurring,
    notes: event.recurring ? ["series"] : event.allDay ? ["allDay"] : [],
  };
}

/**
 * A meeting somebody else organised and sent to you: the one kind of event for which "macOS
 * cannot answer invitations" means anything. A holiday or a birthday has no guests, and your own
 * CalDAV meeting, which macOS does not mark as yours, has you as its organiser among them.
 */
export function isInvitation(event: Pick<EventView, "mine" | "attendees">): boolean {
  return !event.mine && event.attendees.length > 0 && !event.attendees.some((attendee) => attendee.self && attendee.organiser);
}

/**
 * What a screen reader says for a row: when, what, which calendar, and the overlap the red stripe
 * shows. The title alone left nobody able to tell when anything was.
 */
export function eventRowLabel(
  event: Pick<EventView, "title" | "calendarName" | "allDay">,
  time: string,
  clashing: boolean,
  strings: Pick<Strings, "allDay" | "overlapsA11y">,
): string {
  return [event.allDay ? strings.allDay : time, event.title, event.calendarName, clashing ? strings.overlapsA11y : ""]
    .filter(Boolean)
    .join(", ");
}
