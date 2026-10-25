import type { Attendee } from "./event.ts";

/**
 * A personal mailbox says where somebody reads their mail, not who they work for. Showing
 * "Gmail" as a company would be worse than showing nothing.
 */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "gmx.com", "mail.com", "yandex.ru", "ukr.net", "i.ua", "meta.ua",
]);

/**
 * Enough of the public suffix list to be right about the addresses that actually turn up
 * in these calendars. A full list is a dependency and a monthly update for a label.
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au", "com.br", "com.ua", "co.il",
  "com.tr", "co.nz", "com.pl", "co.za",
]);

export function registrableDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const host = email.slice(at + 1).trim().toLowerCase();
  if (!host.includes(".")) return "";
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

export function companyName(domain: string): string {
  const labels = domain.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const root = TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(0, -2) : labels.slice(0, -1);
  const name = root[root.length - 1] ?? "";
  return name
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}

export function companyOfAttendee(attendee: Attendee, ownDomains: Set<string>): string | null {
  // You are never external to your own meeting. Checked before the domain set, because that
  // set is discovered and can be empty: a system account's identity is its macOS source
  // title — the bare word "Exchange" on a real machine — which carries no domain, and
  // without this the viewer's own row was tagged external on every Exchange meeting.
  if (attendee.self) return null;
  const domain = registrableDomain(attendee.email);
  if (!domain || ownDomains.has(domain) || FREE_MAIL.has(domain)) return null;
  return companyName(domain);
}

/**
 * The companies on the other side of the table. In a meeting where everybody is a
 * colleague this is empty, which is the point: a column repeating your own employer on
 * every row is noise dressed as information.
 */
export function externalCompanies(attendees: Attendee[], ownDomains: Set<string>): string[] {
  const seen: string[] = [];
  for (const attendee of attendees) {
    const company = companyOfAttendee(attendee, ownDomains);
    if (company && !seen.includes(company)) seen.push(company);
  }
  return seen;
}
