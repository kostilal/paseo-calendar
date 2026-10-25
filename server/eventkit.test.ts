import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HELPER_BUNDLE_ID,
  HELPER_DONE,
  LEGACY_HELPER_FILES,
  HELPER_EXECUTABLE,
  codesignArgs,
  ensureHelper,
  helperInfoPlist,
  grantedFrom,
  helperTimeoutMs,
  parseHelperError,
  parseHelperEvents,
  openArgs,
  parseSources,
  payloadFrom,
  swiftcArgs,
  sweepHelperLeftovers,
  toExclusiveEnd,
} from "./eventkit.ts";
import { EVENTKIT_SWIFT } from "./eventkit.swift.ts";

const ctx = { accountId: "acc-ms", calendarId: "cal-1", calendarName: "Calendar" };

// A regression guard for the critical fix: a create whose calendar id is not among the
// Exchange calendars must fail loudly rather than silently falling back to whatever macOS
// considers the default calendar for new events (typically iCloud) — see the long comment
// beside this guard in eventkit.swift.ts. A test never runs the helper (it would touch the real
// calendars and could raise the permission dialog), so this checks the embedded source text
// itself, which is the only thing available to a test here.
test("the create subcommand never falls back to the default calendar for a missing id", () => {
  // The dangerous line, verbatim, before this fix: a lookup that found nothing fell back to
  // whatever macOS considers the default calendar for new events (typically iCloud) rather
  // than failing. Matched as a whole statement, not just the property name, which a comment
  // explaining why it is gone still mentions by name on purpose. The positive checks below
  // are what should have replaced it: a guard that fails loudly, naming the missing id.
  // Checked against code only. The comment that replaced the dangerous line still names
  // defaultCalendarForNewEvents on purpose — explaining why it is gone is the whole point of
  // it — so a bare substring search over the source would match that explanation and fail.
  const code = EVENTKIT_SWIFT.split("\n").filter((line) => !line.trim().startsWith("//"));
  assert.ok(!code.some((line) => line.includes("defaultCalendarForNewEvents")));
  // The lookup is scoped to the account's own source now, which makes the guard stricter
  // rather than weaker: a stale id can no longer resolve to a same-named calendar sitting
  // in somebody else's account.
  assert.ok(EVENTKIT_SWIFT.includes("guard let calendar = calendarsOf(spec[\"sourceId\"] as? String ?? \"\").first(where:"));
  assert.ok(EVENTKIT_SWIFT.includes("calendar not found"));
  assert.ok(EVENTKIT_SWIFT.includes("ev.calendar = calendar"));
});

test("a helper event becomes an Event tagged with the account", () => {
  const events = parseHelperEvents(
    JSON.stringify([
      {
        id: "ek1",
        title: "Sprint review",
        start: "2026-09-09T08:00:00.000Z",
        end: "2026-09-09T09:00:00.000Z",
        allDay: false,
        recurring: false,
        mine: true,
        attendees: [
          { name: "Me", email: "me@example.com", response: "accepted", self: true, organiser: false },
          { name: "Max", email: "max@globex.example", response: "tentative", self: false, organiser: true },
        ],
        location: "Teams",
        description: "https://teams.microsoft.com/l/meetup-join/x",
        // The Swift still prints this key, always "", and Event no longer has it.
        conferenceUrl: "",
        webLink: "",
        myResponse: "accepted",
      },
    ]),
    ctx,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].accountId, "acc-ms");
  assert.equal(events[0].calendarName, "Calendar");
  assert.equal(events[0].start, "2026-09-09T08:00:00.000Z");
  assert.equal(events[0].attendees[1].organiser, true);
  assert.equal("conferenceUrl" in events[0], false);
});

test("a malformed helper payload yields no events rather than throwing", () => {
  assert.deepEqual(parseHelperEvents("not json", ctx), []);
  assert.deepEqual(parseHelperEvents("{}", ctx), []);
});

test("an entry missing a start is dropped, the rest survive", () => {
  const events = parseHelperEvents(
    JSON.stringify([
      { id: "bad", title: "no start" },
      { id: "ok", title: "fine", start: "2026-09-09T10:00:00.000Z", end: "2026-09-09T11:00:00.000Z", allDay: false },
    ]),
    ctx,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "ok");
});

