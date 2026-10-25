import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { type AccountView, type EventView, deleteEvent, openJoin } from "../shared/calendar.ts";
import { allDayDates } from "../shared/group.ts";
import { detectAppLocale, t } from "../shared/i18n.ts";
import { copyLabelsOf } from "../shared/meeting.ts";
import { formatClock } from "../shared/period.ts";
import { EditSurface } from "./edit.tsx";
import { isInvitation, ownActions } from "./event-actions.ts";
import { nudgePill } from "./pill-watch.ts";
import { Banner, Button, Card, Screen, SectionLabel } from "./ui.tsx";

/**
 * `PluginLayout` is not exported in 0.8 — the layout object is declared inline on the host
 * props — so this Pick stays honest against `PluginSurfaceProps` directly rather than naming
 * a type the SDK does not export.
 */
type HostProps = Pick<PluginSurfaceProps, "theme" | "layout">;

/** One other event that genuinely overlaps this one, and by how long — not a merged group's
 *  blanket "worst pair", which can name a conflict that isn't real (see partnersOf). */
interface ClashPartner {
  event: EventView;
  overlapMs: number;
}

function joinLabel(kind: EventView["joinKind"], strings: ReturnType<typeof t>): string {
  switch (kind) {
    case "meet":
      return strings.joinMeet;
    case "teams":
      return strings.joinTeams;
    case "zoom":
      return strings.joinZoom;
    default:
      return strings.joinGeneric;
  }
}

/** Up to this many attendees read as context; past it they read as a wall. */
const WHO_INLINE_LIMIT = 4;

/**
 * One labelled fact, as a pair rather than as a card of its own.
 *
 * The screen used to give every value its own bordered box holding a single line of text,
 * which is most of why it read as a column of nothing much. Side by side on a wide client and
 * stacked on a narrow one, because a 148px label column next to a phone-width value leaves
 * neither enough room.
 */
