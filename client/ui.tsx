import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";

/**
 * The vocabulary every calendar surface draws with.
 *
 * It exists because the screens had grown their own private `styles` objects, each one
 * inventing its own radius, padding and muted grey, and none of them bounding the line
 * length — which is the whole of why the settings screen read as one stretched smear on a
 * wide monitor. The numbers live here once, so that no screen drifts away from the others
 * one hand-written card at a time.
 */

/** `layout` as the host hands it over; `PluginLayout` is not exported in 0.8. */
type Layout = PluginSurfaceProps["layout"];

/**
 * 760px, and centred past that.
 *
 * A settings screen is a column of prose and controls, not a table: past roughly 90
 * characters a line stops being scannable and the eye loses its place returning to the left
 * edge. Every full-width `ScrollView` in this plugin was missing exactly this one rule.
 */
export const MAX_WIDTH = 760;

export const RADIUS = { card: 16, control: 10, pill: 999 } as const;

/** Compact is the phone-shaped client, where a 24px gutter eats the content. */
export function gutterFor(layout: Layout): number {
  return layout.compact ? 16 : 24;
}

export function Screen({
  theme,
  layout,
  children,
}: {
  theme: PluginTheme;
  layout: Layout;
  children: ReactNode;
}) {
  const gutter = gutterFor(layout);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: gutter,
        gap: layout.compact ? 12 : 16,
        maxWidth: MAX_WIDTH,
        width: "100%",
        alignSelf: "center",
      }}
    >
      {children}
    </ScrollView>
  );
}

/**
 * The screen's opening line: an icon tile, a title, and a sentence saying what this is for.
 * Given its own component because all three surfaces had been opening with a bare `<Text>`
 * heading and then diving straight into controls, which is what made them feel unfinished.
 */
