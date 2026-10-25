import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import {
  type AccountView,
  type BoardView,
  type SettingsView,
  connectAccount,
  disconnectAccount,
  getSettings,
  requestAccess,
  setCalendars,
  setDefaultView,
  setPillLead,
} from "../shared/calendar.ts";
import { type Strings, detectAppLocale, t } from "../shared/i18n.ts";
import { type CalendarToggle, applyToggles, toggleKey } from "./calendar-toggles.ts";
import { PRIVACY_URL, asideName, issueText, privacyActionAvailable, rowProblem } from "./issues.ts";
import { announcePillLead, nudgePill } from "./pill-watch.ts";
import {
  type AccountRowModel,
  accountRow,
  connectFailureKey,
  connectFinished,
  connectIssue,
  foundDetail,
  settingsPollMs,
  updatedText,
} from "./settings-model.ts";
import {
  Banner,
  Button,
  Card,
  Chip,
  EmptyState,
  Screen,
  ScreenHeader,
  SectionLabel,
  SkeletonCard,
  StatusDot,
} from "./ui.tsx";
import { useRelink } from "./use-relink.ts";

const SETTINGS_KEY = ["calendar", "settings"] as const;

/**
 * The button beside every macOS refusal: the pane that fixes it, rather than the route to it.
 * Only where it can open (privacyActionAvailable); a phone gets refusalText's words instead.
 */
function privacyAction(strings: Strings): { label: string; onPress: () => void } | undefined {
  if (!privacyActionAvailable(Platform.OS)) return undefined;
  return { label: strings.openPrivacy, onPress: () => void Linking.openURL(PRIVACY_URL).catch(() => {}) };
}

/** A refusal's words, saying it is done on the Mac where the button above cannot be offered. */
function refusalText(text: string, strings: Strings): string {
  return privacyActionAvailable(Platform.OS) ? text : `${text} ${strings.onTheMac}`;
}

/**
 * Failed connects already shown on an earlier visit to this screen, by connectFailureKey. The
 * daemon keeps the last job until the next connect; module-level, because each visit mounts the
 * screen afresh, and cleared when a new connect starts.
 */
const shownFailures = new Set<string>();

/** A glyph per source kind, so a list of accounts is scannable before any of it is read. */
function sourceIcon(kind: string): string {
  switch (kind) {
    case "exchange":
      return "Building2";
    case "icloud":
      return "Cloud";
    case "caldav":
      return "Globe";
    case "birthdays":
      return "Cake";
    case "subscribed":
      return "Rss";
    default:
      return "HardDrive";
  }
}

/** The square tile every row leads with, so accounts and found sources share one rhythm. */
function Tile({ theme, icon, size = 36 }: { theme: PluginTheme; icon: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Icon name={icon} size={Math.round(size / 2)} color={theme.colors.foregroundMuted} />
    </View>
  );
}

/** One source this Mac has and no row reads, with its Add button trailing. */
function ChoiceRow({
  theme,
  icon,
  title,
  detail,
  trailing,
}: {
  theme: PluginTheme;
  icon: string;
  title: string;
  detail: string;
  trailing: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Tile theme={theme} icon={icon} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{detail}</Text>
      </View>
      {trailing}
    </View>
  );
}

/**
 * One account as a single line that opens in place. Everything about it except its name, its
 * kind and its health waits behind the tap, so four accounts fit on a phone without scrolling.
 * The relink offer is the exception: it stays visible collapsed, since the row is not being read
 * until somebody accepts it.
 */
