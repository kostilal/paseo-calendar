import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { type EventView, type EventsView, getEvents, getSettings } from "../shared/calendar.ts";
import { agendaOf, eventKey, eventsByDay, partnersOf } from "../shared/group.ts";
import { type Strings, detectAppLocale, t } from "../shared/i18n.ts";
import {
  AGENDA_POLL_MS,
  browseRefetchMs,
  dayKey,
  formatIsoStamp,
  rangeFor,
  shift,
  type Period,
} from "../shared/period.ts";
import { clearFocus, pendingFocus, subscribeFocus } from "./focus.ts";
import { EventCard } from "./card.tsx";
import { keepUnchanged, providerPassDue, sinceOf } from "./events-cache.ts";
import { CreateSurface } from "./create.tsx";
import { type Issue, PRIVACY_URL, boardIssues, privacyActionAvailable, settingsStale } from "./issues.ts";
import { nudgePill } from "./pill-watch.ts";
import { Banner, Chip, EmptyState, Screen, SectionLabel, Skeleton } from "./ui.tsx";
import { useRelink } from "./use-relink.ts";
import { AgendaRows, DayView, MonthView } from "./views.tsx";

export interface BoardSurfaceProps extends PluginSurfaceProps {
  /**
   * Opens the settings surface. addSurface only ever hands a Component PluginSurfaceProps,
   * which carries no navigation to another surface, so index.client.tsx — the one place
   * holding client.openSurface — supplies this as an extra prop when it registers the board.
   */
  onOpenSettings: () => void;
}

/** "Today" and "Tomorrow" carry more at a glance than a weekday name; anything further out
 *  reads as a normal locale-formatted date rather than a hand-built string. */
