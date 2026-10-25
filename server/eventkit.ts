import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Event } from "../shared/event.ts";
import type { StoredAccount } from "./store.ts";
import { EVENTKIT_SWIFT } from "./eventkit.swift.ts";

const DIR = join(homedir(), ".jobby-jobs");
const SWIFT_SRC = join(DIR, "calendar-eventkit.swift");

/**
 * The helper is an application bundle rather than the bare executable it used to be, and
 * that is the whole fix for "macOS did not grant calendar access".
 *
 * TCC does not ask the process that calls requestFullAccessToEvents. It asks the process
 * macOS holds *responsible* — the root of the launch chain. For anything this plugin spawns
 * that root is `Paseo.app`, whose Info.plist declares camera, microphone and bluetooth and
 * no calendar of any kind, so the request was refused before a dialog ever existed to show.
 * No amount of correctness in our own binary could reach that, because our own binary was
 * never who was being asked.
 *
 * An app bundle started through LaunchServices (see openArgs) is its own responsible
 * process, so its own Info.plist is what governs and the dialog finally appears — naming
 * this helper, which is also the more honest thing for it to name. Measured on the machine
 * that found the bug: the identical binary answers granted:false instantly as a child of
 * Paseo, and granted:true when LaunchServices starts this bundle.
 */
const APP = join(DIR, "CalendarHelper.app");
export const HELPER_EXECUTABLE = "CalendarHelper";
const APP_BINARY = join(APP, "Contents", "MacOS", HELPER_EXECUTABLE);
const APP_PLIST = join(APP, "Contents", "Info.plist");

/**
 * What the previous design left on disk: a bare executable beside the state file and its
 * Info.plist as a sidecar, both unreachable since the helper became a bundle. Removed on the
 * next build rather than left for somebody to find later and wonder whether it matters.
 *
 * The Swift source is deliberately absent from this list — it is still written and still
 * compared against to decide whether a rebuild is needed.
 */
export const LEGACY_HELPER_FILES = [join(DIR, "calendar-eventkit"), join(DIR, "calendar-eventkit.plist")];

/**
 * The identifier the helper's code signature carries, and the one thing about this binary
 * that must never change between compiles.
 *
 * macOS keys a TCC grant ("allow this thing to read calendars") to the signing identifier.
 * Before this existed the binary was only ever *linker*-signed, and the linker derives an
 * ad-hoc identifier from the output file name — which is a temp path carrying this process's
 * pid, e.g. `calendar-eventkit.20613.tmp`. So every recompile produced a differently
 * identified program, and whatever the user had already allowed no longer applied to it.
 */
export const HELPER_BUNDLE_ID = "pro.evodev.jobby.calendar-eventkit";

/**
 * Three timeout budgets rather than one. Compiling is a one-off and slow only if the machine
 * is struggling. `access` legitimately blocks on a human deciding whether to click Allow in
 * the permission dialog, so cutting it off at the same budget as a read would abort a real
 * grant in progress. Every other subcommand is a local read or write once that decision
 * already exists, so a hang past a few seconds means something is actually stuck, not that a
 * person is still deciding.
 */
const COMPILE_TIMEOUT_MS = 60_000;
const ACCESS_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;
/** Only covers LaunchServices starting the app, never the work it then does. */
const LAUNCH_TIMEOUT_MS = 20_000;

/** Only makes sense on a Mac; every other platform reports EventKit unavailable. */
export function eventkitAvailable(): boolean {
  return process.platform === "darwin";
}

/**
 * Whether a `sources` call may be sitting in front of a person: "access" unless the caller knows
 * access is already granted, when no dialog can appear and it is a read like any other.
 */
export type SourcesBudget = "read" | "access";

/**
 * The two subcommands a human might be sitting in front of; every other one is unattended.
 * `sources` joins `access` because it is now the first thing a connect calls, and its own
 * requestAccess() is what raises the permission dialog on a machine that has never granted
 * it — cutting that off at a read's budget would abort a grant somebody was still deciding.
 * Once access is known to be granted, the caller says "read": the tick runs `sources` every five
 * minutes in the queue every write waits in, and a stuck one must not hold it for two minutes.
 */
