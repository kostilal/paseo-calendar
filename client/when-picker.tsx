import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Strings } from "../shared/i18n.ts";
import { dayKey, monthGrid, sameMonth } from "../shared/period.ts";
import {
  type WallClock,
  dateOfWallClock,
  formatWallClock,
  parseWallClock,
  withDate,
  withTime,
} from "../shared/wallclock.ts";
import { Chip, SectionLabel } from "./ui.tsx";

/**
 * Choosing when a meeting starts, with a calendar rather than a keyboard.
 *
 * The field used to be a plain text input holding "2026-09-14T17:45", which is the format the
 * server is promised and a hostile thing to ask anyone to type: the separator, the leading
 * zeros and the T are all load-bearing, and a mistake in any of them is rejected only after
 * pressing Review. The format is unchanged — `create-input.ts` still receives exactly that
 * string — but it is assembled from what was tapped, in shared/wallclock.ts, and never by
 * hand.
 *
 * Hours and minutes are laid out as two rows of chips rather than a wheel or a second text
 * field. A wheel needs a gesture this host has no component for, and a meeting time is
 * chosen from a small set in practice: five-minute granularity covers what people actually
 * schedule. A start already off that grid (10:07, say) keeps its minute until a minute chip is
 * tapped; an hour chip keeps it too.
 */

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 12 }, (_, step) => step * 5);

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

export function WhenPicker({
  value,
  theme,
  locale,
  strings,
  style,
  onChange,
}: {
  /** "YYYY-MM-DDTHH:mm". An unparseable one opens the picker on now rather than refusing. */
  value: string;
  theme: PluginTheme;
  locale: string;
  strings: Strings;
  style?: object;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const when: WallClock = parseWallClock(value) ?? {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: new Date().getDate(),
    hour: new Date().getHours(),
    minute: 0,
  };
  const chosen = dateOfWallClock(when);
  // The month being paged through, which starts at the chosen date and then moves on its own:
  // paging to December must not change the meeting to December until a day is actually tapped.
  const [month, setMonth] = useState<Date>(() => new Date(chosen.getFullYear(), chosen.getMonth(), 1));

  function set(next: WallClock) {
    onChange(formatWallClock(next));
  }

  const label = `${chosen.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "long" })} · ${pad(when.hour)}:${pad(when.minute)}`;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${strings.startLabel}: ${label}`}
        onPress={() => {
          setMonth(new Date(chosen.getFullYear(), chosen.getMonth(), 1));
          setOpen(true);
        }}
        style={style}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="CalendarDays" size={15} color={theme.colors.foregroundMuted} />
          <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14 }}>{label}</Text>
          <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>

      <Modal title={strings.startLabel} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {/* The arrows draw about 30 px and a finger needs about 44, hence the hitSlop. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={strings.previousMonth}
                hitSlop={8}
                onPress={() => setMonth((at) => new Date(at.getFullYear(), at.getMonth() - 1, 1))}
                style={{ padding: 6 }}
              >
                <Icon name="ChevronLeft" size={18} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Text style={{ flex: 1, textAlign: "center", color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
                {month.toLocaleDateString(locale, { month: "long", year: "numeric" })}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={strings.nextMonth}
                hitSlop={8}
                onPress={() => setMonth((at) => new Date(at.getFullYear(), at.getMonth() + 1, 1))}
                style={{ padding: 6 }}
              >
                <Icon name="ChevronRight" size={18} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>

            <SectionLabel theme={theme}>{strings.pickDate}</SectionLabel>
            {monthGrid(month).map((week) => (
              <View key={dayKey(week[0])} style={{ flexDirection: "row", gap: 4 }}>
                {week.map((day) => {
                  const isChosen = dayKey(day) === dayKey(chosen);
                  return (
                    <Pressable
                      key={dayKey(day)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isChosen }}
                      accessibilityLabel={day.toLocaleDateString(locale, { dateStyle: "long" })}
                      onPress={() => set(withDate(when, day))}
                      style={{ flex: 1 }}
                    >
                      <View
                        style={{
                          paddingVertical: 7,
                          borderRadius: 8,
                          alignItems: "center",
                          borderWidth: 1,
                          borderColor: isChosen ? theme.colors.accent : "transparent",
                          backgroundColor: isChosen ? theme.colors.surface2 : "transparent",
                          // Neighbouring months stay tappable — choosing the 1st from the
                          // previous month's last row is a normal thing to do — but dimmed.
                          opacity: sameMonth(day, month) ? 1 : 0.4,
                        }}
                      >
                        <Text
                          style={{
                            color: isChosen ? theme.colors.accent : theme.colors.foreground,
                            fontSize: 12,
                            fontVariant: ["tabular-nums"],
                          }}
                        >
                          {day.getDate()}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))}

            <SectionLabel theme={theme}>{strings.pickTime}</SectionLabel>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              {HOURS.map((hour) => (
                <Chip
                  key={hour}
                  theme={theme}
                  hitSlop={2}
                  label={pad(hour)}
                  selected={hour === when.hour}
                  onPress={() => set(withTime(when, hour, when.minute))}
                />
              ))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              {MINUTES.map((minute) => (
                <Chip
                  key={minute}
                  theme={theme}
                  hitSlop={2}
                  label={`:${pad(minute)}`}
                  selected={minute === when.minute}
                  onPress={() => set(withTime(when, when.hour, minute))}
                />
              ))}
            </View>

            <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
              <View
                style={{
                  backgroundColor: theme.colors.accent,
                  borderRadius: 10,
                  paddingVertical: 10,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", fontSize: 14 }}>
                  {strings.done}
                </Text>
              </View>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