// EventKit's all-day end is inclusive (the last day itself); Event.end is documented as
// exclusive (the day after), like every other range in this plugin — see shared/event.ts.
// Without this, a vacation that is genuinely one day in EventKit's own terms would still read
// as one day here, but a genuinely multi-day one would be silently short by a day everywhere
// downstream, including groupByDay's expansion.

test("an all-day event's end is normalised from EventKit's inclusive day to the exclusive one Event uses", () => {
  const events = parseHelperEvents(
    JSON.stringify([
      { id: "vacation", title: "Vacation", start: "2026-09-10", end: "2026-09-12", allDay: true },
    ]),
    ctx,
  );
  assert.equal(events[0].start, "2026-09-10");
  // EventKit's own end (2026-09-12) is the last day the vacation covers; pushed forward one
  // day to make it exclusive.
  assert.equal(events[0].end, "2026-09-13");
});

test("a timed event's end is left exactly alone", () => {
  const events = parseHelperEvents(
    JSON.stringify([
      { id: "t", title: "Standup", start: "2026-09-09T09:00:00.000Z", end: "2026-09-09T09:30:00.000Z", allDay: false },
    ]),
    ctx,
  );
  assert.equal(events[0].end, "2026-09-09T09:30:00.000Z");
});

test("toExclusiveEnd rolls over a month and a year like any other date arithmetic", () => {
  assert.equal(toExclusiveEnd("2026-09-09"), "2026-09-10");
  assert.equal(toExclusiveEnd("2026-09-30"), "2026-10-01");
  assert.equal(toExclusiveEnd("2026-12-31"), "2027-01-01");
});

test("toExclusiveEnd leaves an unparseable date alone rather than throwing", () => {
  assert.equal(toExclusiveEnd("not-a-date"), "not-a-date");
});

// The helper's fail() prints `{"error": "..."}` with print() — stdout, not stderr — and a
// non-zero exit. parseHelperError is the pure half of that contract: given what a failing
// run's stdout held, what should the thrown Error say. A refused permission is the case that
// matters most, since it is the single most common real-world failure of this arm.

test("the helper's own words survive a non-zero exit, not a wrapper paraphrase", () => {
  assert.equal(parseHelperError('{"error": "calendar access not granted"}'), "calendar access not granted");
});

test("stdout that is not an error payload yields null rather than a false positive", () => {
  assert.equal(parseHelperError('{"granted": true}'), null);
  assert.equal(parseHelperError("[]"), null);
  assert.equal(parseHelperError("not json"), null);
  assert.equal(parseHelperError('{"error": 42}'), null);
});

test("a trailing newline from print() does not confuse the error check", () => {
  assert.equal(parseHelperError('{"error": "calendar access not granted"}\n'), "calendar access not granted");
});

test("sources keeps the access budget unless the caller knows access is already granted", () => {
  // Its own requestAccess() may be raising the dialog; once access is granted it is a plain read.
  assert.equal(helperTimeoutMs("sources"), helperTimeoutMs("access"));
  assert.equal(helperTimeoutMs("sources", "read"), helperTimeoutMs("events"));
});

test("only the helper's own answer is a refusal; anything else is a failure to ask", () => {
  assert.equal(grantedFrom('{"granted": true}'), true);
  assert.equal(grantedFrom('{"granted": false}\n'), false);
  // A helper that printed something else did not answer the question, so it must not read as "denied".
  assert.throws(() => grantedFrom(""), /did not answer/);
  assert.throws(() => grantedFrom('{"access": "granted"}'), /did not answer/);
});

test("access gets a longer budget than every other subcommand", () => {
  const accessBudget = helperTimeoutMs("access");
  for (const subcommand of ["identity", "calendars", "events", "create"]) {
    assert.ok(accessBudget > helperTimeoutMs(subcommand), `access should outlast ${subcommand}`);
  }
});

// ensureHelper's optional `compile` parameter exists only so a test can stand in for the
// real compileIfNeeded — no filesystem write, no swiftc, no calendar. The middle test pins
// that a rejected compile does not become a process-crashing unhandled rejection just because
// its cache-clearing promise was left unobserved.

