import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "./event.ts";
import { joinUrl } from "./join.ts";

function event(over: Partial<Event>): Event {
  return {
    id: "e",
    accountId: "acc",
    calendarId: "primary",
    calendarName: "Work",
    title: "Meeting",
    start: "2026-09-09T11:00:00.000Z",
    end: "2026-09-09T12:00:00.000Z",
    allDay: false,
    recurring: false,
    mine: true,
    attendees: [],
    location: "",
    description: "",
    webLink: "",
    myResponse: "accepted",
    ...over,
  };
}

test("a teams link in the description is found", () => {
  const found = joinUrl(event({ description: "Join here: https://teams.microsoft.com/l/meetup-join/xyz thanks" }));
  assert.equal(found?.kind, "teams");
  assert.equal(found?.url, "https://teams.microsoft.com/l/meetup-join/xyz");
});

test("a zoom link in the location is found", () => {
  const found = joinUrl(event({ location: "https://company.zoom.us/j/123456?pwd=abc" }));
  assert.equal(found?.kind, "zoom");
});

test("the location is preferred over the description", () => {
  const found = joinUrl(event({
    location: "https://meet.google.com/aaa-bbbb-ccc",
    description: "https://teams.microsoft.com/l/meetup-join/xyz",
  }));
  assert.equal(found?.kind, "meet");
});

test("a trailing bracket or full stop is not part of the URL", () => {
  const found = joinUrl(event({ description: "(https://meet.google.com/aaa-bbbb-ccc)." }));
  assert.equal(found?.url, "https://meet.google.com/aaa-bbbb-ccc");
});

test("a room name is not a link", () => {
  assert.equal(joinUrl(event({ location: "Meeting room 4, second floor" })), null);
});
