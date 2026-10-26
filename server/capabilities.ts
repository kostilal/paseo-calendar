import { defineRpc } from "@getpaseo/plugin";
import { type ZodType, z } from "zod";
import { addEvent, addEventInput, getSchedule, listCalendars } from "../shared/calendar.ts";
import { STALE_AFTER_MS } from "../shared/schedule.ts";

/**
 * What God Mode may offer ChatGPT of this plugin: `paseo.capabilities/1`, answered by
 * `meta.describe` (God Mode's docs/plugin-capabilities.md). Reads, and one write: adding one
 * timed event, under the id and arguments an earlier Apple Calendar plugin for God Mode gave it,
 * which is what ChatGPT already knows how to call. It is risk `outward` because the event leaves
 * the Mac — macOS syncs it to the account, where other people may see it — and God Mode asks the
 * user before any action that is not `low`, so it never runs on a misheard sentence alone. Moving, editing, answering and deleting meetings stay on the board,
 * where a person sees what they press: a misheard sentence must never cancel a meeting on
 * nineteen people.
 */
export const describeRpc = defineRpc({
  name: "meta.describe",
  input: z.object({}),
  output: z.record(z.string(), z.unknown()),
});

const SCHEDULE_FIELDS = [
  "summary",
  "from",
  "to",
  "time_zone",
  "as_of",
  "stale",
  "events",
  "conflicts",
  "sources",
  "hidden",
  "error",
];

/**
 * What to say first, first: God Mode puts only the first 300 characters of this into a read's
 * text (the full text reaches ChatGPT only in the structured answer), so the instruction to read
 * every Not read and stale note aloud comes before anything else, and where the data comes from
 * comes last. The stale bound is STALE_AFTER_MS's, so the two cannot drift.
 */
const DESCRIPTION =
  "Read `summary` aloud, with every Not read and stale note in it: `sources` with ok false were not read, " +
  `and \`stale\` true means data more than ${STALE_AFTER_MS / 60_000} minutes old. Times are in \`time_zone\` ` +
  "(default: the Mac's own zone). The same meeting through two accounts is one row; cancelled ones are left " +
  "out and not counted; declined ones are left out and counted in `hidden`. `conflicts` are overlaps. Titles " +
  "only, no notes or guests. Every calendar connected in Paseo's Calendar plugin, all read from Apple " +
  "Calendar on this Mac (Outlook/Exchange, iCloud and other Internet Accounts).";

const { date, from, to, time_zone, with_links, include_declined } = getSchedule.input.shape;

const SCHEDULE_OPERATIONS = [
  {
    id: "day",
    title: "Schedule for a day",
    default: true,
    input: z.object({ date, time_zone, with_links, include_declined }),
  },
  {
    id: "period",
    title: "Schedule for a period",
    input: z.object({
      from: from.unwrap().min(1).describe(from.description ?? ""),
      to: to.unwrap().min(1).describe(to.description ?? ""),
      time_zone,
      with_links,
      include_declined,
    }),
  },
];

function jsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

/** The earlier plugin's three operations, in its words, on this plugin's own RPCs. */
function addOperations(): Record<string, unknown>[] {
  // dry_run is never offered: each operation fixes it, so a preview cannot write and the add
  // cannot be turned into a preview that ChatGPT then reports as done.
  const input = jsonSchema(addEventInput.omit({ dry_run: true }));
  return [
    {
      id: "calendars",
      kind: "read",
      method: listCalendars.name,
      title: "Calendars and accounts",
      description:
        "Accounts and calendars connected in Paseo's Calendar plugin on the Mac, their owner emails, which ones add_event can add " +
        "to ([w]), which are switched off ([hidden]), and which accounts are missing from the Mac. Use it to find the exact " +
        "calendar for adding an event.",
      output: { fields: ["summary", "warnings", "error"] },
      outcome: { error: "error" },
      // Shared calendars are named by whoever shares them.
      untrusted: true,
    },
    {
      id: "event_preview",
      kind: "read",
      method: addEvent.name,
      title: "Check an event before adding it",
      description:
        "Resolves the exact calendar, says whether the same event already exists, and lists overlaps. Creates nothing. Call " +
        "before add_event and tell the user the calendar and overlaps.",
      input,
      fixed: { dry_run: true },
      output: { fields: ["summary", "would_create", "conflicts", "error"] },
      outcome: { error: "error" },
      // The overlaps are other people's meeting titles.
      untrusted: true,
    },
    {
      id: "add_event",
      kind: "action",
      method: addEvent.name,
      title: "Add one event to a calendar",
      description:
        "Adds ONE timed event to the exact calendar the user named (it then syncs to that account). No guests, invitations, " +
        "video links or alarms; never edits or deletes. Repeating the same event returns the existing one (a repeat sent while the first is still saving may be refused; ask again a minute later). Answer: `summary`, " +
        "`event`, `provider_sync` (not_confirmed means saved on the Mac, upload to the provider not yet confirmed).",
      input,
      fixed: { dry_run: false },
      // Never "low": God Mode lets only a low action skip asking.
      risk: "outward",
      confirm: "always",
      // "Mac time" because the zone is not an argument: the user hears which clock 10:00 is on.
      confirmText: "Add «{title}» on {date} at {start_time} (Mac time) for {duration_minutes} min to the calendar {calendar}?",
      output: { fields: ["summary", "status", "event", "provider_sync", "error"] },
      outcome: { ok: "ok", error: "error" },
      untrusted: true,
    },
  ];
}

// Rendered on the first call rather than at load: a schema that will not render costs this
// RPC only, not the whole plugin.
let described: Record<string, unknown> | null = null;

export function describeCalendar(): Record<string, unknown> {
  described ??= {
    schema: "paseo.capabilities/1",
    title: "Calendar",
    summary:
      "Every calendar connected in Paseo on this Mac (Exchange/Outlook, Google, iCloud): read a day or a period, list the " +
      "calendars, and add one event after the user confirms it. Prefer it for the user's schedule and for adding events.",
    aliases: [
      "schedule", "agenda", "meetings", "календарь", "расписание", "встречи", "календар", "розклад",
      // The names people use for the Mac's calendar, which the earlier Apple Calendar plugin carried:
      // on an exact alias God Mode's pickPlugin takes the first plugin in its list, so a name two
      // enabled plugins both carried could land on either. That plugin's id, "mac-calendar", stays
      // out: an id is not an alias to take.
      "apple calendar", "mac calendar", "apple календарь", "календарь apple", "мак календарь", "календарь мака",
    ],
    operations: [
      ...SCHEDULE_OPERATIONS.map(({ input, ...op }) => ({
        ...op,
        kind: "read",
        method: getSchedule.name,
        description: DESCRIPTION,
        input: jsonSchema(input),
        output: { fields: SCHEDULE_FIELDS },
        outcome: { error: "error" },
        // Meeting titles are written by whoever sent the invitation.
        untrusted: true,
      })),
      ...addOperations(),
    ],
  };
  return described;
}