test("two callers racing ensureHelper share one compile", async () => {
  let calls = 0;
  const compile = () => {
    calls++;
    return Promise.resolve("/tmp/fake-binary");
  };
  const first = ensureHelper(compile);
  const second = ensureHelper(compile);
  assert.equal(first, second);
  assert.deepEqual(await Promise.all([first, second]), ["/tmp/fake-binary", "/tmp/fake-binary"]);
  assert.equal(calls, 1);
});

test("a rejected compile produces no unhandled rejection", async () => {
  const seen: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await assert.rejects(ensureHelper(() => Promise.reject(new Error("swiftc not found"))), /swiftc not found/);
    // Node's own unhandled-rejection check runs a tick after settlement, not within it —
    // give it the chance to fire before asserting that it did not.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  assert.deepEqual(seen, []);
});

test("a failed compile clears the cache so the next call retries", async () => {
  let calls = 0;
  const compile = () => {
    calls++;
    return Promise.reject(new Error("could not compile the EventKit helper"));
  };
  await assert.rejects(ensureHelper(compile), /could not compile/);
  await assert.rejects(ensureHelper(compile), /could not compile/);
  assert.equal(calls, 2);
});

// --- The permission grant that macOS never offered ---
//
// The observed failure: connecting an Exchange account reported "macOS did not grant
// calendar access" without any system dialog ever appearing. Two independent defects in
// how the helper was built, both invisible from the Swift source and both checked here
// against the built arguments rather than by running anything.

test("the embedded Info.plist carries the usage strings macOS demands", () => {
  const plist = helperInfoPlist();
  // macOS 14+ checks this exact key when requestFullAccessToEvents is called. Without it
  // the request is refused outright and no dialog is ever shown — which is precisely the
  // "did not grant" with no prompt that sent us here.
  assert.match(plist, /<key>NSCalendarsFullAccessUsageDescription<\/key>/);
  // The pre-14 key, still read on older systems reaching requestAccess(to:).
  assert.match(plist, /<key>NSCalendarsUsageDescription<\/key>/);
  assert.ok(plist.includes(`<key>CFBundleIdentifier</key>`));
  assert.ok(plist.includes(HELPER_BUNDLE_ID));
  // A usage string is shown to a person in the dialog; an empty one is as good as absent.
  const [, reason] = /<key>NSCalendarsFullAccessUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(plist) ?? [];
  assert.ok((reason ?? "").length > 20, "the dialog needs a sentence, not a placeholder");
});

test("swiftc is told to embed the plist into the binary's __TEXT segment", () => {
  const args = swiftcArgs({ source: "/tmp/h.swift", plist: "/tmp/h.plist", out: "/tmp/h.tmp" });
  // The linker only reads an Info.plist from a bare executable when it is sectcreate'd
  // into __TEXT,__info_plist; a plist file sitting beside the binary is never consulted.
  const joined = args.join(" ");
  assert.ok(joined.includes("-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker /tmp/h.plist"));
  assert.ok(args.includes("/tmp/h.swift"));
  assert.deepEqual(args.slice(-2), ["-o", "/tmp/h.tmp"]);
});

test("the signature's identifier is stable across compiles, not derived from the temp name", () => {
  // Before this fix the ad-hoc linker signature took its identifier from the output file
  // name, which carried the pid: `calendar-eventkit.20613.tmp`. TCC keys a grant to the
  // identifier, so every recompile silently invalidated whatever the user had allowed.
  const first = codesignArgs("/Users/x/.jobby-jobs/calendar-eventkit.111.tmp");
  const second = codesignArgs("/Users/x/.jobby-jobs/calendar-eventkit.999.tmp");
  const identifierOf = (args: string[]) => args[args.indexOf("--identifier") + 1];
  assert.equal(identifierOf(first), HELPER_BUNDLE_ID);
  assert.equal(identifierOf(first), identifierOf(second));
  assert.doesNotMatch(identifierOf(first), /\d{3,}|tmp/, "no pid and no temp suffix may leak in");
  // --force, or signing an already linker-signed binary fails outright.
  assert.ok(first.includes("--force"));
  assert.deepEqual(first.slice(-1), ["/Users/x/.jobby-jobs/calendar-eventkit.111.tmp"]);
});

