import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { accountLabel } from "../shared/accounts.ts";
import { type AccountView, createEvent, getSettings } from "../shared/calendar.ts";
import { detectAppLocale, t } from "../shared/i18n.ts";
import { ERROR_RETRY_MS, formatClock } from "../shared/period.ts";
import { RADIUS, Screen } from "./ui.tsx";
import { WhenPicker } from "./when-picker.tsx";
import {
  buildCreateInput,
  classifyCreateError,
  createOutcome,
  type CreateFields,
  type CreateProblem,
  defaultStartText,
  isHiddenTarget,
  pickSelection,
  writableAccounts,
} from "./create-input.ts";
import { nudgePill } from "./pill-watch.ts";
import { createSubmitLatch, type SubmitLatch } from "./submit-latch.ts";

/** `PluginLayout` is not exported in 0.8; this stays honest against the host props instead
 *  of naming a type the SDK does not have (same Pick as card.tsx). */
type HostProps = Pick<PluginSurfaceProps, "theme" | "layout">;

/**
 * Everything the confirmation showed, frozen at the moment it was shown. The accounts query
 * can refetch underneath this screen, so reading the calendar or the account off live state
 * at the moment Create is pressed could write somewhere other than the place the summary
 * named. This is the only value ever handed to createEvent.
 */
interface Confirmation {
  fields: CreateFields;
  /** The account's label, as the picker headed it. */
  account: string;
  calendarName: string;
  /** The chosen calendar is switched off in Settings, so the board will not show the event. */
  hidden: boolean;
}

/** The instant pair, read back through Intl in the viewer's locale — with the zone spelled
 *  out, because "15:00" that quietly means 12:00 somewhere else is the mistake this screen
 *  is most able to make and least able to take back. */
function formatRange(startIso: string, endIso: string, locale: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(start);
  const from = formatClock(start, locale);
  // The end carries the zone as well: this line is the last thing read before a write, and
  // "15:30 GMT+3" is what makes a wall clock typed in the wrong zone visible beforehand.
  const to = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(end);
  return `${day} · ${from} – ${to}`;
}

function problemText(problem: CreateProblem, strings: ReturnType<typeof t>): string {
  switch (problem) {
    case "calendar":
      return strings.problemCalendar;
    case "title":
      return strings.problemTitle;
    case "start":
      return strings.problemStart;
    case "duration":
      return strings.problemDuration;
  }
}

/** A refused save in the words for why it was refused, rather than EventKit's own sentence. */
function errorText(message: string, strings: ReturnType<typeof t>): string {
  switch (classifyCreateError(message)) {
    case "read_only":
      return strings.createReadOnly;
    case "calendar_missing":
      return strings.createCalendarMissing;
    case "other":
      return strings.createFailed(message);
  }
}