export function helperTimeoutMs(subcommand: string, budget: SourcesBudget = "access"): number {
  if (subcommand === "access") return ACCESS_TIMEOUT_MS;
  if (subcommand === "sources") return budget === "read" ? READ_TIMEOUT_MS : ACCESS_TIMEOUT_MS;
  return READ_TIMEOUT_MS;
}

/**
 * A single in-flight promise, so two calls that race to check the cached binary — a few
 * panels probing access/calendars/events on mount, say — share one compile instead of both
 * deciding to recompile and both writing BINARY at once. `compile` defaults to the real
 * compileIfNeeded; a test overriding it is the only other caller, exercising the cache and
 * the no-unhandled-rejection guarantee below without touching the filesystem or spawning
 * swiftc.
 */
let ensuring: Promise<string> | null = null;

export function ensureHelper(compile: () => Promise<string> = compileIfNeeded): Promise<string> {
  if (ensuring) return ensuring;
  const started = compile();
  ensuring = started;
  // Not .finally(): it returns a second, unobserved promise that mirrors started's own
  // rejection, and Node kills the process on an unhandled rejection by default — the real
  // caller catching `started` does not save that orphaned twin. Passing the same handler to
  // both arms of .then() clears the cache on either outcome without ever creating a promise
  // nobody has attached a handler to.
  const clearIfCurrent = () => {
    // Guards against clearing a newer promise than the one this callback belongs to.
    if (ensuring === started) ensuring = null;
  };
  started.then(clearIfCurrent, clearIfCurrent);
  return started;
}

/**
 * The Info.plist compiled *into* the helper.
 *
 * A command-line binary has no bundle and therefore no Info.plist on disk that macOS would
 * ever read; the only way to give one to a bare executable is to sectcreate it into the
 * Mach-O itself (see swiftcArgs). macOS 14 made `NSCalendarsFullAccessUsageDescription`
 * mandatory for requestFullAccessToEvents: without the key the request is refused
 * immediately and *no dialog is shown at all*, which is indistinguishable, from Node's side,
 * from a user who pressed Deny — and is what made the settings screen report "macOS did not
 * grant calendar access" to someone who had never been asked anything.
 *
 * The usage strings are deliberately not run through shared/i18n.ts: this text is baked into
 * a binary at compile time and read by the system dialog, long before any of this plugin's
 * locale detection exists to have an opinion.
 */