export function ScreenHeader({
  theme,
  layout,
  icon,
  title,
  subtitle,
  trailing,
}: {
  theme: PluginTheme;
  layout: Layout;
  icon: string;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        <Icon name={icon} size={22} color={theme.colors.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
          {title}
        </Text>
        {subtitle ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{subtitle}</Text> : null}
      </View>
      {trailing}
    </View>
  );
}

export function Card({
  theme,
  children,
  selected = false,
  style,
}: {
  theme: PluginTheme;
  children: ReactNode;
  /** Draws the accent border a connected account or a chosen mode earns. */
  selected?: boolean;
  style?: object;
}) {
  return (
    <View
      style={{
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderWidth: selected ? 2 : 1,
        borderRadius: RADIUS.card,
        padding: 16,
        gap: 10,
        ...style,
      }}
    >
      {children}
    </View>
  );
}

export function SectionLabel({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600",
        letterSpacing: 1,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

export function StatusDot({ theme, tone }: { theme: PluginTheme; tone: "ok" | "idle" | "warn" | "bad" }) {
  const colour = {
    ok: theme.colors.statusSuccess,
    idle: theme.colors.foregroundMuted,
    warn: theme.colors.statusWarning,
    bad: theme.colors.statusDanger,
  }[tone];
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />;
}

export function Chip({
  theme,
  label,
  selected = false,
  disabled = false,
  pending = false,
  hitSlop = 8,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  /** A change is on its way to the daemon: the chip already shows the new value, dimmed, and is not pressable. */
  pending?: boolean;
  /**
   * How far past its edge a tap still lands. A chip draws about 30 px tall and a finger needs
   * about 44, hence 8. A chip in a row of chips passes half the row's gap instead: where two
   * slops overlap, or one reaches into a neighbour, the later sibling takes the tap, so a wider
   * slop would turn a tap on one chip's edge into a tap on the next.
   */
  hitSlop?: number;
  onPress?: () => void;
}) {
  const body = (
    <View
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: RADIUS.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : "transparent",
        // Same colours either way, only the opacity drops: a disabled control must never
        // read as a second, undocumented theme (the rule the old screens already followed).
        // Pending dims a little less, since it is about to be full again and the chip's new
        // value should stay readable meanwhile.
        opacity: pending ? 0.6 : disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: disabled || pending, busy: pending }}
      disabled={disabled || pending}
      hitSlop={hitSlop}
      onPress={onPress}
    >
      {body}
    </Pressable>
  );
}

export function Button({
  theme,
  label,
  onPress,
  variant = "primary",
  disabled = false,
  icon,
  fill = false,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  icon?: string;
  /** Stretch to the row. Off by default: the old screens' edge-to-edge accent bar is
   *  exactly the thing that made the empty state look unbalanced. */
  fill?: boolean;
}) {
  const surface = {
    primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    ghost: { backgroundColor: "transparent", borderColor: theme.colors.border },
    danger: { backgroundColor: "transparent", borderColor: theme.colors.statusDanger },
  }[variant];
  const tint = {
    primary: theme.colors.accentForeground,
    ghost: theme.colors.foreground,
    danger: theme.colors.statusDanger,
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        ...surface,
        borderWidth: 1,
        borderRadius: RADIUS.control,
        paddingVertical: 10,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        alignSelf: fill ? "stretch" : "flex-start",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon ? <Icon name={icon} size={15} color={tint} /> : null}
      <Text style={{ color: tint, fontWeight: "600", fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * A failure, a caution or a hint, with somewhere to go about it.
 *
 * Errors used to be a bare red `<Text>` hanging under whatever had failed, which said what
 * went wrong and never what to do — the macOS permission refusal being the case that proved
 * it. An action slot is the point of this component, not decoration.
 */
export function Banner({
  theme,
  tone,
  text,
  action,
}: {
  theme: PluginTheme;
  tone: "info" | "warn" | "bad";
  text: string;
  /** `disabled` while the action's own work is in flight, so a second press is not invited. */
  action?: { label: string; onPress: () => void; disabled?: boolean };
}) {
  const { colour, icon } = {
    info: { colour: theme.colors.foregroundMuted, icon: "Info" },
    warn: { colour: theme.colors.statusWarning, icon: "TriangleAlert" },
    bad: { colour: theme.colors.statusDanger, icon: "CircleAlert" },
  }[tone];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: RADIUS.control,
        borderWidth: 1,
        borderColor: colour,
        // A tinted fill would need an alpha the theme does not expose, so the border and the
        // icon carry the tone and the surface stays the one underneath it.
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name={icon} size={15} color={colour} />
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={{ color: tone === "info" ? theme.colors.foreground : colour, fontSize: 13, lineHeight: 18 }}>
          {text}
        </Text>
        {action ? (
          <Button theme={theme} label={action.label} onPress={action.onPress} variant="ghost" disabled={action.disabled} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A block that breathes while something loads.
 *
 * Every surface here used to say "Loading…" in muted text, which tells a reader the screen
 * is alive but nothing about the shape of what is coming, so the layout jumps when it
 * arrives. A skeleton holds that shape. The pulse is opacity only — the one property the
 * native driver animates on every platform this renders on, so it never lands on the JS
 * thread while a fetch is resolving on it.
 */
export function Skeleton({
  theme,
  height = 14,
  width = "100%",
  radius = 6,
}: {
  theme: PluginTheme;
  height?: number;
  width?: number | `${number}%`;
  radius?: number;
}) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    animation.start();
    // Stopped on unmount: a loop left running holds a raf callback alive for the lifetime of
    // the surface, and these mount and unmount on every navigation between board and card.
    return () => animation.stop();
  }, [pulse]);

  return (
    <Animated.View
      accessibilityRole="progressbar"
      style={{ height, width, borderRadius: radius, backgroundColor: theme.colors.surface2, opacity: pulse }}
    />
  );
}

/** The skeleton standing in for one Card, so the empty screen has the right silhouette. */
export function SkeletonCard({ theme, lines = 2 }: { theme: PluginTheme; lines?: number }) {
  return (
    <Card theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Skeleton theme={theme} height={32} width={32} radius={8} />
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton theme={theme} height={13} width="55%" />
          <Skeleton theme={theme} height={11} width="35%" />
        </View>
      </View>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} theme={theme} height={11} width={index === lines - 1 ? "70%" : "100%"} />
      ))}
    </Card>
  );
}

/**
 * What a surface shows when the fetch succeeded and there is genuinely nothing — distinct
 * from loading, and distinct from failing. All three used to be one muted sentence.
 */
export function EmptyState({
  theme,
  icon,
  title,
  detail,
}: {
  theme: PluginTheme;
  icon: string;
  title: string;
  detail?: string;
}) {
  return (
    <View style={{ alignItems: "center", gap: 8, paddingVertical: 32 }}>
      <Icon name={icon} size={28} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
      {detail ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>{detail}</Text>
      ) : null}
    </View>
  );
}