export function CreateSurface({ theme, layout, onBack }: HostProps & { onBack: () => void }) {
  const locale = detectAppLocale();
  const strings = t(locale);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const askSettings = useRpc(getSettings);
  const askCreate = useRpc(createEvent);
  const queries = useQueryClient();

  const [wanted, setWanted] = useState({ accountId: "", calendarId: "" });
  const [title, setTitle] = useState("");
  // Opens on the next quarter hour rather than blank: it is the likeliest start, and the
  // picker opens on whatever this holds.
  const [start, setStart] = useState(() => defaultStartText(new Date()));
  const [duration, setDuration] = useState("30");
  const [description, setDescription] = useState("");
  // Problems are computed on every keystroke but only shown once someone has asked to move
  // on: a form that turns red before it has been filled in is just noise.
  const [showProblems, setShowProblems] = useState(false);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [error, setError] = useState("");
  // The answer to Create never arrived, so the event may exist: the confirmation then offers only
  // the way back to the board, never Create again (createOutcome).
  const [uncertain, setUncertain] = useState("");
  // Closed synchronously by the Create handler, before React can be asked to re-render. A
  // `disabled` prop is only committed after that render, so it cannot guard the press that
  // lands in between — and that press would create a second real event. One per mounted
  // form, so a create that has already left the screen cannot hold the next one shut.
  const latchRef = useRef<SubmitLatch | null>(null);
  if (!latchRef.current) latchRef.current = createSubmitLatch();
  const latch = latchRef.current;

  const settings = useQuery({
    // Same key as the settings surface, so whichever screen asked first pays for it.
    queryKey: ["calendar", "settings"],
    queryFn: () => askSettings({}),
    // Asked again after a failure, as settingsLoadError's "Retrying…" says.
    refetchInterval: (query) => (query.state.status === "error" ? ERROR_RETRY_MS : false),
  });

  const accounts: AccountView[] = settings.data?.accounts ?? [];
  // Only accounts a new event can be written to are offered; a calendar switched off in
  // Settings stays one of them (see writableAccounts).
  const offered = useMemo(() => writableAccounts(accounts), [accounts]);
  // Derived, never stored: a calendar id left over from a previously chosen account cannot
  // survive into the request (see pickSelection).
  const selection = useMemo(() => pickSelection(offered, wanted), [offered, wanted]);
  const account = offered.find((entry) => entry.id === selection.accountId) ?? null;

  const built = useMemo(
    () =>
      buildCreateInput({
        accountId: selection.accountId,
        calendarId: selection.calendarId,
        title,
        start,
        duration,
        description,
      }),
    [selection, title, start, duration, description],
  );

  const create = useMutation({
    mutationFn: (fields: CreateFields) => askCreate(fields),
    onSuccess(result) {
      // The handler answers { event: null, error } for a write EventKit refused, and rejects
      // only when the call itself could not be made — both have to land somewhere visible.
      if (result.error) {
        setError(result.error);
        return;
      }
      setError("");
      // The board is refreshed rather than patched: sync.ts create() has already refreshed
      // its snapshot before answering, and one source of truth for the agenda is worth more
      // than an instant row.
      void queries.invalidateQueries({ queryKey: ["calendar"] });
      // The pill reads no react-query key, so it is asked on its own: the new meeting may be
      // the next one.
      nudgePill();
      onBack();
    },
    onError(thrown) {
      if (createOutcome({ thrown }) !== "uncertain") return;
      // The daemon may have written the event and lost only the answer; the board is read again
      // so that what it shows when the user goes back is the truth either way.
      setUncertain(thrown instanceof Error ? thrown.message : String(thrown));
      void queries.invalidateQueries({ queryKey: ["calendar"] });
      nudgePill();
    },
    // Hook-level rather than passed to mutate(): the mutation itself runs this on both
    // outcomes, where a per-call callback belongs to an observer that a successful create
    // has already begun to unmount. A latch that can stick shut is worse than no latch.
    onSettled() {
      latch.release();
    },
  });

  const styles = useMemo(
    () => ({
      back: { color: theme.colors.foregroundMuted, fontSize: 13 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        textTransform: "uppercase" as const,
        letterSpacing: 0.5,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: RADIUS.card,
        padding: 16,
        gap: 10,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      email: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const, flex: 1 },
      value: { color: theme.colors.foreground, fontSize: 14 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: RADIUS.control,
        paddingVertical: 9,
        paddingHorizontal: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
      },
      // A multi-line field that still looks like a field when it is empty.
      area: { minHeight: 64, textAlignVertical: "top" as const },
      choice: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: RADIUS.pill,
        paddingVertical: 7,
        paddingHorizontal: 12,
      },
      chosen: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      choiceText: { color: theme.colors.foregroundMuted, fontSize: 13 },
      chosenText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      button: { backgroundColor: theme.colors.accent, borderRadius: RADIUS.control, padding: 10 },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const, fontWeight: "600" as const },
      ghost: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.control, padding: 10 },
      ghostText: { color: theme.colors.foregroundMuted, textAlign: "center" as const },
      // Same colours either way — only the opacity changes — so a disabled control never
      // reads as a second, undocumented theme (mirrors settings.tsx).
      disabled: { opacity: 0.5 },
    }),
    [theme, layout.compact],
  );

  function review() {
    if (!built.ok || !account) {
      setShowProblems(true);
      return;
    }
    setError("");
    setConfirming({
      fields: built.fields,
      account: accountLabel(account),
      calendarName: account.calendars.find((entry) => entry.id === built.fields.calendarId)?.name ?? built.fields.calendarId,
      hidden: isHiddenTarget(offered, { accountId: built.fields.accountId, calendarId: built.fields.calendarId }),
    });
  }

  if (confirming) {
    return (
      <Screen theme={theme} layout={layout}>
        <Text style={styles.title}>{strings.confirmTitle}</Text>

        <View style={styles.card}>
          <Text style={styles.label}>{strings.titleLabel}</Text>
          <Text style={styles.value}>{confirming.fields.title}</Text>
          <Text style={styles.label}>{strings.whenLabel}</Text>
          <Text style={styles.value}>{formatRange(confirming.fields.start, confirming.fields.end, locale)}</Text>
          <Text style={styles.label}>{strings.calendarLabel}</Text>
          <Text style={styles.value}>{`${confirming.calendarName} · ${confirming.account}`}</Text>
        </View>

        {/* What EventKit will actually do: it writes to the store on this Mac and sends
            nothing at all. */}
        <Text style={styles.muted}>{strings.confirmLocalOnly}</Text>
        {/* The board reads shown calendars only: said before the write, not discovered after. */}
        {confirming.hidden ? <Text style={styles.muted}>{strings.confirmHiddenCalendar}</Text> : null}

        {create.isPending ? <Text style={styles.muted}>{strings.createQueuedNote}</Text> : null}
        {error ? <Text style={styles.danger}>{errorText(error, strings)}</Text> : null}
        {uncertain ? <Text style={styles.danger}>{strings.createMaybeSaved(uncertain)}</Text> : null}

        {uncertain ? (
          <Pressable accessibilityRole="button" style={styles.button} onPress={onBack}>
            <Text style={styles.buttonText}>{strings.back}</Text>
          </Pressable>
        ) : (
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: create.isPending }}
              disabled={create.isPending}
              style={[styles.ghost, { flex: 1 }, create.isPending ? styles.disabled : null]}
              // Same latch, same race: Cancel is the one control that must never act against
              // a write already under way, and `disabled` alone would let it.
              onPress={() => {
                if (latch.held()) return;
                setConfirming(null);
                setError("");
              }}
            >
              <Text style={styles.ghostText}>{strings.cancel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: create.isPending }}
              disabled={create.isPending}
              style={[styles.button, { flex: 1 }, create.isPending ? styles.disabled : null]}
              onPress={() => {
                if (!latch.claim()) return;
                create.mutate(confirming.fields);
              }}
            >
              <Text style={styles.buttonText}>{create.isPending ? strings.creating : strings.create}</Text>
            </Pressable>
          </View>
        )}
      </Screen>
    );
  }

  return (
    <Screen theme={theme} layout={layout}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.back}
        hitSlop={8}
        style={{ alignSelf: "flex-start", paddingVertical: 6 }}
        onPress={onBack}
      >
        <Text style={styles.back}>{`‹ ${strings.back}`}</Text>
      </Pressable>
      <Text style={styles.title}>{strings.createTitle}</Text>

      {settings.isLoading ? (
        <Text style={styles.muted}>{strings.loadingSettings}</Text>
      ) : settings.isError ? (
        <Text style={styles.danger}>{strings.settingsLoadError}</Text>
      ) : accounts.length === 0 ? (
        <Text style={styles.muted}>{strings.createNeedsAccount}</Text>
      ) : offered.length === 0 ? (
        <Text style={styles.muted}>{strings.createNoWritable}</Text>
      ) : null}

      <Text style={styles.label}>{strings.calendarLabel}</Text>
      {offered.map((entry) => (
        <View key={entry.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.email} numberOfLines={1}>
              {accountLabel(entry)}
            </Text>
          </View>
          {entry.calendars.map((calendar) => {
            const chosen = selection.accountId === entry.id && selection.calendarId === calendar.id;
            return (
              <Pressable
                key={calendar.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen }}
                style={[styles.choice, chosen ? styles.chosen : null]}
                onPress={() => setWanted({ accountId: entry.id, calendarId: calendar.id })}
              >
                <Text style={chosen ? styles.chosenText : styles.choiceText}>{calendar.name}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}

      <Text style={styles.label}>{strings.titleLabel}</Text>
      <TextInput
        style={styles.input}
        placeholder={strings.titleLabel}
        placeholderTextColor={theme.colors.foregroundMuted}
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.label}>{strings.startLabel}</Text>
      {/* A calendar, not a keyboard. The value handed on is the "YYYY-MM-DDTHH:mm"
          create-input.ts is promised, assembled from what was tapped rather than typed. */}
      <WhenPicker
        value={start}
        theme={theme}
        locale={locale}
        strings={strings}
        style={styles.input}
        onChange={setStart}
      />
      <Text style={styles.muted}>{strings.startHint(zone)}</Text>

      <Text style={styles.label}>{strings.durationLabel}</Text>
      <TextInput
        style={styles.input}
        placeholder={strings.durationLabel}
        placeholderTextColor={theme.colors.foregroundMuted}
        keyboardType="number-pad"
        value={duration}
        onChangeText={setDuration}
      />

      <Text style={styles.label}>{strings.descriptionLabel}</Text>
      <TextInput
        style={[styles.input, styles.area]}
        placeholder={strings.descriptionLabel}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        value={description}
        onChangeText={setDescription}
      />

      {showProblems && !built.ok
        ? built.problems.map((problem) => (
            <Text key={problem} style={styles.danger}>
              {problemText(problem, strings)}
            </Text>
          ))
        : null}

      {/* Review, never Create: the RPC is unreachable from this screen. */}
      <Pressable accessibilityRole="button" style={styles.button} onPress={review}>
        <Text style={styles.buttonText}>{strings.review}</Text>
      </Pressable>
    </Screen>
  );
}
