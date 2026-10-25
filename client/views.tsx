import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { EventsView, EventView } from "../shared/calendar.ts";
import { hasPassed } from "../shared/elapsed.ts";
import { type AgendaRow, dayAgenda, eventKey, eventsByDay } from "../shared/group.ts";
import { dayKey, formatClock, monthGrid, sameMonth } from "../shared/period.ts";
import type { Strings } from "../shared/i18n.ts";
import { eventRowLabel } from "./event-actions.ts";
import { Card, EmptyState } from "./ui.tsx";

/**
 * What the board draws: a day's rows (EventRow and AgendaRows, which the agenda and the day
 * view share), the day view, and the month grid.
 *
 * Kept out of board.tsx, which decides which view is open and what to fetch for it. Everything
 * here is pure given its events — every window decision lives in shared/period.ts, and every
 * fetch decision in the board.
 */

/**
 * What a meeting already behind you fades to.
 *
 * Opacity rather than a colour of its own, because "spent" has to read the same in both
 * themes and against all three surfaces, and because it dims the red stripe of a collision
 * by exactly as much as everything else — a clash you have already sat through should stop
 * shouting without stopping being legible. Faint enough that the first row still at full
 * strength is the one the eye lands on, which is the whole point: that row is what is next.
 */
const PAST_OPACITY = 0.45;

/**
 * Weekday initials in the viewer's own locale, starting Monday to match monthGrid.
 * 1 January 2024 was a Monday; only the weekday of these dates is ever read.
 */
function weekdayLabels(locale: string): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    new Date(2024, 0, 1 + index).toLocaleDateString(locale, { weekday: "short" }).replace(".", ""),
  );
}

/** One tappable meeting. The stripe is semantic, not decoration: it is the only thing
 *  distinguishing a row inside a collision from a row that stands on its own. */
export function EventRow({
  event,
  theme,
  locale,
  strings,
  clashing,
  past,
  onPress,
}: {
  event: EventView;
  theme: PluginTheme;
  locale: string;
  strings: Strings;
  clashing: boolean;
  /** Already over. Decided by the caller against one shared `now`, never read from the clock
   *  here: a hundred rows must agree on what time it is, and a row that judged itself once
   *  at mount would still be claiming it at midnight. */
  past: boolean;
  onPress: () => void;
}) {
  const time = event.allDay ? "" : formatClock(new Date(event.start), locale);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={eventRowLabel(event, time, clashing, strings)}
      onPress={onPress}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "stretch",
          gap: 10,
          paddingVertical: 8,
          opacity: past ? PAST_OPACITY : 1,
        }}
      >
        <View
          style={{
            width: 3,
            borderRadius: 2,
            backgroundColor: clashing ? theme.colors.statusDanger : theme.colors.border,
          }}
        />
        <Text
          style={{
            width: 46,
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            // Tabular figures so the times form a column instead of shimmying by a pixel
            // per digit down the list.
            fontVariant: ["tabular-nums"],
          }}
        >
          {event.allDay ? "—" : time}
        </Text>
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }} numberOfLines={1}>
            {event.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
            {event.calendarName}
          </Text>
        </View>
        {event.joinUrl ? <Icon name="Video" size={14} color={theme.colors.foregroundMuted} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * A day's worth of rows, collisions included.
 *
 * Shared by the agenda and the day view rather than written twice: a collision is the whole
 * reason this plugin exists over a browser tab, and two copies of how it is drawn would be
 * two things to keep in step. A collision is one card holding its members — red border, red
 * stripes, the titles stacked. It used to end in a line of red text naming the overlap in
 * minutes as well; that is a number nobody had asked for, sitting under the two titles that
 * actually answer the question, on a card already unmistakably drawn as a collision. The
 * event card still names it (card.tsx), where it can also say which meeting is in the way.
 */
export function AgendaRows({
  rows,
  theme,
  locale,
  strings,
  now,
  onOpen,
}: {
  rows: readonly AgendaRow[];
  theme: PluginTheme;
  locale: string;
  strings: Strings;
  /** One reading of the clock for the whole list; see EventRow's `past`. */
  now: Date;
  onOpen: (event: EventView) => void;
}) {
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "single") {
          return (
            <EventRow
              key={eventKey(row.event)}
              event={row.event}
              theme={theme}
              locale={locale}
              strings={strings}
              clashing={false}
              past={hasPassed(row.event, now)}
              onPress={() => onOpen(row.event)}
            />
          );
        }
        // A collision every member of which is over fades as one block, border included —
        // and its rows then stay at full strength inside it, because nested opacity
        // multiplies and 0.45 of 0.45 is not a dimmed row, it is an invisible one. A
        // collision only half behind you keeps its border: the half still ahead is exactly
        // the thing the red is for.
        const spent = row.members.every((member) => hasPassed(member, now));
        return (
          <Card
            key={row.members.map(eventKey).sort().join("+")}
            theme={theme}
            style={{
              padding: 10,
              gap: 0,
              borderColor: theme.colors.statusDanger,
              marginVertical: 4,
              opacity: spent ? PAST_OPACITY : 1,
            }}
          >
            {row.members.map((member) => (
              <EventRow
                key={eventKey(member)}
                event={member}
                theme={theme}
                locale={locale}
                strings={strings}
                clashing
                past={spent ? false : hasPassed(member, now)}
                onPress={() => onOpen(member)}
              />
            ))}
          </Card>
        );
      })}
    </>
  );
}