function Fact({
  theme,
  layout,
  label,
  value,
  trailing,
  onPress,
  expanded,
}: {
  theme: PluginTheme;
  layout: PluginSurfaceProps["layout"];
  label: string;
  value: string;
  trailing?: ReactNode;
  onPress?: () => void;
  /** For a fact that opens something below it, whether that is open: a screen reader says so. */
  expanded?: boolean;
}) {
  const body = (
    <View
      style={{
        flexDirection: layout.compact ? "column" : "row",
        alignItems: layout.compact ? "flex-start" : "center",
        gap: layout.compact ? 2 : 12,
        paddingVertical: 3,
      }}
    >
      <Text
        style={{
          width: layout.compact ? undefined : 136,
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      <Text style={{ flex: layout.compact ? undefined : 1, color: theme.colors.foreground, fontSize: 13 }}>
        {value}
      </Text>
      {trailing}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
    >
      {body}
    </Pressable>
  );
}

export function EventCard({
  event,
  held,
  collidesWith,
  accounts,
  theme,
  layout,
  onBack,
}: HostProps & {
  event: EventView;
  /** The meeting is in the board's events snapshot, the fortnight the server edits and deletes in. */
  held: boolean;
  /** Passed by the board (from shared/group.ts's partnersOf) — every event that genuinely
   *  overlaps this one, each with its own duration. Empty (or absent) means no collision.
   *  Optional so the type still matches a plain { event, theme, layout, onBack } caller. */
  collidesWith?: ClashPartner[];
  /** The board's Settings read, so each calendar is named with its account. Absent or still
   *  loading, the card names the calendars alone. */
  accounts?: readonly AccountView[];
  onBack: () => void;
}) {
  const locale = detectAppLocale();
  const strings = t(locale);
  const partners = collidesWith ?? [];
  const askJoin = useRpc(openJoin);
  const [joinError, setJoinError] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const askDelete = useRpc(deleteEvent);
  const queries = useQueryClient();

  const remove = useMutation({
    mutationFn: () => askDelete({ accountId: event.accountId, eventId: event.id, calendarId: event.calendarId }),
    onSuccess(result) {
      setDeleteError(result.error);
      if (result.error) return;
      setConfirmingDelete(false);
      void queries.invalidateQueries({ queryKey: ["calendar"] });
      // The pill reads no react-query key: without this it would keep naming the deleted
      // meeting until its next poll.
      nudgePill();
      // Back to the agenda: staying on the card of a meeting that no longer exists would be
      // a screen describing nothing.
      onBack();
    },
    onError(thrown) {
      setDeleteError(thrown instanceof Error ? thrown.message : String(thrown));
    },
  });
  // Folded by default once the list is long enough to push everything else off the screen.
  // A one-to-one's two names are worth reading at a glance; a standup's nineteen are not, and
  // on the meeting that prompted this they filled the card entirely.
  const [showWho, setShowWho] = useState(event.attendees.length <= WHO_INLINE_LIMIT);

  const when = useMemo(() => {
    if (event.allDay) {
      // allDayDates does the same start/end-is-exclusive walk groupByDay uses to expand a
      // multi-day event across the agenda — reused here so the card can say
      // "Thursday, 10 September – Saturday, 12 September" instead of leaving a viewer to
      // guess how far a conference actually runs from "All day" alone.
      const days = allDayDates(event);
      const formatDay = (dateOnly: string) =>
        new Date(`${dateOnly}T00:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
      const range = days.length > 1 ? `${formatDay(days[0])} – ${formatDay(days[days.length - 1])}` : formatDay(days[0]);
      return `${strings.allDay} · ${range}`;
    }
    const start = new Date(event.start);
    const end = new Date(event.end);
    const time = (date: Date) => formatClock(date, locale);
    return `${start.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })} · ${time(start)} – ${time(end)}`;
  }, [event, locale, strings.allDay]);

  const label = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const external = event.attendees.filter((attendee) => attendee.company).length;
  const own = ownActions(event, held);
  const ownNotes = own.notes.map((note) =>
    note === "outside"
      ? strings.changeInCalendar
      : note === "series"
        ? `${strings.seriesNotEditable} ${strings.seriesNotDeletable}`
        : strings.allDayNotEditable,
  );

  if (editing) {
    return <EditSurface event={event} theme={theme} layout={layout} onBack={() => setEditing(false)} />;
  }

  return (
    <Screen theme={theme} layout={layout}>
      {/* About 18 px of text on its own; the padding and the slop make it a phone-sized target. */}
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

      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 22 : 26, fontWeight: "700" }}>
            {event.title}
          </Text>
          <Text style={label}>{when}</Text>
        </View>
        {event.joinUrl ? (
          <Button
            theme={theme}
            label={joinLabel(event.joinKind, strings)}
            icon="Video"
            onPress={() => {
              setJoinError("");
              // The daemon opens it, because this client cannot: see shared/calendar.ts's
              // openJoin. A rejected RPC is reported rather than swallowed — a Join button
              // that does nothing at all is the one outcome nobody can act on.
              void askJoin({ url: event.joinUrl })
                .then((result) => setJoinError(result.error))
                .catch((thrown) => setJoinError(thrown instanceof Error ? thrown.message : String(thrown)));
            }}
          />
        ) : null}
      </View>

      {joinError ? <Banner theme={theme} tone="bad" text={joinError} /> : null}

      {/* One row, because they are one kind of thing. Stacked, each took a line of its own and
          the card became a column of buttons with the meeting somewhere above it. Delete is
          never a bare button: the press opens a confirmation that names the meeting. What is
          not offered, and why, is decided by ownActions and said once, below. */}
      {/* Your own meeting is one you change. Changing somebody else's through your own
          calendar is not what Edit looks like it does, and Delete on a meeting you were
          invited to means something different again — leaving it. An invitation is answered
          in Calendar, and the card says so instead of offering either button. */}
      {event.mine ? (
        <>
          {own.offered ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button
                theme={theme}
                label={strings.edit}
                variant="ghost"
                icon="Pencil"
                disabled={!own.edit}
                onPress={() => setEditing(true)}
              />
              {own.remove ? (
                <Button
                  theme={theme}
                  label={strings.deleteLabel}
                  variant="danger"
                  icon="Trash2"
                  onPress={() => {
                    setDeleteError("");
                    setConfirmingDelete(true);
                  }}
                />
              ) : null}
            </View>
          ) : null}
          {ownNotes.map((note) => (
            <Text key={note} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
              {note}
            </Text>
          ))}
        </>
      ) : isInvitation(event) ? (
        // EventKit can report who answered what and cannot change it: it exposes
        // participantStatus as get-only. Saying so beats three buttons that fail. Only on an
        // invitation: a holiday, a birthday or your own CalDAV meeting is nothing to answer.
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {strings.rsvpUnavailable}
        </Text>
      ) : null}

      {partners.length > 0 ? (
        <Banner
          theme={theme}
          tone="bad"
          text={partners
            .map((partner) => `${strings.overlapWarning(Math.round(partner.overlapMs / 60_000))} — ${partner.event.title}`)
            .join("\n")}
        />
      ) : null}

      {/* One card of label-and-value pairs instead of a card per fact. A whole bordered box
          holding a single line of text was most of why this screen read as a column of
          nothing much. */}
      <Card theme={theme}>
        <Fact
          theme={theme}
          layout={layout}
          label={event.alsoIn.length ? strings.calendarsFoundLabel : strings.calendarLabel}
          value={copyLabelsOf(event, accounts ?? []).join(", ")}
        />
        {event.location ? (
          <Fact theme={theme} layout={layout} label={strings.whereLabel} value={event.location} />
        ) : null}
        {event.attendees.length > 0 ? (
          <Fact
            theme={theme}
            layout={layout}
            label={strings.whoLabel}
            expanded={showWho}
            onPress={() => setShowWho((open) => !open)}
            value={`${event.attendees.length}${external > 0 ? ` · ${external} ${strings.external.toLowerCase()}` : ""}`}
            trailing={
              <Icon name={showWho ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
            }
          />
        ) : null}
        {showWho
          ? event.attendees.map((attendee) => (
              <View
                key={attendee.email || attendee.name}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: layout.compact ? 0 : 148 }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                    {attendee.self ? strings.you : attendee.name}
                  </Text>
                  {attendee.company ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{attendee.company}</Text>
                  ) : null}
                </View>
                {attendee.company ? (
                  <Text style={{ color: theme.colors.statusWarning, fontSize: 10, fontWeight: "700" }}>
                    {strings.external}
                  </Text>
                ) : null}
              </View>
            ))
          : null}
      </Card>

      {event.description ? (
        <Card theme={theme}>
          <SectionLabel theme={theme}>{strings.descriptionLabel}</SectionLabel>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19 }}>{event.description}</Text>
        </Card>
      ) : null}

      <Modal title={strings.deleteConfirmTitle} open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <Modal.Content>
          <View style={{ gap: 12 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
              {strings.deleteConfirm(event.title)}
            </Text>
            {deleteError ? <Banner theme={theme} tone="bad" text={strings.deleteFailed(deleteError)} /> : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button theme={theme} label={strings.cancel} variant="ghost" onPress={() => setConfirmingDelete(false)} />
              <Button
                theme={theme}
                label={remove.isPending ? strings.deleting : strings.deleteLabel}
                variant="danger"
                disabled={remove.isPending}
                onPress={() => remove.mutate()}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </Screen>
  );
}