// --- Who macOS holds responsible ---
//
// The second half of the same bug, and the half the embedded plist alone could not reach.
// TCC does not ask the process that calls requestFullAccessToEvents; it asks the *responsible*
// process, which is the root of the launch chain — here `Paseo.app`, whose own Info.plist
// declares camera, microphone and bluetooth and no calendar at all. So the request was
// refused before any dialog existed to refuse it, no matter what our binary claimed about
// itself. Proven on this machine: the identical binary answers granted:false instantly when
// spawned as a child of Paseo, and granted:true when LaunchServices starts it as a bundle,
// because a bundle launched that way is its own responsible process.

test("the helper is a bundle, and its plist names the executable inside it", () => {
  const plist = helperInfoPlist();
  // Without CFBundleExecutable macOS cannot find the binary inside Contents/MacOS.
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
  const [, executable] = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist) ?? [];
  assert.equal(executable, HELPER_EXECUTABLE);
  // An agent, not an app: the helper must not bounce in the Dock or steal the app switcher
  // every time the board refreshes.
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
});

test("the helper is started through LaunchServices, never spawned directly", () => {
  const args = openArgs({ app: "/x/CalendarHelper.app", out: "/tmp/o", err: "/tmp/e", args: ["events", "A", "B"] });
  // No -W here: waiting on the process was the wrong signal and is now the marker's job —
  // see "open is never asked to block on the process any more" below.
  // -n: a fresh instance per call. Without it `open` reuses a running instance and returns
  // immediately, so two concurrent reads would race on one output file and one of them
  // would come back empty.
  assert.ok(args.includes("-n"));
  // Everything after --args belongs to the helper, in order, and nothing before it does.
  const divider = args.indexOf("--args");
  assert.ok(divider > 0);
  assert.deepEqual(args.slice(divider + 1), ["events", "A", "B"]);
  // stdout has to land in a file: through LaunchServices the child's streams are not ours.
  assert.deepEqual(args.slice(args.indexOf("--stdout"), args.indexOf("--stdout") + 2), ["--stdout", "/tmp/o"]);
  assert.deepEqual(args.slice(args.indexOf("--stderr"), args.indexOf("--stderr") + 2), ["--stderr", "/tmp/e"]);
});

test("the signature covers the bundle, not the bare executable inside it", () => {
  // Signing only Contents/MacOS/CalendarHelper leaves the bundle unsigned, and it is the
  // bundle's identity that TCC records when LaunchServices starts it.
  const args = codesignArgs("/x/CalendarHelper.app");
  assert.deepEqual(args.slice(-1), ["/x/CalendarHelper.app"]);
  assert.doesNotMatch(args[args.length - 1], /Contents\/MacOS/);
});

// --- Knowing the write has finished ---
//
// `open -W` was the wrong thing to wait on. It watches the launched process with kevent, and
// the helper now exits in milliseconds, so kevent regularly attaches to a pid that is already
// gone and open fails with "Unable to block on applications (initial call to kevent() failed:
// No such process)" — while the output file it redirected is sitting there, complete and
// correct. Reproduced on the machine that found it: open exits 1, the file holds
// {"granted":true}. It is a race, so it also *passes* sometimes, which is how it survived the
// first end-to-end check: that run happened to show a permission dialog, and the seconds spent
// waiting for a human kept the process alive long enough for kevent to win.
//
// So the helper now says when it is done, and the Node side waits for it to say so.

test("a half-written file is not mistaken for an answer", () => {
  // The realistic partial read: open has created the file and the helper is mid-print.
  assert.equal(payloadFrom(""), null);
  assert.equal(payloadFrom('{"granted":tr'), null);
  assert.equal(payloadFrom('{"granted":true}\n'), null);
});

test("the payload is whatever precedes the marker", () => {
  assert.equal((payloadFrom(`{"granted":true}\n${HELPER_DONE}\n`) ?? "").trim(), '{"granted":true}');
  assert.equal((payloadFrom(`[]\n${HELPER_DONE}\n`) ?? "").trim(), "[]");
});

