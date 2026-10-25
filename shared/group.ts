import type { EventsView, EventView } from "./calendar.ts";
import { dayKey } from "./period.ts";

/**
 * Every day an all-day event actually covers, first to last inclusive. `end` is exclusive
 * (the day after the last day; see shared/event.ts), so a one-day event's start and end are
 * exactly one calendar day apart and this yields exactly that one day; a three-day
 * conference yields three. Walked in UTC on the bare date components — an all-day event's
 * date has no time zone of its own to get wrong — so a month or year rollover is just the
 * platform's own date normalisation, never a special case here. A range that does not
 * actually advance (a malformed or empty end) falls back to the start alone rather than
 * looping forever or producing nothing.
 */
export function allDayDates(event: EventView): string[] {
  const cursor = new Date(`${event.start}T00:00:00.000Z`);
  const end = new Date(`${event.end}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || end <= cursor) {
    return [event.start];
  }
  const days: string[] = [];
  while (cursor < end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function groupByDay(events: EventView[]): { day: string; events: EventView[] }[] {
  const byDay = new Map<string, EventView[]>();
  const add = (key: string, event: EventView) => {
    const bucket = byDay.get(key);
    if (bucket) bucket.push(event);
    else byDay.set(key, [event]);
  };
  for (const event of events) {
    // An all-day event is filed under every day it covers, not just the one its start falls
    // on — a three-day conference must be visible on all three, not only the first — while a
    // timed event still has exactly one instant and one day. That day is the local one, not
    // UTC's: a meeting at 01:00 Kyiv time is on today's list for the person looking at it,
    // whatever date its instant carries in UTC.
    if (event.allDay) {
      for (const key of allDayDates(event)) add(key, event);
    } else {
      add(dayKey(new Date(event.start)), event);
    }
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, group]) => ({
      day,
      // All-day first: it frames the day rather than sitting in the middle of it.
      events: group.sort((left, right) => {
        if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
        return left.start.localeCompare(right.start);
      }),
    }));
}

/**
 * Events bucketed by the local day they fall on, which is the key every grid looks up by. A
 * timed event is filed under the local day of its start; an all-day event under every day it
 * covers, as groupByDay files it, so a month cell counts a three-day conference on all three
 * days. Its bare dates are taken as written: parsed through Date they would read as UTC midnight
 * and land a day early for anyone west of Greenwich.
 */
export function eventsByDay(events: readonly EventView[]): Map<string, EventView[]> {
  const buckets = new Map<string, EventView[]>();
  const add = (key: string, event: EventView) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(event);
    else buckets.set(key, [event]);
  };
  for (const event of events) {
    if (event.allDay) for (const key of allDayDates(event)) add(key, event);
    else add(dayKey(new Date(event.start)), event);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.start.localeCompare(b.start));
  return buckets;
}

/**
 * One day's rows, from that day's bucket. agendaOf files a multi-day all-day event under every
 * day it covers, so the bucket of a conference's first day would come back as one group per day
 * of the conference, all drawn on that day; only the asked day's group is kept. The bucket rather
 * than the whole range goes in, so a clash with a meeting that started the evening before cannot
 * be filed under that evening and take this day's member with it.
 */
export function dayAgenda(events: readonly EventView[], clashes: EventsView["clashes"], day: string): AgendaRow[] {
  return agendaOf([...events], clashes).find((entry) => entry.day === day)?.rows ?? [];
}

/**
 * event.id alone is only unique within one account's own calendar; two independently synced
 * accounts can each hand back an event with the same provider id. Every identity-bearing
 * Map/Set in this file, and every React list key built from an event, uses this instead of
 * the bare id. Typed structurally rather than as `EventView` so a clashView side —
 * `{accountId, id}`, calendar.ts's clashSide — resolves through the exact same function
 * instead of a second, parallel formula that could quietly drift from this one.
 */
export function eventKey(event: { accountId: string; id: string }): string {
  return `${event.accountId}:${event.id}`;
}

/** Every event in a collision, including the one this map entry is keyed by. */
export interface ClashGroup {
  members: EventView[];
  overlapMs: number;
}

/**
 * One lookup built once per fetch: which events collide with which, and by how much. Both
 * the agenda's merged block and (indirectly, via partnersOf below) the card's collision line
 * start from the same clash data, so the two surfaces can never disagree about who overlaps
 * with whom. Keyed by every member's eventKey, not just one side of each pair, so either half
 * of a collision finds the whole group.
 *
 * A chain (A overlaps B, B overlaps C, A and C do not touch) still becomes one group: that
 * matches how a calendar's own overlap.ts already reports a three-way clash as every pair
 * that actually touches, and a viewer double-booked against the same middle meeting twice is
 * one cluster to resolve, not two unrelated ones. Callers that display more than two members
 * must qualify the label rather than presenting this group's overlapMs (the worst single
 * pair in it) as if it applied to every member — see the board's clashBlock rendering.
 */
export function clashGroupsOf(events: EventView[], clashes: EventsView["clashes"]): Map<string, ClashGroup> {
  // Each clash side already carries its own accountId (calendar.ts's clashSide), so this is
  // a direct eventKey comparison — no more resolving a bare id back to "whichever event a
  // Map happened to keep last", which used to collapse two different accounts' events that
  // share a bare id into one and silently drop the other from every group it was actually
  // part of.
  const validKeys = new Set(events.map((event) => eventKey(event)));

  const parent = new Map<string, string>();
  for (const event of events) parent.set(eventKey(event), eventKey(event));
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };

  // Only pairs that resolve to an event actually in this fetch: a stale clash from a
  // superseded snapshot must not crash the lookup.
  const relevant = clashes.filter((clash) => validKeys.has(eventKey(clash.a)) && validKeys.has(eventKey(clash.b)));
  for (const clash of relevant) {
    const rootA = find(eventKey(clash.a));
    const rootB = find(eventKey(clash.b));
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const byRoot = new Map<string, EventView[]>();
  for (const event of events) {
    const root = find(eventKey(event));
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(event);
    else byRoot.set(root, [event]);
  }

  const groups = new Map<string, ClashGroup>();
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const memberKeys = new Set(members.map((event) => eventKey(event)));
    // Almost always exactly one pair (two double-booked meetings); a three-way collision
    // reports every pair, so the group's label uses the worst of them.
    const overlapMs = Math.max(
      ...relevant
        .filter((clash) => memberKeys.has(eventKey(clash.a)) && memberKeys.has(eventKey(clash.b)))
        .map((clash) => clash.overlapMs),
    );
    for (const event of members) groups.set(eventKey(event), { members, overlapMs });
  }
  return groups;
}

/**
 * Every OTHER event that genuinely overlaps this one, each with its own overlap duration —
 * not a clash group's blanket "worst pair", which can name a false collision: in a three-way
 * chain (A-B overlap, B-C overlap, A and C never touch), the group's single overlapMs is
 * B's worst pair, and its member list includes C — so reusing it on A's own card would tell
 * the user A conflicts with C, which is not true. The card looks at one meeting at a time and
 * must never claim a conflict that is not real, so it asks this instead of clashGroupsOf.
 */
export function partnersOf(
  event: EventView,
  events: EventView[],
  clashes: EventsView["clashes"],
): { event: EventView; overlapMs: number }[] {
  // Composite keys throughout, same as clashGroupsOf: matching on the bare id alone used to
  // reach a third, independent answer whenever two accounts shared one bare id, agreeing
  // with neither the agenda's clash block nor its "plain row" copy.
  const byKey = new Map(events.map((entry) => [eventKey(entry), entry] as const));
  const ownKey = eventKey(event);
  const partners: { event: EventView; overlapMs: number }[] = [];
  for (const clash of clashes) {
    const aKey = eventKey(clash.a);
    const bKey = eventKey(clash.b);
    const partnerKey = aKey === ownKey ? bKey : bKey === ownKey ? aKey : null;
    if (partnerKey === null) continue;
    const partner = byKey.get(partnerKey);
    if (!partner || partner === event) continue;
    partners.push({ event: partner, overlapMs: clash.overlapMs });
  }
  return partners.sort((left, right) => left.event.start.localeCompare(right.event.start));
}

export type AgendaRow =
  | { kind: "single"; event: EventView }
  | { kind: "clash"; members: EventView[]; overlapMs: number };

export interface AgendaDay {
  day: string;
  rows: AgendaRow[];
}

/**
 * groupByDay's day buckets, with clashGroupsOf's collisions merged into single rows — done
 * together, in one pass over every day rather than one call per day, specifically so a clash
 * spanning local midnight (its members landing in two different day buckets) still renders
 * exactly once, at the day of its earliest member, instead of once per day its members
 * happen to fall into. `seen` is shared across the whole loop, not reset per day, which is
 * the one property that makes that true — but it tracks clash groups only, never a "single"
 * row: an all-day event can never be part of a clash (overlap.ts excludes it), and
 * groupByDay deliberately files a multi-day one under every day it covers, so every one of
 * those appearances has to render, not just the first.
 */
export function agendaOf(events: EventView[], clashes: EventsView["clashes"]): AgendaDay[] {
  const days = groupByDay(events);
  const groups = clashGroupsOf(events, clashes);
  const seen = new Set<string>();
  const result: AgendaDay[] = [];
  for (const { day, events: dayEvents } of days) {
    const rows: AgendaRow[] = [];
    for (const event of dayEvents) {
      const key = eventKey(event);
      const group = groups.get(key);
      if (!group) {
        rows.push({ kind: "single", event });
        continue;
      }
      if (seen.has(key)) continue;
      for (const member of group.members) seen.add(eventKey(member));
      rows.push({ kind: "clash", members: group.members, overlapMs: group.overlapMs });
    }
    // A day whose only events were already claimed by an earlier day's clash group has
    // nothing left to show — an empty heading would be worse than no section at all.
    if (rows.length > 0) result.push({ day, rows });
  }
  return result;
}
