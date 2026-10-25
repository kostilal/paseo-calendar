import { test } from "node:test";
import assert from "node:assert/strict";
import { TEAMS_BUNDLE_IDS, planFor, teamsDeepLink } from "./launch.ts";

const MEETUP =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_MEETINGID%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d";
const nothingInstalled = () => false;
const teamsInstalled = (id: string) => id === "com.microsoft.teams2";

test("a Teams meeting link converts to the app's own scheme, query and all", () => {
  // Everything past the host is identical between the two forms, and the query carries the
  // meeting context — rebuilding it rather than copying it is how a link ends up opening the
  // app to nowhere.
  assert.equal(teamsDeepLink(MEETUP), `msteams:/${MEETUP.slice("https://teams.microsoft.com/".length)}`);
  assert.ok(teamsDeepLink(MEETUP)?.includes("context=%7b%22Tid%22%3a%22abc%22%7d"));
  // teams.live.com is the consumer host and takes the same scheme.
  assert.equal(teamsDeepLink("https://teams.live.com/l/meetup-join/xyz"), "msteams:/l/meetup-join/xyz");
});

test("anything that is not a Teams link has no deep link, rather than a guessed one", () => {
  assert.equal(teamsDeepLink("https://meet.google.com/aaa-bbbb-ccc"), null);
  assert.equal(teamsDeepLink("https://example.com/teams.microsoft.com/l/x"), null);
  assert.equal(teamsDeepLink("not a url"), null);
});

test("Teams opens in the app when it is installed", () => {
  const plan = planFor(MEETUP, "teams", teamsInstalled);
  assert.equal(plan.via, "app");
  assert.ok(plan.target.startsWith("msteams:/"));
});

test("Teams falls back to the browser when no Teams app is present", () => {
  // Which is the honest answer: the web client can host the meeting, and pretending an app
  // exists would hand the OS a scheme nothing claims.
  const plan = planFor(MEETUP, "teams", nothingInstalled);
  assert.deepEqual(plan, { target: MEETUP, via: "browser" });
});

test("the predecessor bundle id counts as installed too", () => {
  const plan = planFor(MEETUP, "teams", (id) => id === "com.microsoft.teams");
  assert.equal(plan.via, "app");
  assert.deepEqual([...TEAMS_BUNDLE_IDS], ["com.microsoft.teams2", "com.microsoft.teams"]);
});

test("Meet always goes to a browser, because there is no Meet application to prefer", () => {
  // Even with every app in the world installed: Meet is a web product and the browser is
  // where the account is already signed in — which is precisely what the in-app window
  // lacked when it answered "You can't join this video call".
  const url = "https://meet.google.com/aaa-bbbb-ccc";
  assert.deepEqual(planFor(url, "meet", () => true), { target: url, via: "browser" });
});

test("Zoom and anything unrecognised go to a browser untouched", () => {
  // Zoom's own https link lands on a page that launches the app, so reaching it does not
  // require reconstructing a zoommtg: URL out of a meeting id and a password.
  const zoom = "https://us02web.zoom.us/j/8912345678?pwd=abc";
  assert.deepEqual(planFor(zoom, "zoom", () => true), { target: zoom, via: "browser" });
  const other = "https://whereby.com/standup";
  assert.deepEqual(planFor(other, "other", () => true), { target: other, via: "browser" });
});
