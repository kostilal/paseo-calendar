import { test } from "node:test";
import assert from "node:assert/strict";
import * as contracts from "./calendar.ts";

test("the wire contracts carry no trace of the Google door", () => {
  assert.equal("provider" in contracts, false);
  assert.equal("respondToEvent" in contracts, false);
  assert.equal("provider" in contracts.eventView.shape, false);
  for (const key of ["provider", "email", "connected", "clientId"]) assert.equal(key in contracts.accountView.shape, false, key);
  for (const key of ["canConnect", "googleConfigured"]) assert.equal(key in contracts.settingsView.shape, false, key);
  for (const key of ["provider", "clientId", "clientSecret", "tenant"]) assert.equal(key in contracts.connectAccount.input.shape, false, key);
  assert.equal("provider" in contracts.connectJob.shape, false);
  assert.equal("notify" in contracts.updateEvent.input.shape, false);
  assert.equal("notify" in contracts.deleteEvent.input.shape, false);
  assert.equal("conferencing" in contracts.createEvent.input.shape, false);
  // EventKit sends no invitations, so the board's create carries no guests.
  assert.equal("attendees" in contracts.createEvent.input.shape, false);
});
