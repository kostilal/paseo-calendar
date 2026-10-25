import type { Event } from "./event.ts";

export type Conference = "meet" | "teams" | "zoom" | "other";

/** Trailing punctuation belongs to the sentence, not the URL. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[).,;:\]}>'"]+$/;

export function kindOf(url: string): Conference {
  const host = url.toLowerCase();
  if (host.includes("meet.google.com")) return "meet";
  if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) return "teams";
  if (host.includes("zoom.us")) return "zoom";
  return "other";
}

function firstConferenceUrl(text: string): string | null {
  const matches = text.match(URL_PATTERN);
  if (!matches) return null;
  const cleaned = matches.map((match) => match.replace(TRAILING, ""));
  // A recognised provider beats an arbitrary link: a description often carries a wiki page
  // and an agenda alongside the one URL that actually joins the call.
  return cleaned.find((url) => kindOf(url) !== "other") ?? null;
}

/**
 * The location first and then the description, because plenty of invitations paste the link
 * and fill in nothing else; EventKit has no conferencing field of its own to read (see
 * eventkit.ts). `null` means the card shows no button rather than a dead one.
 */
export function joinUrl(event: Event): { url: string; kind: Conference } | null {
  for (const text of [event.location, event.description]) {
    const found = text ? firstConferenceUrl(text) : null;
    if (found) return { url: found, kind: kindOf(found) };
  }
  return null;
}
