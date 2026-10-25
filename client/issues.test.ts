import { test } from "node:test";
import assert from "node:assert/strict";
import { type AccountView, errorCode } from "../shared/calendar.ts";
import { t } from "../shared/i18n.ts";
import { asideName, boardIssues, issueText, privacyActionAvailable, rowProblem, settingsStale } from "./issues.ts";

const en = t("en");
function row(extra: Partial<AccountView> = {}): AccountView {
  return { id: "ex", sourceId: "s1", title: "Exchange", owner: "", kind: "exchange", calendars: [{ id: "c1", name: "Calendar", shown: true }],
    lastSyncAt: "", lastError: "", errorCode: "", missingSince: "", relinkTo: null, ...extra };
}
const goneError = { accountId: "ex", message: "this calendar account is no longer on this Mac", code: "source_gone" as const };

test("a source that is simply gone puts nothing on the board", () => {
  assert.deepEqual(boardIssues([goneError], [row({ errorCode: "source_gone", missingSince: "2026-10-20T09:00:00.000Z" })], en), []);
});
test("a moved source offers the relink right on the board, naming the account", () => {
  const moved = row({ owner: "me@example.com", errorCode: "source_gone", missingSince: "2026-10-20T09:00:00.000Z",
    relinkTo: { sourceId: "src-exchange-new", title: "Exchange", calendars: 2 } });
  assert.deepEqual(boardIssues([goneError], [moved], en), [{
    key: "relink:ex", tone: "warn", text: en.issueMoved("me@example.com"),
    action: { kind: "relink", accountId: "ex", sourceId: "src-exchange-new" }, actionLabel: en.relinkOffer("Exchange"),
  }]);
});
test("access refused is said once for every account, with the pane that fixes it", () => {
  const refused = { message: "calendar access not granted", code: "access_needed" as const };
  assert.deepEqual(boardIssues([{ accountId: "a", ...refused }, { accountId: "b", ...refused }], [row({ id: "a" }), row({ id: "b" })], en), [
    { key: "access_needed", tone: "warn", text: en.calendarAccessRefused, action: { kind: "privacy" }, actionLabel: en.openPrivacy },
  ]);
});
test("an unexplained failure names its account by owner, else by title, else not at all", () => {
  const issues = boardIssues(
    [{ accountId: "ex", message: "boom", code: "unknown" }, { accountId: "g", message: "bang", code: "unknown" }, { accountId: "gone", message: "pop", code: "unknown" }],
    [row({ owner: "me@example.com" }), row({ id: "g", title: "Google" })], en);
  assert.deepEqual(issues.map((i) => [i.key, i.tone, i.text]), [
    ["account:ex", "warn", en.issueAccount("me@example.com", "boom")],
    ["account:g", "warn", en.issueAccount("Google", "bang")],
    ["account:gone", "warn", en.syncIssue("pop")],
  ]);
});
test("a broken store says which copy it kept, once", () => {
  const message = "calendar.json could not be read; a copy is at /Users/me/.jobby-jobs/calendar.json.broken-20261025T101500";
  const issues = boardIssues([{ accountId: "", message, code: "store_broken" }, { accountId: "", message, code: "store_broken" }], [], en);
  assert.deepEqual(issues.map((i) => [i.key, i.tone, i.text]), [["store_broken", "bad", en.issueStoreBroken("calendar.json.broken-20261025T101500")]]);
  assert.equal(asideName("/Users/me/.jobby-jobs/calendar.json.broken-20261025T101500"), "calendar.json.broken-20261025T101500");
  assert.equal(asideName("no copy named here"), "");
});
test("a row's problem leaves the gone state to the row itself and words everything else", () => {
  assert.equal(rowProblem(row({ errorCode: "source_gone", lastError: "gone" }), en), "");
  assert.equal(rowProblem(row(), en), "");
  assert.equal(rowProblem(row({ errorCode: "helper_failed", lastError: "eventkit helper timed out after 15000ms" }), en),
    en.issueHelper("eventkit helper timed out after 15000ms"));
  assert.equal(rowProblem(row({ errorCode: "access_needed", lastError: "calendar access not granted" }), en), en.calendarAccessRefused);
});
test("every code has words in every locale", () => {
  for (const locale of ["en", "ru", "uk"] as const) {
    for (const code of errorCode.options) assert.ok(issueText(code, "boom", "Exchange", t(locale)).length > 0, `${locale}/${code}`);
  }
});
test("a copy is named only when the message carries one, and none is claimed when it does not", () => {
  // A name taken in the same second gets a suffix (store.ts's setAside), and that is the copy to name.
  assert.equal(asideName("kept at /tmp/calendar.json.broken-20261025T101500-2"), "calendar.json.broken-20261025T101500-2");
  assert.doesNotMatch(en.issueStoreBroken(""), /copy was kept/);
  for (const locale of ["en", "ru", "uk"] as const) {
    const strings = t(locale);
    const none = issueText("store_broken", "the stored calendar settings did not read cleanly", "", strings);
    assert.equal(none, strings.issueStoreBroken(""), locale);
    assert.doesNotMatch(none, /\.broken-/, locale);
    assert.notEqual(none, strings.issueStoreBroken("calendar.json.broken-20261025T101500"), locale);
  }
});
test("the board reads Settings again once per tick, and not on its first look", () => {
  // First sight of the snapshot: the settings query is fetching on mount anyway.
  assert.equal(settingsStale(undefined, "2026-10-25T10:00:00.000Z"), false);
  assert.equal(settingsStale(undefined, undefined), false);
  // A tick landed: its errors may name a row the cached settings know nothing new about.
  assert.equal(settingsStale("2026-10-25T10:00:00.000Z", "2026-10-25T10:05:00.000Z"), true);
  assert.equal(settingsStale("", "2026-10-25T10:00:00.000Z"), true);
  // The minute poll handed back the same snapshot, or the query has no data for a moment.
  assert.equal(settingsStale("2026-10-25T10:05:00.000Z", "2026-10-25T10:05:00.000Z"), false);
  assert.equal(settingsStale("2026-10-25T10:05:00.000Z", undefined), false);
});

test("the Privacy settings button is offered only where it can open the Mac's System Settings", () => {
  // The desktop app is a web build in Electron on the Mac; a phone has no such pane to open.
  assert.equal(privacyActionAvailable("web"), true);
  assert.equal(privacyActionAvailable("ios"), false);
  assert.equal(privacyActionAvailable("android"), false);
});
