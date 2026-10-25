import { test } from "node:test";
import assert from "node:assert/strict";
import type { AccountView } from "../shared/calendar.ts";
import { t } from "../shared/i18n.ts";
import { formatClock, formatStamp } from "../shared/period.ts";
import {
  ERROR_RETRY_MS,
  UNKNOWN_POLL_READS,
  accountRow,
  connectFailureKey,
  connectFinished,
  connectIssue,
  formatDay,
  foundDetail,
  healthOf,
  kindWords,
  latestSync,
  settingsPollMs,
  updatedText,
} from "./settings-model.ts";

const en = t("en");
function row(extra: Partial<AccountView> = {}): AccountView {
  return { id: "ex", sourceId: "s1", title: "Exchange", owner: "", kind: "exchange",
    calendars: [{ id: "c1", name: "Calendar", shown: true }, { id: "c2", name: "Birthdays", shown: false }],
    lastSyncAt: "", lastError: "", errorCode: "", missingSince: "", relinkTo: null, ...extra };
}

test("the kind is said in words, telling Google and iCloud apart inside CalDAV", () => {
  assert.equal(kindWords({ kind: "exchange", title: "Exchange" }, en), "Exchange");
  assert.equal(kindWords({ kind: "caldav", title: "Google" }, en), "Google");
  assert.equal(kindWords({ kind: "caldav", title: "Work", owner: "someone@gmail.com" }, en), "Google");
  assert.equal(kindWords({ kind: "caldav", title: "iCloud" }, en), "iCloud");
  assert.equal(kindWords({ kind: "icloud", title: "Mine" }, en), "iCloud");
  assert.equal(kindWords({ kind: "caldav", title: "Fastmail" }, en), "CalDAV");
  assert.equal(kindWords({ kind: "birthdays", title: "Birthdays" }, en), en.kindBirthdays);
  assert.equal(kindWords({ kind: "local", title: "On My Mac" }, en), en.kindLocal);
  assert.equal(kindWords({ kind: "", title: "Exchange" }, en), en.kindOther);
});
test("a healthy row is named by its owner and counts what it shows", () => {
  assert.deepEqual(accountRow(row({ owner: "me@example.com" }), en, "en"), {
    id: "ex", label: "me@example.com", subtitle: `Exchange · ${en.calendarsShown(1, 2)}`, health: "ok", greyed: false, relink: null, reread: false,
  });
});
test("a row with no stored calendars offers to read them again, but only while its source is on this Mac", () => {
  // Never read and never under Found: without this the only repair would be Disconnect, then Add.
  assert.equal(accountRow(row({ calendars: [] }), en, "en").reread, true);
  assert.equal(accountRow(row(), en, "en").reread, false, "a row with calendars has nothing to re-read");
  assert.equal(accountRow(row({ calendars: [], errorCode: "source_gone", missingSince: "2026-10-20T09:00:00.000Z" }), en, "en").reread, false,
    "a connect to a gone source would only fail");
  assert.equal(accountRow(row({ calendars: [], sourceId: "" }), en, "en").reread, false, "no source to connect to");
});
test("a row whose source has gone is greyed and says since when", () => {
  // Noon UTC: the same calendar day in every zone from UTC−11 to UTC+11.
  const model = accountRow(row({ errorCode: "source_gone", missingSince: "2026-10-20T12:00:00.000Z" }), en, "en");
  assert.equal(model.subtitle, en.notOnMacSince("Oct 20, 2026"));
  assert.deepEqual([model.health, model.greyed], ["idle", true]);
});
test("a moved row is not greyed: it offers the relink", () => {
  const model = accountRow(row({ errorCode: "source_gone", missingSince: "2026-10-20T09:00:00.000Z",
    relinkTo: { sourceId: "src-exchange-new", title: "Exchange", calendars: 2 } }), en, "en");
  assert.deepEqual([model.health, model.greyed, model.relink], ["warn", false, { sourceId: "src-exchange-new", title: "Exchange" }]);
});
test("health follows the error code, not a connected flag", () => {
  assert.equal(healthOf(row({ errorCode: "helper_failed" })), "bad");
  assert.equal(healthOf(row({ errorCode: "unknown" })), "bad");
  assert.equal(healthOf(row({ errorCode: "access_needed" })), "warn");
  assert.equal(healthOf(row({ errorCode: "macos_required" })), "warn");
  assert.equal(healthOf(row({ calendars: [{ id: "c1", name: "Calendar", shown: false }] })), "idle");
  assert.equal(healthOf(row()), "ok");
});
test("one Updated line: the latest read, as a clock today and a full stamp otherwise", () => {
  const nowMs = Date.parse("2026-10-25T12:40:00.000Z");
  const accounts = [row({ lastSyncAt: "2026-10-25T12:30:00.000Z" }), row({ id: "g", lastSyncAt: "2026-10-25T12:38:00.000Z" }), row({ id: "x" })];
  assert.equal(latestSync(accounts), "2026-10-25T12:38:00.000Z");
  assert.equal(updatedText(accounts, nowMs, en, "en"), en.lastSync(formatClock(new Date("2026-10-25T12:38:00.000Z"), "en")));
  assert.equal(updatedText([row({ lastSyncAt: "2026-10-23T12:38:00.000Z" })], nowMs, en, "en"),
    en.lastSync(formatStamp(new Date("2026-10-23T12:38:00.000Z"), "en")));
  assert.equal(updatedText([row()], nowMs, en, "en"), "");
});
test("the screen polls only while something is in flight", () => {
  const base = { accounts: [row()], access: "granted" as const, connect: null };
  assert.equal(settingsPollMs(undefined), false);
  assert.equal(settingsPollMs(base), false);
  assert.equal(settingsPollMs({ ...base, connect: { state: "running" } }), 1500);
  assert.equal(settingsPollMs({ ...base, connect: { state: "failed" } }), false);
  assert.equal(settingsPollMs({ ...base, access: "asking" }), 1500);
  assert.equal(settingsPollMs({ ...base, access: "unknown" }), 1500, "rows exist, so the status read is just in flight");
  assert.equal(settingsPollMs({ ...base, accounts: [], access: "unknown" }), false, "never asked: do not poll forever");
  // A status read that failed, or a Mac that was never asked after a helper rebuild, stays
  // "unknown" until someone presses Allow access: the screen stops asking after a while.
  assert.equal(settingsPollMs({ ...base, access: "unknown" }, { reads: UNKNOWN_POLL_READS }), false);
  assert.equal(settingsPollMs(undefined, { failed: true }), ERROR_RETRY_MS, "a failed load is retried, as its banner says");
});
test("a found source reads as its kind and how many calendars it has", () => {
  assert.equal(foundDetail({ kind: "caldav", title: "iCloud", calendars: 4 }, en), `iCloud · ${en.calendarCount(4)}`);
});
test("a failed list of this Mac's accounts is asked again, so the screen's 'trying again' is true", () => {
  const base = { accounts: [row()], access: "granted" as const, connect: null };
  assert.equal(settingsPollMs({ ...base, foundFailed: true }), ERROR_RETRY_MS);
  assert.equal(settingsPollMs({ ...base, foundFailed: false }), false);
});
test("a connect has finished when a job seen running is seen done, and only then", () => {
  assert.equal(connectFinished("running", "done"), true);
  assert.equal(connectFinished("running", "failed"), false, "nothing new to read");
  assert.equal(connectFinished(undefined, "done"), false, "a finished job found on opening Settings is old news");
  assert.equal(connectFinished("done", "done"), false);
});
test("a failed Add names the account it was for, and is not shown again on a later visit", () => {
  const job = { sourceId: "s-icloud", state: "failed" as const, error: "eventkit helper timed out after 120000ms", code: "helper_failed" as const };
  const found = [{ id: "s-icloud", title: "iCloud", kind: "caldav", calendars: 3 }];
  assert.deepEqual(connectIssue(job, [], found, { seen: false, storeBanner: false }), { code: "helper_failed", message: job.error, label: "iCloud" });
  assert.equal(connectIssue(job, [], found, { seen: true, storeBanner: false }), null, "already shown on an earlier visit");
  // A failed "Read its calendars again" is about a row: named as the row is.
  assert.deepEqual(connectIssue(job, [row({ sourceId: "s-icloud", owner: "me@example.com" })], [], { seen: false, storeBanner: false })?.label, "me@example.com");
  assert.equal(connectIssue({ ...job, code: "store_broken" }, [], found, { seen: false, storeBanner: true }), null, "the store banner says it already");
  assert.equal(connectIssue({ ...job, state: "done" }, [], found, { seen: false, storeBanner: false }), null);
});
test("a failure is known by its source and its words, so the same failure is recognised on the next visit", () => {
  const job = { sourceId: "s1", state: "failed" as const, error: "boom", code: "unknown" as const };
  assert.equal(connectFailureKey(job), connectFailureKey({ ...job }));
  assert.notEqual(connectFailureKey(job), connectFailureKey({ ...job, sourceId: "s2" }));
  assert.equal(connectFailureKey({ ...job, state: "done" }), "");
  assert.equal(connectFailureKey(null), "");
});
test("the corners the row model was first written without: a bad date, a broken store, a subscription", () => {
  assert.equal(formatDay("not a date", "en"), "");
  assert.equal(healthOf(row({ errorCode: "store_broken" })), "bad");
  assert.equal(kindWords({ kind: "subscribed", title: "Holidays" }, en), en.kindSubscribed);
});