export function helperInfoPlist(): string {
  const reason =
    "JobbyJobs shows your day by reading the calendars already set up on this Mac. " +
    "Nothing is sent anywhere.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${HELPER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>JobbyJobs Calendar Helper</string>
  <key>CFBundleExecutable</key>
  <string>${HELPER_EXECUTABLE}</string>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>NSCalendarsUsageDescription</key>
  <string>${reason}</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>${reason}</string>
</dict>
</plist>
`;
}

/**
 * swiftc's argument list, kept pure so a test can assert the linker flags without compiling.
 * Each token of `-sectcreate __TEXT __info_plist <path>` needs its own `-Xlinker`, because
 * swiftc forwards these one at a time rather than splitting a quoted string.
 */
export function swiftcArgs(options: { source: string; plist: string; out: string }): string[] {
  return [
    options.source,
    "-O",
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    options.plist,
    "-o",
    options.out,
  ];
}

/**
 * Re-sign ad-hoc with an identifier we choose rather than the one the linker invented from
 * the file name. `--force` is required: the binary arrives here already linker-signed, and
 * codesign refuses to sign over an existing signature without it.
 */
export function codesignArgs(binary: string): string[] {
  return ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, binary];
}

/**
 * How the helper is started: through LaunchServices, never as a child process.
 *
 * `-W` blocks until it exits, without which the output file would be read before anything
 * had written to it. `-n` forces a fresh instance — `open` otherwise reuses a running one
 * and returns immediately, which would let two concurrent reads race on one output file and
 * leave one of them empty. The streams have to be files at all because a process started by
 * LaunchServices is not our child and its stdout is not ours to inherit.
 */
export function openArgs(options: { app: string; out: string; err: string; args: string[] }): string[] {
  return ["-n", "-a", options.app, "--stdout", options.out, "--stderr", options.err, "--args", ...options.args];
}

/**
 * The last thing the helper prints, on success and on failure alike (see eventkit.swift.ts).
 *
 * `open -W` was what used to signal completion, and it cannot: it blocks by watching the
 * launched process with kevent, and this helper exits in milliseconds, so kevent regularly
 * finds no such process and open fails — leaving behind an output file that is complete and
 * perfectly good. Worse, it is a race, so it succeeds often enough to pass a first test.
 * Reading the marker takes the process out of the question entirely.
 */
export const HELPER_DONE = "__calendar_helper_done__";

/** `null` while the marker has not been written yet: the file exists but the answer does not. */
export function payloadFrom(raw: string): string | null {
  const end = raw.indexOf(HELPER_DONE);
  return end < 0 ? null : raw.slice(0, end);
}

/**
 * Write the embedded Swift beside the state file and compile it once. Recompiles if the
 * source string changed (a plugin update) — cheap to check, and a stale binary would run
 * last release's helper. swiftc ships with the Xcode command-line tools; its absence is
 * reported as a plain error the settings screen can show. Compiles to a pid-suffixed temp
 * path and renames onto BINARY — the same shape as store.ts's writeStored — so a
 * caller that reaches BINARY mid-compile, ours or a racing one, never spawns half an
 * executable.
 */
async function compileIfNeeded(): Promise<string> {
  await mkdir(DIR, { recursive: true });
  const plist = helperInfoPlist();
  let recompile = true;
  try {
    // The plist is compared alongside the source because it is both the bundle's identity
    // and compiled into the binary: changing a usage string without changing a line of Swift
    // still has to produce a new bundle, or the dialog would keep quoting the previous
    // release's words.
    const [existingSource, existingPlist, binStat] = await Promise.all([
      readFile(SWIFT_SRC, "utf8"),
      readFile(APP_PLIST, "utf8"),
      stat(APP_BINARY),
    ]);
    recompile = existingSource !== EVENTKIT_SWIFT || existingPlist !== plist || binStat.size === 0;
  } catch {
    recompile = true;
  }
  if (recompile) {
    await writeFile(SWIFT_SRC, EVENTKIT_SWIFT, "utf8");
    // Assembled under a pid-suffixed name and moved into place at the end, the same shape
    // store.ts's writeStored uses, so a caller reaching APP mid-build never starts a bundle
    // that is half-written. A directory cannot be renamed onto a non-empty one, so the old
    // bundle is removed first; that leaves a window this process closes with the `ensuring`
    // latch above, and which a second process could still see — acceptable for something
    // that only happens on a version change, and far better than an executable that exists
    // before its Info.plist does.
    const staging = `${APP}.${process.pid}.tmp`;
    const stagedPlist = join(staging, "Contents", "Info.plist");
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, "Contents", "MacOS"), { recursive: true });
    await writeFile(stagedPlist, plist, "utf8");
    try {
      await run(
        "swiftc",
        // The same plist is also sectcreate'd into the executable. Redundant for a bundle,
        // whose Contents/Info.plist is what LaunchServices reads, but it costs nothing and
        // keeps the binary self-describing if it is ever run directly while debugging.
        swiftcArgs({
          source: SWIFT_SRC,
          plist: stagedPlist,
          out: join(staging, "Contents", "MacOS", HELPER_EXECUTABLE),
        }),
        COMPILE_TIMEOUT_MS,
      );
      // The bundle, not the executable inside it: LaunchServices records the bundle's
      // identity, so signing only the inner binary would leave TCC keying the grant to
      // something it never sees.
      await run("codesign", codesignArgs(staging), COMPILE_TIMEOUT_MS);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw new Error(`could not build the EventKit helper (is 'swiftc' installed?): ${String(error)}`);
    }
    await rm(APP, { recursive: true, force: true });
    await rename(staging, APP);
    // Best-effort, and after the bundle is in place: tidying up is never a reason for a
    // build that otherwise succeeded to report failure.
    await Promise.all(LEGACY_HELPER_FILES.map((path) => unlink(path).catch(() => {})));
  }
  await access(APP_BINARY, constants.X_OK);
  return APP;
}

/**
 * The Swift contract is `{"error": "..."}` printed with `print()` — stdout, not stderr — and
 * a non-zero exit, so a failure's real message lives in `out`. `null` means this stdout was
 * not an error payload; it does not mean there was no failure, since the caller still has the
 * exit code and stderr to fall back on.
 */
export function parseHelperError(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{"error"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Kills the child and rejects distinctly on timeout, so a permission dialog nobody answers
 * cannot stall the whole account behind it. On a non-zero exit, the helper's own words from
 * stdout (parseHelperError) win over stderr or the bare exit code: Swift's print() never
 * touches stderr, so trusting stderr first would report "exit 1" for everything, including a
 * plain refused permission.
 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`eventkit helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(parseHelperError(out) ?? (err.trim() || `exit ${code}`)));
    });
  });
}