function dayHeading(day: string, locale: string, strings: Strings): string {
  const now = new Date();
  if (day === dayKey(now)) return strings.today;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === dayKey(tomorrow)) return strings.tomorrow;
  return new Date(`${day}T00:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
}

/**
 * The wall clock, re-read every half minute.
 *
 * The board dims a meeting once it is over, and that has to keep being true while somebody
 * looks at it — a list that decided what had passed when it mounted would still be claiming
 * it an hour later, which is worse than not dimming at all. Half a minute, because nothing
 * here counts down: the only thing this buys is that a meeting stops looking current shortly
 * after it stops being current. A tick costs a render and nothing else — the events it
 * re-reads are already in react-query's cache.
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The agenda's silhouette while the first fetch is in flight: a day heading and some rows,
 *  so the list does not jump into place from a single line of muted text. */
function AgendaSkeleton({ theme }: { theme: PluginTheme }) {
  return (
    <View style={{ gap: 10 }}>
      <Skeleton theme={theme} height={11} width="22%" />
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Skeleton theme={theme} height={30} width={3} radius={2} />
          <Skeleton theme={theme} height={12} width={38} />
          <View style={{ flex: 1, gap: 5 }}>
            <Skeleton theme={theme} height={12} width={row === 1 ? "48%" : "68%"} />
            <Skeleton theme={theme} height={10} width="28%" />
          </View>
        </View>
      ))}
    </View>
  );
}

export function BoardSurface({ theme, layout, onOpenSettings }: BoardSurfaceProps) {
  const locale = detectAppLocale();
  const strings = t(locale);
  const askEvents = useRpc(getEvents);
  const askSettings = useRpc(getSettings);
  const queries = useQueryClient();
  const relink = useRelink();
  // A relink tapped on a banner that the server refused: said here, since a refusal also reads
  // Settings again, which can take the banner, and with it any sign of the failure, away.
  const [relinkError, setRelinkError] = useState("");
  const now = useNow();
  // The meeting as it was tapped. The card draws the newest copy of it (`shown` below), so an
  // edit that just saved is what the card and a second edit start from.
  const [open, setOpen] = useState<EventView | null>(null);
  // The create form lives inside the board, the same way the event card does: addSurface
  // hands a component no way back to another surface, and both of these are steps away from
  // the agenda that end by returning to it.
  const [creating, setCreating] = useState(false);
  // Which way of looking at the same events, and which day that view is centred on. The
  // agenda reads the daemon's fortnight; the day and the month each ask for their own window.
  //
  // Null means nobody has touched the chips yet, which is not the same as "the agenda": it is
  // what defers to the stored choice below. Tapping a chip fills this in and, for as long as
  // this surface stays mounted, outranks the setting — switching to the month to check a date
  // should not be undone by a settings read landing a moment later.
  const [chosenView, setChosenView] = useState<Period | null>(null);
  const [cursor, setCursor] = useState<Date>(() => new Date());

  /**
   * Which view this opens on, as the daemon has it.
   *
   * Its own query on the key the settings screen already uses, so changing the choice over
   * there is reflected here without a reload. It is deliberately not folded into the events
   * query: that one's focus refetch asks a provider (see wantsProviderRefresh below), and a
   * settings read has no business riding along with it.
   */
  const settings = useQuery({
    queryKey: ["calendar", "settings"],
    queryFn: () => askSettings({}),
    refetchOnWindowFocus: false,
  });

  // The day while the first settings read is in flight, for the same reason the pill guesses
  // 30 minutes rather than 0: the fallback should be the common answer, so the usual case
  // never flickers through a view nobody asked for.
  const period: Period = chosenView ?? settings.data?.defaultView ?? "day";

  // A client that regains focus gets a full fetch once more — a provider refresh, not another
  // read of the daemon's in-memory snapshot. refetchOnWindowFocus only gets to decide THAT a
  // refetch happens; queryFn is what actually runs, so this ref is how the decision reaches
  // it: set here, read and cleared there, so only the refetch that focus itself triggered ever
  // asks a provider. The 60s poll below must stay a snapshot read: a poll is not a reason to go
  // all the way to EventKit once a minute. Nor is every focus one: a focus soon after a pass
  // would only re-ask EventKit what it said a moment ago (providerPassDue), and the snapshot
  // read still runs, cheap with `since`.
  //
  // This component is the only observer of ["calendar", "events"]. The composer pill polls
  // through its own watch (client/pill-watch.ts), outside react-query, so no other observer
  // can take the focus refetch from this one.
  const wantsProviderRefresh = useRef(false);

  const events = useQuery({
    queryKey: ["calendar", "events"],
    queryFn: async () => {
      const previous = queries.getQueryData<EventsView>(["calendar", "events"]);
      const focused = wantsProviderRefresh.current;
      wantsProviderRefresh.current = false;
      const refresh = focused && providerPassDue(previous?.syncedAt ?? "", Date.now());
      // Sends back the version it holds, so a tick that changed nothing costs a few bytes and
      // the list keeps its very same array: no flicker, no re-sort.
      const answer = keepUnchanged(previous, await askEvents({ refresh, since: sinceOf(previous) }));
      // The day view is sliced from the snapshot this pass just replaced, and the daemon dropped
      // its cached ranges with it, so the browsed copies held here go too.
      if (refresh) void queries.invalidateQueries({ queryKey: ["calendar", "range"] });
      return answer;
    },
    // sync.ts ticks in the background every five minutes; this only keeps a board that has
    // been open a while from quietly drifting behind it, not a substitute for syncedAt.
    refetchInterval: AGENDA_POLL_MS,
    refetchOnWindowFocus: () => {
      wantsProviderRefresh.current = true;
      return true;
    },
  });

  // The settings query above never polls, so a tick is what tells it the rows may have moved
  // on: a relink offer or a newly connected row the board's banners must name. Keyed on the
  // snapshot's syncedAt, which moves once per tick; a browsed range's would move on every page.
  const seenSyncedAt = useRef<string | undefined>(undefined);
  const syncedAt = events.data?.syncedAt;
  useEffect(() => {
    if (settingsStale(seenSyncedAt.current, syncedAt)) {
      void queries.invalidateQueries({ queryKey: ["calendar", "settings"] });
    }
    if (syncedAt !== undefined) seenSyncedAt.current = syncedAt;
  }, [syncedAt, queries]);

  const range = useMemo(() => rangeFor(period, cursor), [period, cursor]);

  /**
   * The browsed window, as its own query.
   *
   * A separate query rather than a parameter on the one above, because that one is the
   * fortnight the agenda reads and its focus refetch is a provider pass — see the note on
   * wantsProviderRefresh. Paging to next March must not disturb any of that, and this way it
   * cannot: a different key, its own cache entry, and never a focus refetch of its own; the
   * events query drops these copies after the provider pass a focus asks for.
   *
   * A day inside the fortnight polls on the agenda's cadence: it is a slice of the daemon's
   * snapshot, so a tick's news, a banner included, reaches it within a minute at no cost. A month,
   * or a day outside the fortnight, does not poll, since it is a provider pass and is not something
   * that goes stale while you look at it; a read that failed is asked again (browseRefetchMs).
   */
  const browsed = useQuery({
    queryKey: ["calendar", "range", range ? `${range.from.toISOString()}|${range.to.toISOString()}` : ""],
    queryFn: () =>
      askEvents({ refresh: false, from: range?.from.toISOString(), to: range?.to.toISOString() }),
    enabled: range !== null,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => browseRefetchMs(period, cursor, new Date(), query.state.status === "error"),
    // The daemon caches the same range for a minute of its own; matching that here keeps a
    // step back and forth between two months from asking it anything at all.
    staleTime: 60_000,
  });

  const active = range ? browsed : events;

  // A manual refresh asks the daemon to sync now rather than waiting on the next tick. It
  // goes through the same RPC and the same serialized queue as a connect, so it can queue
  // behind one — isPending stays true for exactly as long as that takes, honestly.
  const refresh = useMutation({
    mutationFn: () => askEvents({ refresh: true }),
    onSuccess(result) {
      queries.setQueryData(["calendar", "events"], result);
      // The daemon drops its browsed ranges on a refresh, so the copies held here have to go
      // too — otherwise a month view would keep showing what it had before the refresh that
      // was asked for precisely because it looked wrong.
      void queries.invalidateQueries({ queryKey: ["calendar", "range"] });
      // And the pill, which reads no react-query key and would otherwise keep what it had
      // until its next minute's poll.
      nudgePill();
    },
  });

  // A pill press names a meeting; this is where that lands. It cannot be a one-shot read on
  // mount, because the press happens before this surface exists and its events arrive after
  // it does — so the request waits in focus.ts until the event it names can actually be
  // found, and only then is it cleared. Re-run on every events change for the same reason.
  useEffect(() => {
    const collect = () => {
      const wanted = pendingFocus();
      if (!wanted) return;
      const found = (events.data?.events ?? []).find((event) => eventKey(event) === wanted);
      if (!found) return;
      clearFocus();
      // Any step away from the agenda is abandoned: somebody who presses a pill mid-compose
      // means the meeting, not whatever half-filled form was open.
      setCreating(false);
      setOpen(found);
    };
    collect();
    // Also while already mounted: pressing the pill with the board open must still move it.
    return subscribeFocus(collect);
  }, [events.data]);

  // agendaOf both buckets by day and merges collisions into one row per group, in a single
  // pass over the whole fetch — a clash whose members straddle local midnight still renders
  // exactly once, at the day of its earliest member, rather than once per day it touches.
  const agenda = useMemo(
    () => agendaOf(events.data?.events ?? [], events.data?.clashes ?? []),
    [events.data],
  );

  // The opened meeting as the latest read has it, found by its key in the view it was opened
  // from and then the fortnight; the copy held since the tap only while neither has it.
  const shown = useMemo(() => {
    if (!open) return null;
    const key = eventKey(open);
    const find = (list: readonly EventView[] | undefined) => list?.find((event) => eventKey(event) === key);
    return find(active.data?.events) ?? find(events.data?.events) ?? open;
  }, [open, active.data, events.data]);

  // The card looks at one meeting at a time, so it gets only the partners that genuinely
  // overlap the opened event, each with its own duration — not a merged group's blanket
  // "worst pair", which can name a false collision when three or more events chain together.
  const collidesWith = useMemo(() => {
    if (!shown) return [];
    return partnersOf(shown, events.data?.events ?? [], events.data?.clashes ?? []);
  }, [shown, events.data]);

  if (creating) {
    return <CreateSurface theme={theme} layout={layout} onBack={() => setCreating(false)} />;
  }

  if (shown) {
    return (
      <EventCard
        event={shown}
        held={(events.data?.events ?? []).some((event) => eventKey(event) === eventKey(shown))}
        collidesWith={collidesWith}
        accounts={settings.data?.accounts}
        theme={theme}
        layout={layout}
        onBack={() => setOpen(null)}
      />
    );
  }

  const lastSynced = formatIsoStamp(active.data?.syncedAt ?? "", locale);
  const issues = boardIssues(active.data?.errors ?? [], settings.data?.accounts ?? [], strings);

  /** An issue's button, if it has one. A refused relink reads Settings again (landRelink), which
   *  takes a stale offer, and with it this banner, off the board; relinkError says why. */
  function actionOf(issue: Issue): { label: string; onPress: () => void; disabled?: boolean } | undefined {
    const action = issue.action;
    if (!action) return undefined;
    if (action.kind === "privacy") {
      // Only where the pane can open; elsewhere issueTextOf says it is done on the Mac.
      if (!privacyActionAvailable(Platform.OS)) return undefined;
      return { label: issue.actionLabel, onPress: () => void Linking.openURL(PRIVACY_URL).catch(() => {}) };
    }
    return {
      label: relink.isPending ? strings.working : issue.actionLabel,
      disabled: relink.isPending,
      onPress: () => {
        // One relink at a time: a second press would only be refused by the server.
        if (relink.isPending) return;
        setRelinkError("");
        relink.mutate(
          { accountId: action.accountId, sourceId: action.sourceId },
          {
            onSuccess(result) {
              if (result.error) setRelinkError(strings.relinkFailed(result.error));
            },
            onError(thrown) {
              setRelinkError(strings.relinkFailed(thrown.message));
            },
          },
        );
      },
    };
  }
  /** A banner's words, with where to act when its button cannot be offered here. */
  function issueTextOf(issue: Issue): string {
    const elsewhere = issue.action?.kind === "privacy" && !privacyActionAvailable(Platform.OS);
    return elsewhere ? `${issue.text} ${strings.onTheMac}` : issue.text;
  }
  // The icons draw about 30 px across, and a finger needs about 44: every icon button below
  // also takes hitSlop={8}, so a tap just outside one still lands.
  const iconButton = { padding: 7, borderRadius: 8 };
  const periodEvents = active.data?.events ?? [];

  /** What the ‹ › arrows are stepping through, named the way the viewer's locale names it. */
  const periodTitle =
    period === "day"
      ? cursor.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })
      : period === "month"
        ? cursor.toLocaleDateString(locale, { month: "long", year: "numeric" })
        : "";

  return (
    <Screen theme={theme} layout={layout}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
            {strings.sidebarTitle}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {lastSynced ? strings.lastSync(lastSynced) : ""}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.refresh}
          accessibilityState={{ disabled: refresh.isPending }}
          disabled={refresh.isPending}
          hitSlop={8}
          style={[iconButton, refresh.isPending ? { opacity: 0.5 } : null]}
          onPress={() => refresh.mutate()}
        >
          <Icon name="RefreshCw" size={17} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.createTitle}
          hitSlop={8}
          style={iconButton}
          onPress={() => setCreating(true)}
        >
          <Icon name="Plus" size={18} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.settings}
          hitSlop={8}
          style={iconButton}
          onPress={onOpenSettings}
        >
          <Icon name="Settings" size={17} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      {/* Three ways of reading the same events. The agenda is first: it answers "what is
          coming" without anybody having to navigate to a date. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["agenda", "day", "month"] as const).map((option) => (
          <Chip
            key={option}
            theme={theme}
            hitSlop={3}
            label={
              option === "agenda"
                ? strings.periodAgenda
                : option === "day"
                  ? strings.periodDay
                  : strings.periodMonth
            }
            selected={period === option}
            onPress={() => {
              // Every switch re-centres on now. Landing on last March because that is where
              // the previous view had wandered is never what was meant.
              setCursor(new Date());
              setChosenView(option);
            }}
          />
        ))}
      </View>

      {period !== "agenda" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.earlier}
            hitSlop={8}
            style={iconButton}
            onPress={() => setCursor((at) => shift(period, at, -1))}
          >
            <Icon name="ChevronLeft" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Text style={{ flex: 1, textAlign: "center", color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
            {periodTitle}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.later}
            hitSlop={8}
            style={iconButton}
            onPress={() => setCursor((at) => shift(period, at, 1))}
          >
            <Icon name="ChevronRight" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Chip theme={theme} label={strings.jumpToday} onPress={() => setCursor(new Date())} />
        </View>
      ) : null}

      {/* Non-fatal: one account failing must not hide the events the others already delivered,
          so these sit alongside the list, not instead of it. Which errors become a banner, and
          in what words, is boardIssues' to say; a gone account with nowhere to move is not one. */}
      {issues.map((issue) => (
        <Banner key={issue.key} theme={theme} tone={issue.tone} text={issueTextOf(issue)} action={actionOf(issue)} />
      ))}
      {relinkError ? <Banner theme={theme} tone="bad" text={relinkError} /> : null}
      {refresh.isError ? (
        <Banner
          theme={theme}
          tone="bad"
          text={strings.syncIssue(refresh.error instanceof Error ? refresh.error.message : String(refresh.error))}
        />
      ) : null}

      {active.isLoading ? (
        <AgendaSkeleton theme={theme} />
      ) : active.isError ? (
        <Banner theme={theme} tone="bad" text={strings.eventsLoadError} />
      ) : period === "day" ? (
        <DayView
          day={dayKey(cursor)}
          events={eventsByDay(periodEvents).get(dayKey(cursor)) ?? []}
          clashes={active.data?.clashes ?? []}
          theme={theme}
          locale={locale}
          strings={strings}
          now={now}
          onOpen={setOpen}
        />
      ) : period === "month" ? (
        <MonthView
          cursor={cursor}
          events={periodEvents}
          theme={theme}
          locale={locale}
          strings={strings}
          // Tapping a day drops into it rather than expanding in place: a cell 50px tall
          // cannot show a day's worth of meetings, and pretending otherwise means truncating
          // exactly the one somebody was looking for.
          onPickDay={(day) => {
            setCursor(day);
            setChosenView("day");
          }}
        />
      ) : agenda.length === 0 ? (
        // "Connect an account" only when there is none: a quiet fortnight on four accounts is
        // just a quiet fortnight.
        <EmptyState
          theme={theme}
          icon="CalendarDays"
          title={strings.nothingToday}
          detail={settings.data && settings.data.accounts.length === 0 ? strings.settingsSubtitle : undefined}
        />
      ) : null}

      {period !== "agenda" ? null : agenda.map((day) => (
        <View key={day.day} style={{ gap: 2 }}>
          <SectionLabel theme={theme}>{dayHeading(day.day, locale, strings)}</SectionLabel>
          <AgendaRows rows={day.rows} theme={theme} locale={locale} strings={strings} now={now} onOpen={setOpen} />
        </View>
      ))}
    </Screen>
  );
}
