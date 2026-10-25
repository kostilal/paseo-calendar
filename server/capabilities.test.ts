// Pinned away from Warsaw, the zone the fixtures use, so the description cannot
// name Warsaw as a default by coincidence.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";
import { addEvent, getSchedule, listCalendars } from "../shared/calendar.ts";
import { describeCalendar } from "./capabilities.ts";

interface Operation { id: string; kind: string; method: string; title: string; description?: string; default?: boolean;
  input?: { properties: Record<string, unknown>; required?: string[] }; fixed?: Record<string, unknown>;
  output: { fields: string[] }; outcome?: Record<string, unknown>; risk?: string; confirm?: string; confirmText?: string; untrusted?: boolean }
const described = JSON.parse(JSON.stringify(describeCalendar())) as { schema: string; summary: string; aliases: string[]; operations: Operation[] };
const op = (id: string) => described.operations.find((entry) => entry.id === id)!;
const ANSWERS: Record<string, Record<string, unknown>> = {
  [getSchedule.name]: getSchedule.output.shape, [listCalendars.name]: listCalendars.output.shape, [addEvent.name]: addEvent.output.shape };
const FIVE = ["calendar", "date", "duration_minutes", "start_time", "title"];

test("the description offers the schedule reads and the three add-event operations under their ids", () => {
  assert.equal(described.schema, "paseo.capabilities/1");
  assert.deepEqual(described.operations.map((entry) => [entry.id, entry.kind, entry.method]), [
    ["day", "read", "calendar.schedule"], ["period", "read", "calendar.schedule"],
    ["calendars", "read", "calendar.accounts"], ["event_preview", "read", "calendar.add"], ["add_event", "action", "calendar.add"]]);
  assert.deepEqual(described.operations.filter((entry) => entry.default).map((entry) => entry.id), ["day"]);
  // The default zone is the Mac's own, never a fixed one.
  assert.doesNotMatch(JSON.stringify(described), /default Europe\/Warsaw/);
  // Merging is across accounts only, and every calendar is read through Apple Calendar on this Mac.
  assert.doesNotMatch(JSON.stringify(described), /two calendars is one row|and Google/);
  assert.match(JSON.stringify(described), /The same meeting through two accounts is one row/);
});
test("adding an event always asks first, in the words ChatGPT knows, and the preview never writes", () => {
  const add = op("add_event");
  assert.equal(add.risk, "outward"); // God Mode lets only a "low" action skip the question
  assert.equal(add.confirm, "always");
  assert.equal(add.confirmText, "Add «{title}» on {date} at {start_time} (Mac time) for {duration_minutes} min to the calendar {calendar}?");
  assert.deepEqual(add.fixed, { dry_run: false });
  assert.deepEqual(add.outcome, { ok: "ok", error: "error" });
  assert.deepEqual(add.output.fields, ["summary", "status", "event", "provider_sync", "error"]);
  assert.deepEqual(op("event_preview").fixed, { dry_run: true });
  assert.deepEqual(op("event_preview").outcome, { error: "error" });
  assert.deepEqual(op("event_preview").output.fields, ["summary", "would_create", "conflicts", "error"]);
  assert.deepEqual(op("calendars").output.fields, ["summary", "warnings", "error"]);
});
test("the preview and the add take the five arguments ChatGPT knows, and the calendars read takes none", () => {
  for (const id of ["event_preview", "add_event"]) {
    assert.deepEqual(Object.keys(op(id).input!.properties).sort(), FIVE);
    assert.deepEqual([...(op(id).input!.required ?? [])].sort(), FIVE);
  }
  assert.equal(op("calendars").input, undefined);
  const args = { title: "Dentist", date: "tomorrow", start_time: "10:00", duration_minutes: 30, calendar: "me@example.com" };
  assert.ok(addEvent.input.safeParse({ ...args, dry_run: true }).success);
  assert.ok(!addEvent.input.safeParse(args).success); // no default: a caller that forgets dry_run must not write
  assert.ok(getSchedule.input.safeParse({ from: "2026-10-19", to: "2026-10-25", time_zone: "Europe/Warsaw" }).success);
});
test("every operation fits God Mode's limits and reads only fields its RPC answers", () => {
  for (const entry of described.operations) {
    assert.match(entry.id, /^[a-z][a-z0-9_]*$/);
    assert.match(entry.method, /^[a-z][a-z0-9._-]*$/);
    assert.ok(!entry.method.startsWith("meta."), entry.id);
    assert.ok(entry.title.length <= 80 && (entry.description ?? "").length <= 600 && (entry.confirmText ?? "").length <= 600, entry.id);
    for (const key of Object.keys(entry.fixed ?? {})) assert.ok(!(key in (entry.input?.properties ?? {})), `${entry.id}.${key}`);
    assert.ok(entry.output.fields.every((field) => field in ANSWERS[entry.method]), entry.id);
    assert.equal(entry.untrusted, true, entry.id);
  }
  assert.ok(described.summary.length <= 300);
});
test("the names people use for the Mac's calendar are aliases of this plugin", () => {
  for (const name of ["apple calendar", "mac calendar", "apple календарь", "календарь apple", "мак календарь", "календарь мака"])
    assert.ok(described.aliases.includes(name), name);
  assert.ok(!described.aliases.includes("mac-calendar")); // the earlier plugin's id, not an alias to take
  assert.ok(described.aliases.length <= 20); // God Mode keeps at most 20 aliases per plugin
});
test("what ChatGPT must say aloud comes in the first 300 characters, the part God Mode puts in a read's text", () => {
  const description = op("day").description ?? "";
  for (const phrase of ["Read `summary` aloud", "Not read", "stale"]) {
    const at = description.indexOf(phrase);
    assert.ok(at >= 0 && at + phrase.length <= 300, phrase);
  }
  assert.match(description, /more than 11 minutes old/);
  assert.match(description, /cancelled ones are left out and not counted/);
});
test("the arguments say what the code accepts: a period of 31 days, a day that is never empty for an add", () => {
  assert.match(getSchedule.input.shape.to.description ?? "", /at most 30 days after from \(31 days in all\)/);
  assert.match(getSchedule.input.shape.date.description ?? "", /weekday/);
  const args = { title: "Dentist", date: "", start_time: "10:00", duration_minutes: 30, calendar: "me@example.com", dry_run: true };
  assert.ok(!addEvent.input.safeParse(args).success, "an empty date must not silently mean today");
});
