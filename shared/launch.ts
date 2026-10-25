import type { Conference } from "./join.ts";

/**
 * Where a join link should be sent, and whether an installed app or a browser should get it.
 *
 * This exists because handing the link to the client did not work. The 0.8 SDK gives a plugin
 * no way to open anything outside Paseo (openExternalUrl came in 0.9, and on the desktop it
 * opens the system browser, not the Teams app), so `Linking.openURL` landed the URL in a window
 * inside the app, with none of the browser session the call needs. Google Meet answered "You
 * can't join this video call" because nobody was signed in there, and Teams answered with its
 * retired web entry point's "Classic Teams is no longer available", which reads like a stale
 * app and was in fact a page: classic Teams was not installed at all on the machine that
 * reported it.
 *
 * So the decision moves to the daemon, which runs on the person's own Mac and can hand a URL
 * to the system. The decision itself is kept pure here, with `installed` passed in, so every
 * branch can be tested without touching Spotlight or spawning anything.
 */

/** Both are checked: com.microsoft.teams2 is the current app, the other its predecessor. */
export const TEAMS_BUNDLE_IDS = ["com.microsoft.teams2", "com.microsoft.teams"] as const;

export interface LaunchPlan {
  /** What to hand the OS — a deep link for an app, the original URL for a browser. */
  target: string;
  via: "app" | "browser";
}

/**
 * Teams' own deep link for the same meeting. The documented pair is
 * `https://teams.microsoft.com/l/meetup-join/...` and `msteams:/l/meetup-join/...`, identical
 * past the host, so the conversion is exactly the prefix and nothing else is touched — the
 * query string carries the meeting context and mangling it would produce a link that opens
 * the app to nowhere.
 *
 * `null` when the URL is not that shape, which is the signal to use a browser rather than to
 * guess at a scheme.
 */
export function teamsDeepLink(url: string): string | null {
  const match = /^https:\/\/teams\.(?:microsoft|live)\.com\/(.+)$/i.exec(url.trim());
  return match ? `msteams:/${match[1]}` : null;
}

/**
 * Google Meet has no macOS application to prefer — it is a web product, and the browser is
 * where the account is already signed in. Zoom does have one, but its own https link lands on
 * a page that launches it, so sending that to the browser reaches the app anyway without this
 * having to reconstruct a `zoommtg:` URL out of a meeting id and a password.
 */
export function planFor(url: string, kind: Conference, installed: (bundleId: string) => boolean): LaunchPlan {
  if (kind === "teams" && TEAMS_BUNDLE_IDS.some(installed)) {
    const deep = teamsDeepLink(url);
    if (deep) return { target: deep, via: "app" };
  }
  return { target: url, via: "browser" };
}
