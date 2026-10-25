import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type EventView, updateEvent } from "../shared/calendar.ts";
import { detectAppLocale, t } from "../shared/i18n.ts";
import { dateOfWallClock, parseWallClock, wallClockOf, formatWallClock } from "../shared/wallclock.ts";
import { nudgePill } from "./pill-watch.ts";
import { Banner, Button, RADIUS, Screen, SectionLabel } from "./ui.tsx";
import { WhenPicker } from "./when-picker.tsx";

type HostProps = Pick<PluginSurfaceProps, "theme" | "layout">;

/** Whole minutes between two instants, which is how the form thinks about length. */
function minutesBetween(startIso: string, endIso: string): number {
  const span = (Date.parse(endIso) - Date.parse(startIso)) / 60_000;
  return Number.isFinite(span) && span > 0 ? Math.round(span) : 30;
}

/**
 * Changing a meeting that already exists: its title, time and notes.
 *
 * Only ever reached for a one-off: a series is refused by the card that would open this, by
 * the server, and by the Swift helper. Three guards for one mistake, because rewriting every
 * future occurrence of a standup is not something anybody can undo from here. An all-day event
 * is refused by the card and the server too: this form thinks in instants.
 *
 * Attendees are not shown, because EventKit cannot change them: it writes no invitations.
 */
export function EditSurface({
  event,
  theme,
  layout,
  onBack,
}: HostProps & { event: EventView; onBack: () => void }) {
  const locale = detectAppLocale();
  const strings = t(locale);
  const queries = useQueryClient();
  const askUpdate = useRpc(updateEvent);

  const [title, setTitle] = useState(event.title);
  const [start, setStart] = useState(() => formatWallClock(wallClockOf(new Date(event.start))));
  const [duration, setDuration] = useState(() => String(minutesBetween(event.start, event.end)));
  const [description, setDescription] = useState(event.description);
  const [error, setError] = useState("");

  const when = parseWallClock(start);
  const minutes = /^\d+$/.test(duration.trim()) ? Number(duration.trim()) : 0;
  const ready = title.trim().length > 0 && when !== null && minutes > 0;

  const save = useMutation({
    mutationFn: () => {
      // `ready` gates the button, so these are sound here; the server checks again anyway.
      const from = dateOfWallClock(when!);
      return askUpdate({
        accountId: event.accountId,
        eventId: event.id,
        calendarId: event.calendarId,
        title: title.trim(),
        start: from.toISOString(),
        end: new Date(from.getTime() + minutes * 60_000).toISOString(),
        description: description.trim(),
      });
    },
    onSuccess(result) {
      setError(result.error);
      if (result.error) return;
      // The daemon answers once its snapshot has the new time (sync.ts update() waits for its
      // refresh, up to a cap), but the board is still showing the old one until it refetches,
      // and so is the pill, which reads no react-query key and has to be asked on its own.
      void queries.invalidateQueries({ queryKey: ["calendar"] });
      nudgePill();
      onBack();
    },
    onError(thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    },
  });

  const input = {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: RADIUS.control,
    paddingVertical: 9,
    paddingHorizontal: 10,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    fontSize: 14,
  };
  const label = { color: theme.colors.foregroundMuted, fontSize: 12 };

  return (
    <Screen theme={theme} layout={layout}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.back}
        hitSlop={8}
        style={{ alignSelf: "flex-start", paddingVertical: 6 }}
        onPress={onBack}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name="ChevronLeft" size={16} color={theme.colors.foregroundMuted} />
          <Text style={label}>{strings.back}</Text>
        </View>
      </Pressable>

      <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
        {strings.editTitle}
      </Text>

      {/* Defence in depth. The card does not offer Edit for a series or an all-day event, so
          reaching this with one is already a bug — but a screen that would write the wrong thing
          should say so rather than trust that it was opened correctly. */}
      {event.recurring ? <Banner theme={theme} tone="warn" text={strings.seriesNotEditable} /> : null}
      {event.allDay ? <Banner theme={theme} tone="warn" text={strings.allDayNotEditable} /> : null}

      <SectionLabel theme={theme}>{strings.titleLabel}</SectionLabel>
      <TextInput style={input} value={title} onChangeText={setTitle} placeholderTextColor={theme.colors.foregroundMuted} />

      <SectionLabel theme={theme}>{strings.startLabel}</SectionLabel>
      <WhenPicker value={start} theme={theme} locale={locale} strings={strings} style={input} onChange={setStart} />

      <SectionLabel theme={theme}>{strings.durationLabel}</SectionLabel>
      <TextInput
        style={input}
        value={duration}
        onChangeText={setDuration}
        keyboardType="number-pad"
        placeholderTextColor={theme.colors.foregroundMuted}
      />

      <SectionLabel theme={theme}>{strings.descriptionLabel}</SectionLabel>
      <TextInput
        style={[input, { minHeight: 64, textAlignVertical: "top" }]}
        value={description}
        onChangeText={setDescription}
        multiline
        placeholderTextColor={theme.colors.foregroundMuted}
      />

      {error ? <Banner theme={theme} tone="bad" text={strings.editFailed(error)} /> : null}

      <Button
        theme={theme}
        label={save.isPending ? strings.saving : strings.save}
        icon="Check"
        disabled={!ready || save.isPending || event.recurring || event.allDay}
        onPress={() => {
          setError("");
          save.mutate();
        }}
      />
    </Screen>
  );
}
