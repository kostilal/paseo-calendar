import { spawn } from "node:child_process";
import { kindOf } from "../shared/join.ts";
import { TEAMS_BUNDLE_IDS, planFor } from "../shared/launch.ts";

/**
 * Handing a join link to the operating system, from the daemon — which is the only place that
 * can. A plugin's client has no way to open anything outside Paseo, so `Linking.openURL` put
 * the URL in a window inside the app and the call could not be joined from it. The daemon runs
 * on the person's own Mac and can hand a URL to the system.
 */

/** Long enough that a run of joins costs one lookup; short enough that installing Teams and
 *  trying again a few minutes later does what you expect. */
const INSTALLED_TTL_MS = 10 * 60_000;
const installed = new Map<string, { at: number; present: boolean }>();

/** `open` is macOS; every other platform this could run on uses xdg-open. */
function opener(): string {
  return process.platform === "darwin" ? "open" : "xdg-open";
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    // A spawn error (the command missing entirely) is reported as a failure code rather than
    // thrown: every caller here wants to try the next thing, not to stop.
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/**
 * Whether an application is present, asked of Spotlight rather than of the filesystem, so an
 * app installed anywhere is found and none of this has to guess at paths. `mdfind` reads an
 * index; it does not launch what it finds.
 */
export async function appInstalled(bundleId: string, now: () => number = Date.now): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const cached = installed.get(bundleId);
  if (cached && now() - cached.at < INSTALLED_TTL_MS) return cached.present;
  const found = await new Promise<boolean>((resolve) => {
    const child = spawn("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(out.trim().length > 0));
  });
  installed.set(bundleId, { at: now(), present: found });
  return found;
}

/**
 * Open a join link the way it should be opened, and say what happened.
 *
 * An app is only preferred when it is actually installed, and even then the browser is kept
 * as a fallback: a URL scheme can be claimed by something broken or left behind by an
 * uninstall, and `open` reports that as a non-zero exit. Silently doing nothing would be the
 * worst outcome of the three, because it looks exactly like a button that is not wired up.
 */
export async function openJoinUrl(url: string): Promise<{ via: "app" | "browser"; error: string }> {
  const kind = kindOf(url);
  const present = new Set<string>();
  // Only probed for the one kind that has an app worth preferring, so a Meet link never waits
  // on Spotlight.
  if (kind === "teams") {
    for (const bundleId of TEAMS_BUNDLE_IDS) {
      if (await appInstalled(bundleId)) present.add(bundleId);
    }
  }
  const plan = planFor(url, kind, (bundleId) => present.has(bundleId));

  if (plan.via === "app") {
    const code = await run(opener(), [plan.target]);
    if (code === 0) return { via: "app", error: "" };
    // Claimed but not working. The web client hosts the same meeting, so this is a fallback
    // rather than a failure.
    const fallback = await run(opener(), [url]);
    return fallback === 0
      ? { via: "browser", error: "" }
      : { via: "browser", error: `could not open ${url}` };
  }

  const code = await run(opener(), [plan.target]);
  return code === 0 ? { via: "browser", error: "" } : { via: "browser", error: `could not open ${url}` };
}