/**
 * One day, with its collisions called out.
 *
 * `events` is the day's bucket (eventsByDay), and dayAgenda groups it as the agenda does, which
 * is what gives a clash inside the chosen day the same red block the agenda draws, and keeps a
 * multi-day all-day event to one row on each of its days. A partner that sits on the other side of
 * midnight is not shown here: a day outside the fortnight is fetched alone, so the other half was
 * never asked for, and a day inside it is a slice of the snapshot that drops a clash whose other
 * side falls outside the day (server/sync.ts's sliceView). The agenda, whose window is a
 * fortnight, still catches it.
 */
export function DayView({
  day,
  events,
  clashes,
  theme,
  locale,
  strings,
  now,
  onOpen,
}: {
  /** The chosen day, as dayKey writes it. */
  day: string;
  events: readonly EventView[];
  clashes: EventsView["clashes"];
  theme: PluginTheme;
  locale: string;
  strings: Strings;
  now: Date;
  onOpen: (event: EventView) => void;
}) {
  const rows = dayAgenda(events, clashes, day);
  if (rows.length === 0) {
    return <EmptyState theme={theme} icon="CalendarDays" title={strings.nothingInPeriod} />;
  }
  return (
    <View style={{ gap: 2 }}>
      <AgendaRows rows={rows} theme={theme} locale={locale} strings={strings} now={now} onOpen={onOpen} />
    </View>
  );
}

export function MonthView({
  cursor,
  events,
  theme,
  locale,
  strings,
  onPickDay,
}: {
  cursor: Date;
  events: readonly EventView[];
  theme: PluginTheme;
  locale: string;
  strings: Strings;
  onPickDay: (day: Date) => void;
}) {
  const weeks = monthGrid(cursor);
  const buckets = eventsByDay(events);
  const todayKey = dayKey(new Date());
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row" }}>
        {weekdayLabels(locale).map((label) => (
          <Text
            key={label}
            style={{
              flex: 1,
              textAlign: "center",
              color: theme.colors.foregroundMuted,
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {label}
          </Text>
        ))}
      </View>
      {weeks.map((week) => (
        <View key={dayKey(week[0])} style={{ flexDirection: "row", gap: 4 }}>
          {week.map((day) => {
            const key = dayKey(day);
            const count = buckets.get(key)?.length ?? 0;
            const inMonth = sameMonth(day, cursor);
            const isToday = key === todayKey;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={
                  count > 0
                    ? `${day.toLocaleDateString(locale, { dateStyle: "long" })}, ${strings.eventsA11y(count)}`
                    : day.toLocaleDateString(locale, { dateStyle: "long" })
                }
                onPress={() => onPickDay(day)}
                style={{ flex: 1 }}
              >
                <View
                  style={{
                    minHeight: 52,
                    borderRadius: 8,
                    borderWidth: 1,
                    // Today is the only cell that earns the accent; a day merely belonging to
                    // the month being looked at is not news.
                    borderColor: isToday ? theme.colors.accent : theme.colors.border,
                    backgroundColor: inMonth ? theme.colors.surface1 : "transparent",
                    padding: 5,
                    gap: 3,
                    // Days from the neighbouring months are shown rather than blanked — that
                    // is what says the 1st is a Tuesday — but dimmed, so the month still
                    // reads as a block.
                    opacity: inMonth ? 1 : 0.4,
                  }}
                >
                  <Text
                    style={{
                      color: isToday ? theme.colors.accent : theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: isToday ? "700" : "500",
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {day.getDate()}
                  </Text>
                  {count > 0 ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                      <View
                        style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.accent }}
                      />
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                        {strings.eventCount(count)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