function AccountRow({
  account,
  model,
  theme,
  strings,
  compact,
  separated,
  expanded,
  confirming,
  disconnecting,
  error,
  connectBusy,
  pending,
  onToggleExpanded,
  onRelink,
  onReread,
  onToggleCalendar,
  onAskDisconnect,
  onCancelDisconnect,
  onDisconnect,
}: {
  account: AccountView;
  model: AccountRowModel;
  theme: PluginTheme;
  strings: Strings;
  compact: boolean;
  /** Every row after the first draws the rule above itself. */
  separated: boolean;
  expanded: boolean;
  confirming: boolean;
  disconnecting: boolean;
  error: string;
  connectBusy: boolean;
  /** Whether this account's calendar has a toggle on its way to the daemon. */
  pending: (calendarId: string) => boolean;
  onToggleExpanded: () => void;
  onRelink: () => void;
  onReread: () => void;
  onToggleCalendar: (calendarId: string, next: boolean) => void;
  onAskDisconnect: () => void;
  onCancelDisconnect: () => void;
  onDisconnect: () => void;
}) {
  const padding = compact ? 10 : 12;
  const problem = rowProblem(account, strings);
  return (
    <View style={separated ? { borderTopWidth: 1, borderColor: theme.colors.border } : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={strings.accountRowA11y(model.label)}
        // The kind, the calendar count and the health that the second line shows by sight.
        accessibilityHint={model.subtitle}
        onPress={onToggleExpanded}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, padding }}
      >
        <Tile theme={theme} icon={sourceIcon(account.kind)} size={compact ? 32 : 36} />
        <View style={{ flex: 1, gap: 2, opacity: model.greyed ? 0.55 : 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>
            {model.label}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {model.subtitle}
          </Text>
        </View>
        <StatusDot theme={theme} tone={model.health} />
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>

      {model.relink || expanded ? (
        <View style={{ gap: 10, paddingHorizontal: padding, paddingBottom: padding }}>
          {model.relink ? (
            <Banner
              theme={theme}
              tone="warn"
              text={strings.relinkHint}
              action={{ label: strings.relinkOffer(model.relink.title), onPress: onRelink }}
            />
          ) : null}

          {expanded ? (
            <>
              <View style={{ gap: 8 }}>
                <SectionLabel theme={theme}>{strings.calendarsLabel}</SectionLabel>
                {model.reread ? (
                  <Button
                    theme={theme}
                    label={strings.rereadCalendars}
                    variant="ghost"
                    disabled={connectBusy}
                    onPress={onReread}
                  />
                ) : (
                  // Chips rather than a column of switches: which calendars are on is a set, and
                  // a set reads faster as filled and hollow pills than as a list of toggles.
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {account.calendars.map((calendar) => (
                      <Chip
                        key={calendar.id}
                        theme={theme}
                        hitSlop={3}
                        label={calendar.name}
                        selected={calendar.shown}
                        pending={pending(calendar.id)}
                        onPress={() => onToggleCalendar(calendar.id, !calendar.shown)}
                      />
                    ))}
                  </View>
                )}
              </View>

              {problem ? (
                <Banner
                  theme={theme}
                  tone="bad"
                  text={account.errorCode === "access_needed" ? refusalText(problem, strings) : problem}
                  action={account.errorCode === "access_needed" ? privacyAction(strings) : undefined}
                />
              ) : null}
              {error ? <Banner theme={theme} tone="bad" text={error} /> : null}

              {confirming ? (
                <View style={{ gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }}>
                    {strings.disconnectConfirm(model.label)}
                  </Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    <Button
                      theme={theme}
                      label={strings.cancel}
                      variant="ghost"
                      disabled={disconnecting}
                      onPress={onCancelDisconnect}
                    />
                    <Button
                      theme={theme}
                      label={disconnecting ? strings.working : strings.disconnect}
                      variant="danger"
                      disabled={disconnecting}
                      onPress={onDisconnect}
                    />
                  </View>
                </View>
              ) : (
                <Button theme={theme} label={strings.disconnect} variant="ghost" onPress={onAskDisconnect} />
              )}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function SettingsSurface({ theme, layout }: PluginSurfaceProps) {
  const locale = detectAppLocale();
  const strings = t(locale);
  const askSettings = useRpc(getSettings);
  const askConnect = useRpc(connectAccount);
  const askDisconnect = useRpc(disconnectAccount);
  const askCalendars = useRpc(setCalendars);
  const askPillLead = useRpc(setPillLead);
  const askDefaultView = useRpc(setDefaultView);
  const askAccess = useRpc(requestAccess);
  const queries = useQueryClient();
  const relink = useRelink();

  // A ref, not state: the success path re-applies the toggles still in flight as of that moment.
  const inFlight = useRef(new Map<string, CalendarToggle>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<string | null>(null);
  // Per-row errors: a disconnect, a relink or a calendar toggle can fail on its own (transport
  // failure, daemon restart) independently of anything else on screen. Keyed by row id (and
  // `rowId:calendarId` for a toggle) so clearing one on its own success cannot erase another.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => askSettings({}),
    refetchInterval: (query) =>
      settingsPollMs(query.state.data, { failed: query.state.status === "error", reads: query.state.dataUpdateCount }),
  });

  const access = settings.data?.access ?? "unknown";
  const job = settings.data?.connect ?? null;

  // The RPC settles once the job has started, not finished (connectJob), so the board and the pill
  // are told when the poll below sees it end: the daemon marks it done only once its snapshot has
  // the new row's meetings, so a read then finds them.
  const seenJob = useRef<string | undefined>(undefined);
  const seenOnOpen = useRef(new Set(shownFailures));
  useEffect(() => {
    if (connectFinished(seenJob.current, job?.state)) {
      void queries.invalidateQueries({ queryKey: ["calendar", "events"] });
      void queries.invalidateQueries({ queryKey: ["calendar", "range"] });
      nudgePill();
    }
    // A new connect makes any earlier failure old news, and its own failure news again.
    if (job?.state === "running") {
      shownFailures.clear();
      seenOnOpen.current.clear();
    }
    seenJob.current = job?.state;
  }, [job?.state, queries]);

  // A failure shown on an earlier visit is not shown again. Each visit marks the one it showed
  // when it closes, so the visit that saw it happen keeps its banner for as long as it is open.
  const failureKey = connectFailureKey(job);
  const latestFailure = useRef("");
  latestFailure.current = failureKey;
  useEffect(
    () => () => {
      if (latestFailure.current) shownFailures.add(latestFailure.current);
    },
    [],
  );

  const connect = useMutation({
    mutationFn: (sourceId: string) => askConnect({ sourceId }),
    onSettled() {
      void queries.invalidateQueries({ queryKey: ["calendar", "settings"] });
    },
  });
  const connectBusy = connect.isPending || job?.state === "running";

  const pillLead = useMutation({
    mutationFn: (minutes: number) => askPillLead({ minutes }),
    onSuccess(view) {
      // Written straight into the cache rather than invalidated, so the chip shows the choice
      // at once. The pill no longer reads react-query, so it is told directly: otherwise it
      // would follow only at its own ten-minute read of the lead time.
      queries.setQueryData(["calendar", "settings"], view);
      announcePillLead(view.pillLeadMinutes);
    },
  });

  const defaultView = useMutation({
    mutationFn: (view: BoardView) => askDefaultView({ view }),
    onSuccess(next) {
      // Straight into the cache, like the lead time above and for the same reason: the
      // board reads this very key, and a chip that took until the next poll to be believed
      // would look like it had not registered the press.
      queries.setQueryData(["calendar", "settings"], next);
    },
  });

  const grant = useMutation({
    mutationFn: () => askAccess({}),
    onSettled() {
      void queries.invalidateQueries({ queryKey: ["calendar", "settings"] });
    },
  });

  function setRowError(key: string, message: string) {
    setRowErrors((prev) => ({ ...prev, [key]: message }));
  }

  function clearRowError(key: string) {
    setRowErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** The row's own error, else the first of its calendar toggles' errors. */
  function rowError(id: string): string {
    if (rowErrors[id]) return rowErrors[id];
    const toggle = Object.entries(rowErrors).find(([key]) => key.startsWith(`${id}:`));
    return toggle ? toggle[1] : "";
  }

  async function withRow(key: string, action: () => Promise<unknown>) {
    try {
      await action();
      clearRowError(key);
    } catch (thrown) {
      setRowError(key, thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      void queries.invalidateQueries({ queryKey: ["calendar"] });
      // A disconnected row can change which meeting is next, and the pill reads no react-query
      // key, so it is asked on its own.
      nudgePill();
    }
  }

  /**
   * A calendar chip, shown at once: the cache takes the new value before the daemon has heard of
   * it, and the daemon's answer (or its failure) only confirms or undoes that. Not through
   * withRow, which would invalidate the whole of ["calendar"] and leave the chip showing the old
   * value until the settings read came back.
   */
  async function toggleCalendar(toggle: CalendarToggle) {
    const key = toggleKey(toggle);
    if (inFlight.current.has(key)) return; // one write per chip at a time
    inFlight.current.set(key, toggle);
    setPendingKeys(new Set(inFlight.current.keys()));
    await queries.cancelQueries({ queryKey: SETTINGS_KEY }); // a settings read on its way would land the old value on top
    queries.setQueryData<SettingsView>(SETTINGS_KEY, (view) => (view ? applyToggles(view, [toggle]) : view));
    try {
      const view = await askCalendars({ accountId: toggle.accountId, shown: { [toggle.calendarId]: toggle.shown } });
      inFlight.current.delete(key);
      // The answer was computed before any toggle still in flight was written, so it is dressed
      // with them again; otherwise a neighbour's chip would flick back until its own answer.
      queries.setQueryData(SETTINGS_KEY, applyToggles(view, [...inFlight.current.values()]));
      clearRowError(key);
    } catch (thrown) {
      inFlight.current.delete(key);
      // The inverse of this one toggle rather than the cache as it was before it, so a neighbour's
      // change made meanwhile survives.
      queries.setQueryData<SettingsView>(SETTINGS_KEY, (view) =>
        view ? applyToggles(view, [{ ...toggle, shown: !toggle.shown }]) : view,
      );
      setRowError(key, thrown instanceof Error ? thrown.message : String(thrown));
      // The daemon may have written before the call failed; ask for the truth once nothing else is in flight.
      if (inFlight.current.size === 0) void queries.invalidateQueries({ queryKey: SETTINGS_KEY });
    } finally {
      setPendingKeys(new Set(inFlight.current.keys()));
      // Which meetings the board shows follows from which calendars are on. The daemon answered
      // only after its own refresh, so these read the new state.
      void queries.invalidateQueries({ queryKey: ["calendar", "events"] });
      void queries.invalidateQueries({ queryKey: ["calendar", "range"] });
      nudgePill();
    }
  }

  function startRelink(account: AccountView, sourceId: string) {
    if (relink.isPending) return;
    relink.mutate(
      { accountId: account.id, sourceId },
      {
        onSuccess(result) {
          if (!result.error) return clearRowError(account.id);
          setRowError(account.id, strings.relinkFailed(result.error));
          // The row error is drawn in the opened row, so a refusal on a closed one opens it.
          setExpandedId(account.id);
        },
        onError(thrown) {
          setRowError(account.id, strings.relinkFailed(thrown.message));
          setExpandedId(account.id);
        },
      },
    );
  }

  const accounts: AccountView[] = settings.data?.accounts ?? [];
  const found = settings.data?.found ?? [];
  const failedConnect = connectIssue(job, accounts, found, {
    seen: seenOnOpen.current.has(failureKey),
    storeBanner: settings.data?.storeBroken ?? false,
  });

  return (
    <Screen theme={theme} layout={layout}>
      <ScreenHeader
        theme={theme}
        layout={layout}
        icon="CalendarDays"
        title={strings.settingsTitle}
        subtitle={updatedText(accounts, Date.now(), strings, locale) || strings.settingsSubtitle}
      />

      {/* Nothing is saved while the store reads as broken, so a change made here would snap back
          without this saying why. issueStoreBroken words both cases: a copy set aside, or none. */}
      {settings.data?.storeBroken ? (
        <Banner theme={theme} tone="bad" text={strings.issueStoreBroken(asideName(settings.data.storeAside))} />
      ) : null}

      {job?.state === "running" ? (
        <Banner theme={theme} tone="info" text={strings.connectRunningSystem} />
      ) : failedConnect ? (
        <Banner
          theme={theme}
          tone="bad"
          text={
            failedConnect.code === "access_needed"
              ? refusalText(issueText(failedConnect.code, failedConnect.message, failedConnect.label, strings), strings)
              : issueText(failedConnect.code, failedConnect.message, failedConnect.label, strings)
          }
          action={failedConnect.code === "access_needed" ? privacyAction(strings) : undefined}
        />
      ) : null}

      <SectionLabel theme={theme}>{strings.accountsSection}</SectionLabel>

      {settings.isLoading ? (
        <>
          <SkeletonCard theme={theme} />
          <SkeletonCard theme={theme} lines={1} />
        </>
      ) : settings.isError ? (
        <Banner theme={theme} tone="bad" text={strings.settingsLoadError} />
      ) : accounts.length === 0 ? (
        <Card theme={theme}>
          <EmptyState theme={theme} icon="CalendarDays" title={strings.noAccounts} detail={strings.noAccountsHint} />
        </Card>
      ) : (
        <Card theme={theme} style={{ padding: 0, gap: 0 }}>
          {accounts.map((account, index) => {
            const model = accountRow(account, strings, locale);
            return (
              <AccountRow
                key={account.id}
                account={account}
                model={model}
                theme={theme}
                strings={strings}
                compact={layout.compact}
                separated={index > 0}
                expanded={expandedId === account.id}
                confirming={confirmingId === account.id}
                disconnecting={pendingDisconnect === account.id}
                error={rowError(account.id)}
                connectBusy={connectBusy}
                pending={(calendarId) => pendingKeys.has(toggleKey({ accountId: account.id, calendarId }))}
                onToggleExpanded={() => {
                  setExpandedId((open) => (open === account.id ? null : account.id));
                  // A confirmation belongs to the row it was asked in; it does not survive the
                  // row closing or another one opening.
                  setConfirmingId(null);
                }}
                onRelink={() => model.relink && startRelink(account, model.relink.sourceId)}
                onReread={() => connect.mutate(account.sourceId)}
                onToggleCalendar={(calendarId, next) =>
                  void toggleCalendar({ accountId: account.id, calendarId, shown: next })
                }
                onAskDisconnect={() => setConfirmingId(account.id)}
                onCancelDisconnect={() => setConfirmingId(null)}
                onDisconnect={() => {
                  setPendingDisconnect(account.id);
                  const disconnect = async () => {
                    // ok is false when a broken store refused the write; the row stays, and says so.
                    if (!(await askDisconnect({ accountId: account.id })).ok) throw new Error(strings.notSaved);
                  };
                  void withRow(account.id, disconnect).finally(() => {
                    // Only this row's: another row's confirmation, asked meanwhile, stays open.
                    setPendingDisconnect((id) => (id === account.id ? null : id));
                    setConfirmingId((id) => (id === account.id ? null : id));
                  });
                }}
              />
            );
          })}
        </Card>
      )}

      {/* Only once Settings has answered: while it loads, or after it failed, access reads as
          "unknown" and the Allow access card would flash on a Mac that granted it long ago. */}
      {!settings.data ? null : access === "granted" ? (
        <>
          <SectionLabel theme={theme}>{strings.foundSection}</SectionLabel>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{strings.foundHint}</Text>
          {found.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
              {settings.data?.foundFailed ? strings.foundFailed : strings.foundNone}
            </Text>
          ) : (
            <View style={{ gap: 8 }}>
              {found.map((source) => (
                <ChoiceRow
                  key={source.id}
                  theme={theme}
                  icon={sourceIcon(source.kind)}
                  title={source.title}
                  detail={foundDetail(source, strings)}
                  trailing={
                    <Button
                      theme={theme}
                      label={strings.addSource}
                      variant="ghost"
                      disabled={connectBusy}
                      onPress={() => connect.mutate(source.id)}
                    />
                  }
                />
              ))}
            </View>
          )}
        </>
      ) : access === "asking" ? (
        <Banner theme={theme} tone="info" text={strings.accessAsking} />
      ) : (
        <Card theme={theme}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{strings.systemBlurb}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
            {strings.grantAccessWhy}
          </Text>
          {access === "denied" ? (
            <Banner
              theme={theme}
              tone="warn"
              text={refusalText(strings.calendarAccessRefused, strings)}
              action={privacyAction(strings)}
            />
          ) : null}
          <Button
            theme={theme}
            label={strings.grantAccess}
            icon="Laptop"
            disabled={grant.isPending}
            onPress={() => grant.mutate()}
          />
          {/* The helper could not ask at all (no Xcode Command Line Tools, a launch that failed):
              not a refusal, so the button stays, and this says what went wrong. */}
          {settings.data?.accessError ? (
            <Banner theme={theme} tone="bad" text={strings.issueHelper(settings.data.accessError)} />
          ) : null}
        </Card>
      )}

      {/* Which view the board opens on. First of the preferences because it is the one
          somebody meets every time they open the plugin, and the chips are the board's own —
          the same three labels in the same order, so the choice looks like what it changes. */}
      <SectionLabel theme={theme}>{strings.defaultViewLabel}</SectionLabel>
      <Card theme={theme}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(["agenda", "day", "month"] as const).map((view) => (
            <Chip
              key={view}
              theme={theme}
              hitSlop={3}
              label={
                view === "agenda" ? strings.periodAgenda : view === "day" ? strings.periodDay : strings.periodMonth
              }
              // "day" while the first read is in flight, matching the board's own fallback:
              // two different guesses would show a chip the board disagrees with.
              selected={(settings.data?.defaultView ?? "day") === view}
              disabled={defaultView.isPending}
              onPress={() => defaultView.mutate(view)}
            />
          ))}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {strings.defaultViewHint}
        </Text>
      </Card>

      {/* Below the accounts, because it is about the composer rather than about any one of
          them — but on this screen, since it is the only one the plugin owns. */}
      <SectionLabel theme={theme}>{strings.pillLeadLabel}</SectionLabel>
      <Card theme={theme}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[0, 60, 30, 15, 10].map((minutes) => (
            <Chip
              key={minutes}
              theme={theme}
              hitSlop={3}
              label={minutes === 0 ? strings.pillLeadAlways : strings.pillLeadMinutes(minutes)}
              selected={(settings.data?.pillLeadMinutes ?? 30) === minutes}
              disabled={pillLead.isPending}
              onPress={() => pillLead.mutate(minutes)}
            />
          ))}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {strings.pillLeadHint}
        </Text>
      </Card>
    </Screen>
  );
}
