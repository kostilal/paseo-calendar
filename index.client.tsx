import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { detectAppLocale, t } from "./shared/i18n.ts";
import { BoardSurface } from "./client/board.tsx";
import { contributeClient as contributePill } from "./client/pill.tsx";
import { SettingsSurface } from "./client/settings.tsx";

export default function contribute(client: PluginClientContext) {
  // Paseo's own language, not the device's. Every surface below already resolves its
  // own through detectAppLocale; these two titles are fixed here, at registration, and
  // asking the device instead left them English beside a Russian app.
  const strings = t(detectAppLocale());

  // BoardSurface draws its own gear button, but addSurface only ever hands a component
  // PluginSurfaceProps — client.openSurface exists only here, at registration time — so
  // this closure is the one place that can give the board a way to reach settings.
  function Board(props: PluginSurfaceProps) {
    return <BoardSurface {...props} onOpenSettings={() => client.openSurface("settings")} />;
  }

  client.addSurface("board", Board);
  client.addSurface("settings", SettingsSurface);
  client.addSidebarItem({
    id: "board",
    title: strings.sidebarTitle,
    icon: "CalendarDays",
    surface: "board",
  });
  client.addCommandCenterItem({
    id: "settings",
    title: strings.commandCenterSettings,
    icon: "CalendarDays",
    context: "global",
    // English regardless of locale: these match the command palette's search box, not
    // something anyone reads.
    keywords: ["calendar", "accounts", "exchange", "outlook", "google", "icloud"],
    onSelect({ openSurface }) {
      openSurface("settings");
    },
  });

  // addClientSide is gone in 0.8; this file only ever loads in the client bundle, so the
  // composer pill's registration just runs here directly. Its own cleanup still has to be
  // chained through, since nothing else holds what it started: the agent-list subscription,
  // every pill it attached, and the pill's own events poll and 15-second clock.
  const stopPill = contributePill(client);

  return () => {
    stopPill();
  };
}
