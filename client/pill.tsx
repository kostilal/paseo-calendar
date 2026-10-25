import type { PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated } from "react-native";
import { getEvents, getSettings } from "../shared/calendar.ts";
import { detectAppLocale, t } from "../shared/i18n.ts";
import { pulseFor } from "../shared/ladder.ts";
import { requestFocus } from "./focus.ts";
import { pillPatch } from "./pill-state.ts";
import { type PillWatch, createPillWatch } from "./pill-watch.ts";
import { createPillRegistry, trackAgents } from "./pill-registry.ts";

/**
 * The pill's icon: the next meeting's ladder step, in colour, with a soft pulse once it is
 * close. It only draws. Its state comes from the watch the client entry built, the same
 * snapshot the entry pushes `label` and `visible` from, so the icon and the text beside it
 * never disagree. It holds no RPC, no query and no timer: a hidden pill's icon is unmounted,
 * so nothing here could have brought it back anyway — see client/pill-watch.ts.
 */
function CalendarPillIcon({ theme, size, watch }: PluginButtonIconProps & { watch: PillWatch }) {
  const state = useSyncExternalStore(watch.subscribe, watch.snapshot, watch.snapshot);
  const pulse = useRef(new Animated.Value(1)).current;
  const pulseSpec = pulseFor(state.level);

  // Nothing moves at calm: pulseFor returns null there, and the effect below only ever starts
  // a loop when it returns a spec — tearing down whatever loop it started, both on a
  // re-render that changes the rung and on unmount, so a re-render can never leave a second
  // animation running alongside a first. Depth and speed both come from the rung, so ten
  // minutes out and one minute out are told apart at a glance rather than by reading.
  const dim = pulseSpec?.dim ?? 1;
  const durationMs = pulseSpec?.durationMs ?? 0;
  useEffect(() => {
    if (!durationMs) {
      pulse.setValue(1);
      return;
    }
    const half = Math.round(durationMs / 2);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: dim, duration: half, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: half, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [dim, durationMs, pulse]);

  // Running gets a colour of its own, checked ahead of the ladder rather than folded into
  // it: calm's neutral would make "under way" and "six hours out" indistinguishable at a
  // glance, and the ladder's warm/hot would wrongly imply an approach still in progress.
  const colour = state.running
    ? theme.colors.accent
    : state.level === "hot" || state.level === "urgent"
      ? theme.colors.statusDanger
      : state.level === "warm"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;

  return (
    <Animated.View style={{ opacity: pulse }}>
      <Icon name="CalendarDays" size={size} color={colour} />
    </Animated.View>
  );
}

/**
 * A pill belongs to one agent's composer, not to the plugin, so one is attached per agent
 * as the daemon reports them, and kept when the same agent is reported again in the same
 * workspace — the bookkeeping for that (the agentId -> registration map, the upsert/remove
 * discrimination) lives in pill-registry.ts, which knows nothing about React, react-native
 * or JSX and is what client/pill-registry.test.ts drives directly.
 *
 * This function is the other half, and the only writer of `label` and `visible` for every
 * pill. Two writers of one field disagree sooner or later (the sibling Chats plugin's pill
 * flickered between two languages that way), and a writer inside the icon cannot reach a
 * hidden pill at all. So the watch works the state out once, on its own clock; the
 * subscription below pushes it to every pill, hidden ones included; a pill created later
 * starts from the same snapshot; and the icon only draws.
 */
export function contributeClient(client: PluginClientContext) {
  const watch = createPillWatch({
    loadEvents: (since) => client.rpc(getEvents, { refresh: false, since }),
    loadLead: async () => (await client.rpc(getSettings, {})).pillLeadMinutes,
    strings: () => t(detectAppLocale()),
  });

  const registry = createPillRegistry({
    attach(agentId, workspaceId) {
      // Created from the snapshot every other pill was last told, so a new pill is never a
      // placeholder that the next push has to correct.
      const state = watch.snapshot();
      return client.addComposerPill({
        id: "calendar",
        workspaceId,
        agentId,
        button: {
          title: t(detectAppLocale()).sidebarTitle,
          label: state.label,
          icon: (props: PluginButtonIconProps) => <CalendarPillIcon {...props} watch={watch} />,
          visible: state.visible,
          behavior: {
            kind: "action",
            onPress() {
              // Post the meeting before opening the surface: the board collects it once its
              // events have arrived, which is strictly later than this. Without it, pressing
              // a pill that names one meeting lands on a list of twenty.
              const target = watch.snapshot().target;
              if (target) requestFocus(target);
              client.openSurface("board");
            },
          },
        },
      });
    },
  });

  // What every pill was last told. Seeded from the first snapshot, which is also what any
  // pill attached before the next change is created from, so nothing is pushed twice.
  const first = watch.snapshot();
  let pushed = { label: first.label, visible: first.visible };
  const unwatch = watch.subscribe(() => {
    const patch = pillPatch(pushed, watch.snapshot());
    if (!patch) return;
    pushed = patch;
    // Both in one update, so a pill appearing never shows the previous meeting's label for a
    // frame before the new one lands.
    registry.updateAll(patch);
  });

  const stopTracking = trackAgents(client.paseo.agents, registry);

  return () => {
    stopTracking();
    unwatch();
    watch.stop();
  };
}
