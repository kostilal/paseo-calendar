import { test } from "node:test";
import assert from "node:assert/strict";
import type { Attendee } from "./event.ts";
import { companyName, companyOfAttendee, externalCompanies, registrableDomain } from "./company.ts";

function attendee(email: string): Attendee {
  return { name: email, email, response: "accepted", self: false, organiser: false };
}

test("the registrable domain drops the mailbox and the subdomain", () => {
  assert.equal(registrableDomain("max@mail.acme.example"), "acme.example");
  assert.equal(registrableDomain("Anna@ACME.example"), "acme.example");
});

test("a two-part public suffix keeps its second level", () => {
  assert.equal(registrableDomain("sam@shop.example.co.uk"), "example.co.uk");
});

test("a company name is the domain without its suffix, capitalised", () => {
  assert.equal(companyName("acme.example"), "Acme");
  assert.equal(companyName("example.co.uk"), "Example");
  assert.equal(companyName("acme-labs.example"), "Acme-Labs");
});

test("only external attendees produce a company", () => {
  const own = new Set(["example.com"]);
  assert.deepEqual(
    externalCompanies([attendee("me@example.com"), attendee("anna@acme.example")], own),
    ["Acme"],
  );
});

test("a meeting with only colleagues produces nothing", () => {
  assert.deepEqual(externalCompanies([attendee("me@example.com"), attendee("colleague@example.com")], new Set(["example.com"])), []);
});

test("free mail says nothing about a company and is left out", () => {
  assert.deepEqual(externalCompanies([attendee("someone@gmail.com")], new Set(["example.com"])), []);
});

test("each company appears once, in the order first seen", () => {
  const own = new Set(["example.com"]);
  assert.deepEqual(
    externalCompanies(
      [attendee("a@acme.example"), attendee("b@globex.example"), attendee("c@acme.example")],
      own,
    ),
    ["Acme", "Globex"],
  );
});

test("a malformed address is skipped rather than shown as a company", () => {
  assert.deepEqual(externalCompanies([attendee("not-an-address")], new Set(["example.com"])), []);
});

// --- You are never external to your own meeting ---
//
// The viewer's own row was being tagged "external" on any account whose own domain the
// plugin had not discovered — which, once a system account's identity became its macOS
// source title, meant every Exchange meeting: the title is the bare word "Exchange" and has
// no domain in it, so nobody's colleagues were recognised, the viewer included. Measured on
// the machine that reported it: 19 of 19 attendees tagged external, self among them.
//
// The `self` flag is the provider's own answer to "is this you", so it settles the question
// without depending on domain discovery working at all.

test("the viewer is not external, whatever is known about their domain", () => {
  const me: Attendee = { name: "Me", email: "me@example.com", response: "accepted", self: true, organiser: false };
  assert.equal(companyOfAttendee(me, new Set()), null);
  assert.equal(companyOfAttendee(me, new Set(["example.org"])), null);
});

test("a colleague on the same domain as the viewer is still judged by the domain set", () => {
  // The self flag answers only for self; everyone else still needs the domain to be known,
  // which is what ownDomains harvesting self's address is for.
  const colleague: Attendee = { name: "A", email: "colleague@acme.example", response: "accepted", self: false, organiser: false };
  assert.equal(companyOfAttendee(colleague, new Set(["acme.example"])), null);
  assert.equal(companyOfAttendee(colleague, new Set()), "Acme");
});