/**
 * Run one subcommand of the bundled helper and hand back its stdout.
 *
 * `open` does not propagate the app's exit status, so the non-zero exit `run` relies on for
 * a direct child is simply not available here. It does not need to be: the Swift contract
 * prints `{"error": "..."}` to stdout for every failure, which parseHelperError already
 * reads, so the failure path survives the move to LaunchServices unchanged — and the Swift
 * file itself did not have to be touched at all.
 */
/**
 * Poll the redirected stdout until the helper says it has finished.
 *
 * Polling rather than watching: fs.watch on a file another process is appending to is not
 * reliable across platforms or editors, and the thing being waited for is at most a few
 * hundred milliseconds away. 50ms keeps a read that is already done from feeling deferred
 * without spinning.
 */
async function waitForPayload(out: string, err: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = payloadFrom(await readFile(out, "utf8").catch(() => ""));
    if (payload !== null) return payload;
    if (Date.now() >= deadline) {
      // stderr is quoted when there is any: a helper that died before printing its marker
      // (a quarantined bundle, a missing framework) says why there, and "timed out" alone
      // would send the reader looking for a hang that never happened.
      const stderr = (await readFile(err, "utf8").catch(() => "")).trim();
      throw new Error(
        stderr ? `the calendar helper failed: ${stderr}` : `eventkit helper timed out after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A read's pair of temp files, as runBundled names them: the daemon's pid, then a UUID. */
const HELPER_TEMP = /^calendar-helper\.(\d+)\.[0-9a-f-]{36}\.(?:out|err)$/;
/** Well past the longest a read can take (ACCESS_TIMEOUT_MS plus the launch), so no live read is touched. */
const LEFTOVER_AFTER_MS = 10 * 60_000;

/**
 * Removes the temp files of reads that never finished: runBundled deletes its pair in `finally`,
 * so one left behind belongs to a daemon stopped mid-read, and it holds that read's meeting
 * titles, guests and notes. Only another process's files, and only ones older than any read could
 * run, so a second daemon's read in progress is never touched. Best-effort; how many went.
 */
export async function sweepHelperLeftovers(dir: string = tmpdir(), nowMs: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const match = HELPER_TEMP.exec(name);
    if (!match || Number(match[1]) === process.pid) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info || nowMs - info.mtimeMs < LEFTOVER_AFTER_MS) continue;
    if (await unlink(path).then(() => true, () => false)) removed += 1;
  }
  return removed;
}

async function runBundled(app: string, args: string[], timeoutMs: number): Promise<string> {
  // One pair of files per call, not per process: concurrent reads (the board and the pill
  // both probing on mount) must not overwrite each other's output.
  const stem = join(tmpdir(), `calendar-helper.${process.pid}.${randomUUID()}`);
  const out = `${stem}.out`;
  const err = `${stem}.err`;
  try {
    // Only the launch is waited on here; `open` returns as soon as LaunchServices has started
    // the app, and a non-zero exit at this point really does mean it never started.
    await run("open", openArgs({ app, out, err, args }), LAUNCH_TIMEOUT_MS);
    const stdout = await waitForPayload(out, err, timeoutMs);
    const failure = parseHelperError(stdout);
    if (failure) throw new Error(failure);
    return stdout;
  } finally {
    await Promise.all([unlink(out).catch(() => {}), unlink(err).catch(() => {})]);
  }
}

async function helper(subcommand: string, extra: string[] = [], budget?: SourcesBudget): Promise<string> {
  const app = await ensureHelper();
  const out = await runBundled(app, [subcommand, ...extra], helperTimeoutMs(subcommand, budget));
  return out.trim();
}

/**
 * The helper's answer to `access`, and only that: `{"granted": false}` is macOS refusing, and
 * anything else did not answer the question at all, so it throws rather than reading as a refusal.
 */
export function grantedFrom(out: string): boolean {
  let granted: unknown;
  try {
    granted = (JSON.parse(out) as { granted?: unknown }).granted;
  } catch {
    granted = undefined;
  }
  if (typeof granted !== "boolean") {
    throw new Error(`the calendar helper did not answer the access question: ${out.trim().slice(0, 200) || "no output"}`);
  }
  return granted;
}

/**
 * True or false only when macOS answered. A helper that would not build (no Xcode Command Line
 * Tools), would not launch, or ran out of time while the dialog was still on screen throws: none
 * of those is a refusal, and Settings must not send anybody to Privacy & Security for them.
 */
export async function eventkitAccess(): Promise<boolean> {
  return grantedFrom(await helper("access"));
}

/**
 * One macOS account that has calendars: the Exchange mailbox, the Google account synced over
 * CalDAV, iCloud. This is the unit a person picks from, and the unit an account is keyed by
 * from here on — `identity` used to stand in for it and could not, because it reported the
 * first Exchange source's title, which on a real machine is the bare word "Exchange" and so
 * made every system account indistinguishable from every other.
 */
export interface CalendarSource {
  id: string;
  title: string;
  /** exchange | caldav | icloud | local | subscribed | birthdays | other. */
  kind: string;
  calendars: number;
}

/** Shown for a source whose title macOS leaves empty — rare, but it must stay selectable. */
export const UNTITLED_SOURCE = "Calendar account";

const helperSource = z.object({
  // The key everything downstream matches on, so an entry without one is dropped rather
  // than connected and then never recognised again.
  id: z.string().min(1),
  title: z.string().default(""),
  kind: z.string().default("other"),
  calendars: z.number().int().nonnegative().default(0),
});

export function parseSources(raw: string): CalendarSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const sources: CalendarSource[] = [];
  for (const entry of parsed) {
    const result = helperSource.safeParse(entry);
    if (!result.success) continue;
    sources.push({ ...result.data, title: result.data.title || UNTITLED_SOURCE });
  }
  return sources;
}

/**
 * The permission state macOS already holds, read without raising anything. "unknown" is
 * genuinely distinct from "denied": one means nobody has been asked, the other means somebody
 * said no, and offering an "Allow access" button is right for the first and useless for the
 * second.
 */
export async function eventkitStatus(): Promise<"unknown" | "granted" | "denied"> {
  try {
    const parsed = JSON.parse(await helper("status")) as { access?: unknown };
    return parsed.access === "granted" ? "granted" : parsed.access === "denied" ? "denied" : "unknown";
  } catch {
    // A helper that will not run at all is not a refusal; the screen should still be able to
    // offer the button, and the request itself will produce the real error.
    return "unknown";
  }
}

export async function eventkitSources(budget: SourcesBudget = "access"): Promise<CalendarSource[]> {
  return parseSources(await helper("sources", [], budget));
}

export async function eventkitCalendars(sourceId: string): Promise<{ id: string; name: string }[]> {
  const parsed = JSON.parse(await helper("calendars", [sourceId])) as unknown;
  return Array.isArray(parsed)
    ? parsed.map((c) => ({ id: String((c as Record<string, unknown>).id ?? ""), name: String((c as Record<string, unknown>).name ?? "Calendar") }))
    : [];
}

const helperEvent = z.object({
  id: z.string(),
  calendarId: z.string().default(""),
  calendarName: z.string().default("Calendar"),
  title: z.string().default("(no title)"),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean().default(false),
  recurring: z.boolean().default(false),
  mine: z.boolean().default(false),
  attendees: z
    .array(
      z.object({
        name: z.string().default(""),
        email: z.string().default(""),
        response: z.enum(["accepted", "declined", "tentative", "unknown"]).default("unknown"),
        self: z.boolean().default(false),
        organiser: z.boolean().default(false),
      }),
    )
    .default([]),
  location: z.string().default(""),
  description: z.string().default(""),
  webLink: z.string().default(""),
  myResponse: z.enum(["accepted", "declined", "tentative", "unknown"]).default("unknown"),
});

export interface HelperContext {
  accountId: string;
  calendarId: string;
  calendarName: string;
}

/**
 * EventKit's all-day end is inclusive (the last day itself); Event.end is documented as
 * exclusive for all-day events (the day after) — see shared/event.ts. This is the one place
 * an all-day event's end passes through on its way to becoming an Event, so it is where that
 * day gets added, once. Pure and date-only (UTC arithmetic on the calendar date alone, never
 * the event's own zone) so a month or year rollover is just Date's own normalisation, not a
 * special case here.
 */
export function toExclusiveEnd(dateOnly: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return dateOnly;
  const [, year, month, day] = match;
  const next = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * The one pure seam: validate the helper's JSON and tag it with our account, dropping any
 * entry that will not parse rather than trusting a native process's output wholesale. The
 * calendar id and name come from the entry itself when present; the context is the fallback.
 *
 * The helper still prints a `conferenceUrl`, always "": EventKit exposes no conferencing field
 * on read (see eventkit.swift.ts's eventJSON). helperEvent leaves it out, so zod drops it, and
 * an event only gets a Join button when join.ts finds a link in its location or description.
 */
export function parseHelperEvents(raw: string, ctx: HelperContext): Event[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const events: Event[] = [];
  for (const entry of parsed) {
    const result = helperEvent.safeParse(entry);
    if (!result.success) continue;
    const value = result.data;
    events.push({
      ...value,
      end: value.allDay ? toExclusiveEnd(value.end) : value.end,
      accountId: ctx.accountId,
      calendarId: value.calendarId || ctx.calendarId,
      calendarName: value.calendarName || ctx.calendarName,
    });
  }
  return events;
}

/**
 * Two guards keep one account from reading another's meetings. The helper's `events` hands
 * EventKit the source's calendars, and EventKit reads an empty list as every calendar on this
 * Mac; so the caller (sync.ts) only passes an account whose source is in the latest `sources`
 * list (a tick's own, or for a browse one up to SOURCES_TTL_MS old) and that has a shown
 * calendar. The filter on shown ids below is the second guard: if the source vanishes between
 * the two launches, nothing outside this account's stored calendars gets through. Both live
 * here in Node rather than in the Swift: a new helper build is a new code hash, and macOS would
 * ask for calendar access all over again.
 */
export async function eventkitEvents(account: StoredAccount, from: Date, to: Date): Promise<Event[]> {
  const raw = await helper("events", [from.toISOString(), to.toISOString(), account.sourceId]);
  const shown = new Set(account.calendars.filter((c) => c.shown).map((c) => c.id));
  return parseHelperEvents(raw, { accountId: account.id, calendarId: "", calendarName: "Calendar" }).filter((event) =>
    shown.has(event.calendarId),
  );
}

/** What create() writes: one event in one of the account's own calendars. */
export interface CreateInput {
  calendarId: string;
  title: string;
  start: string;
  end: string;
  description: string;
}

/** What update() changes on a one-off event; the calendar it is in stays where it is. */
export interface UpdateInput {
  calendarId: string;
  eventId: string;
  title: string;
  start: string;
  end: string;
  description: string;
}

/**
 * Change a one-off event in place. The helper refuses a series of its own accord; this is the
 * path a caller that has already checked takes.
 */
export async function eventkitUpdate(
  account: StoredAccount,
  input: { eventId: string; title: string; description: string; start: string; end: string },
): Promise<Event | null> {
  const raw = await helper("update", [JSON.stringify(input)]);
  const [event] = parseHelperEvents(`[${raw}]`, {
    accountId: account.id,
    calendarId: "",
    calendarName: "Calendar",
  });
  return event ?? null;
}

/** Remove a one-off event. The helper refuses a series of its own accord. */
export async function eventkitDelete(eventId: string): Promise<void> {
  await helper("delete", [eventId]);
}

/**
 * Creating here sends no invitations: EventKit writes to the local store and lets the account
 * sync it outward, so a create blocks your own time rather than convening others.
 */
export async function eventkitCreate(account: StoredAccount, input: CreateInput): Promise<Event | null> {
  const spec = JSON.stringify({
    title: input.title,
    description: input.description,
    start: input.start,
    end: input.end,
    calendarId: input.calendarId,
    // Scopes the lookup on the native side, so a stale calendar id cannot resolve to a
    // same-named calendar belonging to a different account.
    sourceId: account.sourceId,
  });
  const raw = await helper("create", [spec]);
  const [event] = parseHelperEvents(`[${raw}]`, {
    accountId: account.id,
    calendarId: input.calendarId,
    calendarName: account.calendars.find((c) => c.id === input.calendarId)?.name ?? "Calendar",
  });
  return event ?? null;
}