test("open is never asked to block on the process any more", () => {
  const args = openArgs({ app: "/x/A.app", out: "/tmp/o", err: "/tmp/e", args: ["access"] });
  assert.ok(!args.includes("-W"), "-W is the kevent race; completion is read from the file now");
  // -n still matters: without it open reuses a running instance and the second of two
  // concurrent reads never writes its own file at all.
  assert.ok(args.includes("-n"));
});

test("the helper marks the end of both the answer and the failure", () => {
  // Both exits have to be greppable, or a failed subcommand would be waited on until timeout
  // instead of being reported straight away.
  assert.ok(EVENTKIT_SWIFT.includes(HELPER_DONE), "the Swift and the Node side must agree on the literal");
  // In fail(), after the error line and before exit.
  assert.match(EVENTKIT_SWIFT, /print\("\{\\"error\\": \\\(jsonString\(message\)\)\}"\)\s*\n\s*print\(doneMarker\)/);
  // And at the end of every successful print.
  assert.match(EVENTKIT_SWIFT, /print\(String\(data: data, encoding: \.utf8\)!\)\s*\n\s*print\(doneMarker\)/);
});

// --- One account per source ---
//
// The helper used to hard-filter store.calendars(for:) down to sourceType == .exchange and
// hand back a flat list, with identity() reporting the first Exchange source's title. Two
// things follow from that and both are wrong. Every macOS account collapses into one: the
// title is literally "Exchange" here, so a second system account would key to (email,
// provider) identically and overwrite the first. And nothing is selectable — connecting
// meant taking every Exchange calendar on the machine, wanted or not.
//
// A source is an account. Settings needs them enumerated before anything is connected.

test("the helper can enumerate the calendar sources macOS knows about", () => {
  assert.match(EVENTKIT_SWIFT, /case "sources":/);
  // Deduplicated by identifier, because the list is reached through the calendars.
  assert.ok(EVENTKIT_SWIFT.includes("sourceIdentifier"));
  // The old blanket filter is what has to be gone, not merely widened.
  assert.ok(
    !EVENTKIT_SWIFT.includes("filter { $0.source.sourceType == .exchange }"),
    "reading only Exchange is what hid Google and iCloud from the list of accounts",
  );
});

test("a source list parses into something Settings can show", () => {
  const sources = parseSources(
    JSON.stringify([
      { id: "s1", title: "Exchange", kind: "exchange", calendars: 2 },
      { id: "s2", title: "me@example.org", kind: "caldav", calendars: 5 },
    ]),
  );
  assert.deepEqual(sources, [
    { id: "s1", title: "Exchange", kind: "exchange", calendars: 2 },
    { id: "s2", title: "me@example.org", kind: "caldav", calendars: 5 },
  ]);
});

test("a source missing its title is still offered, named by something", () => {
  // An untitled source is rare but real (a bare local store). Dropping it would make a
  // calendar unreachable with no way to find out why; a fallback name keeps it selectable.
  const [only] = parseSources(JSON.stringify([{ id: "s3", kind: "local", calendars: 1 }]));
  assert.equal(only.id, "s3");
  assert.ok(only.title.length > 0);
});

test("a source with no id is dropped rather than made unselectable", () => {
  // The id is what an account is keyed by from here on; one without it could be connected
  // and then never matched again, silently creating a duplicate on every reconnect.
  assert.deepEqual(parseSources(JSON.stringify([{ title: "Nameless", kind: "local" }])), []);
  assert.deepEqual(parseSources("not json"), []);
  assert.deepEqual(parseSources("{}"), []);
});

// --- Telling one occurrence from another ---
//
// EKEvent.eventIdentifier is the same string for every occurrence of a recurring series —
// Apple documents this, and it is not a bug in EventKit. It is a bug here, because the board
// keys an event by {accountId, id}: a daily standup fetched over a fortnight arrived as ten
// rows sharing one key, so the clash grouping merged them into a single block and drew all
// ten at the day of the earliest one. On screen that looked like ten copies of tomorrow's
// standup. Measured on the machine that found it: 40 events, 31 distinct keys, exactly one
// colliding key holding ten occurrences.

test("a recurring occurrence is identified by its own date, not just its series", () => {
  assert.ok(EVENTKIT_SWIFT.includes("hasRecurrenceRules"), "a series has to be recognised before it can be split");
  assert.ok(EVENTKIT_SWIFT.includes("occurrenceDate"));
  // The dangerous line, verbatim: the bare identifier used as the whole id.
  const code = EVENTKIT_SWIFT.split("\n").filter((line) => !line.trim().startsWith("//"));
  assert.ok(
    !code.some((line) => line.includes('"id": ev.eventIdentifier ?? UUID().uuidString')),
    "every occurrence would share this string",
  );
});

test("two occurrences of one series survive as two events", () => {
  // The Node side only passes the helper's id through, so this is what it must be handed —
  // and what it must not collapse.
  const events = parseHelperEvents(
    JSON.stringify([
      { id: "SERIES_2026-09-14T09:00:00.000Z", title: "Standup", start: "2026-09-14T09:00:00.000Z", end: "2026-09-14T09:30:00.000Z" },
      { id: "SERIES_2026-09-15T09:00:00.000Z", title: "Standup", start: "2026-09-15T09:00:00.000Z", end: "2026-09-15T09:30:00.000Z" },
    ]),
    { accountId: "acc", calendarId: "cal", calendarName: "Calendar" },
  );
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.id)).size, 2);
});

// --- Not leaving the previous design behind ---
//
// The helper used to be a bare executable beside the state file, with its Info.plist as a
// sidecar. It is an application bundle now, and the two old files are dead the moment that
// lands — but they are dead on every machine that ever ran the old build, not only on the one
// where the change was made. A hundred kilobytes of unreachable binary is not much; leaving
// it for somebody to find and wonder about later is the part worth avoiding.

test("the files the previous design left behind are named for removal", () => {
  assert.deepEqual(
    LEGACY_HELPER_FILES.map((path) => path.split("/").pop()),
    ["calendar-eventkit", "calendar-eventkit.plist"],
  );
  // The Swift source is NOT among them: it is still written and still compared against on
  // every build, and deleting it would force a recompile on every single launch.
  assert.ok(!LEGACY_HELPER_FILES.some((path) => path.endsWith(".swift")));
});

test("the helper's build inputs are byte-identical to the build macOS granted", () => {
  // A new code hash means macOS asks for calendar access again (see README). Changing either
  // value here is a decision to ask the user again, not a test to update.
  const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
  assert.equal(sha1(EVENTKIT_SWIFT), "8e7f9b622d8892ad1f3686642e689c072303e3b3");
  assert.equal(sha1(helperInfoPlist()), "00e962347fde5259f15d17b49ec5a6559f50ae40");
});

test("a read's temp files left by a daemon stopped mid-read are swept, and nothing else", async () => {
  // Each read's output holds titles, guests and notes, and is deleted at once; a daemon killed
  // mid-read leaves its pair behind, so the next start removes those, and only those.
  const dir = await mkdtemp(join(tmpdir(), "calendar-sweep-"));
  const old = Date.now() / 1000 - 3600;
  const names = {
    leftOut: "calendar-helper.111.0b7e2d4c-1f2a-4c3d-9e8f-123456789abc.out",
    leftErr: "calendar-helper.111.0b7e2d4c-1f2a-4c3d-9e8f-123456789abc.err",
    ours: `calendar-helper.${process.pid}.1d2e3f40-5a6b-4c7d-8e9f-abcdefabcdef.out`,
    fresh: "calendar-helper.222.2c3d4e5f-6a7b-4c8d-9e0f-fedcbafedcba.out",
    other: "calendar-helper.notes.txt",
  };
  for (const name of Object.values(names)) await writeFile(join(dir, name), "x");
  for (const name of [names.leftOut, names.leftErr, names.ours, names.other]) await utimes(join(dir, name), old, old);
  assert.equal(await sweepHelperLeftovers(dir), 2);
  assert.deepEqual((await readdir(dir)).sort(), [names.ours, names.fresh, names.other].sort());
});
