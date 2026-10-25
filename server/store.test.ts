import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backupV1, emptyStored, migrateStored, readStored, storedChanged, storedKey, writeStored, type Stored } from "./store.ts";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "calendar-store-"));
  return join(dir, "calendar.json");
}

const V1 = {
  accounts: [
    { id: "acc-g", provider: "google", email: "me@example.com", clientId: "cid", clientSecret: "secret", tenant: "common", sourceId: "",
      tokens: { access: "a", refresh: "r", expiresAt: "2026-09-09T12:00:00.000Z" }, calendars: [{ id: "primary", name: "Work", shown: true }], lastError: "" },
    { id: "acc-sys", provider: "system", email: "Exchange", clientId: "cid", clientSecret: "secret", tenant: "common", sourceId: "src-ex",
      calendars: [{ id: "cal-1", name: "Calendar", shown: true }, { id: "cal-2", name: "Birthdays", shown: false }], lastError: "gone" },
    { id: "acc-old", provider: "microsoft", email: "Old Exchange", clientId: "", clientSecret: "", tenant: "common", calendars: [], lastError: "" },
  ],
  pillLeadMinutes: 15,
  defaultView: "agenda",
};
const BLANK = { owner: "", kind: "", errorCode: "" as const, missingSince: "", lastSyncAt: "" };

test("a missing file reads as a first run, not as a broken one", async () => {
  assert.deepEqual(await readStored(await tempFile()), { stored: emptyStored(), broken: false });
});

test("a file that is not JSON is copied aside and read as broken, never as an empty store to write back", async () => {
  const path = await tempFile();
  await writeFile(path, "{ not json", "utf8");
  const result = await readStored(path);
  assert.equal(result.broken, true);
  if (!result.broken) return;
  assert.deepEqual(result.stored, emptyStored());
  assert.match(result.aside, /calendar\.json\.broken-\d{8}T\d{6}$/);
  assert.equal(await readFile(result.aside, "utf8"), "{ not json");
  assert.equal((await stat(result.aside)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), "{ not json", "the original is left exactly where it was");
});

test("the same broken file read twice is copied aside once", async () => {
  const path = await tempFile();
  await writeFile(path, "{ not json", "utf8");
  const first = await readStored(path);
  const second = await readStored(path);
  assert.ok(first.broken && second.broken);
  assert.equal(second.aside, first.aside);
  const copies = (await readdir(dirname(path))).filter((name) => name.includes(".broken-"));
  assert.equal(copies.length, 1);
});

// root reads and writes past any mode, so these two would pass for the wrong reason or fail.
const AS_ROOT = { skip: process.getuid?.() === 0 ? "file modes do not bind root" : false };

test("a copy the user deleted after fixing the file is made again when the same breakage comes back", async () => {
  const path = await tempFile();
  await writeFile(path, "{ not json", "utf8");
  const first = await readStored(path);
  assert.ok(first.broken && first.aside);
  await writeFile(path, JSON.stringify(emptyStored()));
  assert.equal((await readStored(path)).broken, false, "fixed");
  await unlink(first.aside); // tidied away as clutter
  await writeFile(path, "{ not json", "utf8");
  const again = await readStored(path);
  assert.ok(again.broken && again.aside);
  await stat(again.aside); // a copy that is claimed exists
});

test("a file that cannot be read is broken, not a first run", AS_ROOT, async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify(emptyStored()));
  await chmod(path, 0o000);
  try {
    const result = await readStored(path);
    assert.equal(result.broken, true);
    if (result.broken) assert.equal(result.aside, "", "nothing could be read, so nothing could be copied");
  } finally {
    await chmod(path, 0o600);
  }
});

test("a broken file whose copy cannot be written is still broken, and claims no copy", AS_ROOT, async () => {
  const path = await tempFile();
  await writeFile(path, "{ not json", "utf8");
  await chmod(dirname(path), 0o500);
  try {
    const result = await readStored(path);
    assert.equal(result.broken, true);
    if (result.broken) assert.equal(result.aside, "", "the copy was refused, so there is none to name");
    assert.equal(await readFile(path, "utf8"), "{ not json", "the original is left exactly where it was");
  } finally {
    await chmod(dirname(path), 0o700);
  }
});

test("what is written comes back", async () => {
  const path = await tempFile();
  const stored: Stored = {
    version: 2,
    accounts: [{ id: "acc-1", sourceId: "src-1", title: "Exchange", calendars: [{ id: "cal-1", name: "Calendar", shown: true }], lastError: "", ...BLANK, owner: "me@example.com", kind: "exchange" }],
    pillLeadMinutes: 30,
    defaultView: "day",
  };
  await writeStored(stored, path);
  assert.deepEqual(await readStored(path), { stored, broken: false });
});

test("the file is written 0600, because it lists the user's accounts", async () => {
  // No tokens any more, but which mailboxes this person reads and what they hide is still
  // theirs alone.
  const path = await tempFile();
  await writeStored(emptyStored(), path);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("one bad account is left out, the others are kept, and the read says it was broken", async () => {
  const path = await tempFile();
  await writeFile(
    path,
    JSON.stringify({
      accounts: [
        {
          id: "acc-ms", provider: "system", email: "Exchange", sourceId: "src-1",
          calendars: [{ id: "cal-1", name: "Calendar", shown: false }], lastError: "",
        },
        { id: "acc-bad", provider: "system" },
      ],
      pillLeadMinutes: 15,
    }),
  );
  const result = await readStored(path);
  assert.equal(result.broken, true);
  assert.deepEqual(result.stored.accounts.map((entry) => entry.id), ["acc-ms"]);
  assert.deepEqual(result.stored.accounts[0].calendars, [{ id: "cal-1", name: "Calendar", shown: false }]);
  assert.equal(result.stored.pillLeadMinutes, 15);
});

test("no temporary file is left behind", async () => {
  const path = await tempFile();
  await writeStored(emptyStored(), path);
  await assert.rejects(() => readFile(`${path}.${process.pid}.tmp`, "utf8"));
});

// --- Moving to v2 ---
//
// v1 had two doors: Google sign-in, with OAuth tokens and a client secret on disk, and the
// system door (once called "microsoft") through EventKit. v2 has only the second. A v1 file is
// migrated on the way in, and the first write after it keeps the original beside it.

test("a v1 file migrates on read: Google sign-in rows go, system rows keep their ids and choices, secrets do not survive", async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify(V1));
  const result = await readStored(path);
  assert.equal(result.broken, false);
  assert.equal(!result.broken && result.migrated, true);
  assert.deepEqual(result.stored, {
    version: 2,
    accounts: [
      { id: "acc-sys", sourceId: "src-ex", title: "Exchange", calendars: [{ id: "cal-1", name: "Calendar", shown: true }, { id: "cal-2", name: "Birthdays", shown: false }], lastError: "gone", ...BLANK },
      { id: "acc-old", sourceId: "", title: "Old Exchange", calendars: [], lastError: "", ...BLANK },
    ],
    pillLeadMinutes: 15,
    defaultView: "agenda",
  });
  assert.doesNotMatch(JSON.stringify(result.stored), /secret|tokens|provider|clientId|tenant/);
});

test("migrateStored leaves a v2 file exactly as it is", () => {
  const v2 = { version: 2, accounts: [] };
  assert.equal(migrateStored(v2), v2);
});

test("a v2 read is not reported as migrated", async () => {
  const path = await tempFile();
  await writeStored(emptyStored(), path);
  assert.deepEqual(await readStored(path), { stored: emptyStored(), broken: false });
});

test("a file from a newer build is read but never treated as writable", async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify({ version: 3, accounts: [] }));
  assert.equal((await readStored(path)).broken, true);
});

test("an account behind a door this build never had is left out, and the store turns read-only", async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify({ accounts: [{ id: "x", provider: "yahoo", email: "a@example.com" }] }));
  const result = await readStored(path);
  assert.equal(result.broken, true);
  assert.deepEqual(result.stored.accounts, []);
});

test("an account missing its title is left out, not half-loaded", async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify({ version: 2, accounts: [{ id: "acc-1" }] }));
  const result = await readStored(path);
  assert.equal(result.broken, true);
  assert.deepEqual(result.stored.accounts, []);
});

test("the first write over a v1 file keeps the original as .v1.bak, 0600", async () => {
  const path = await tempFile();
  const original = JSON.stringify(V1);
  await writeFile(path, original);
  const { stored } = await readStored(path);
  await writeStored(stored, path);
  assert.equal(await readFile(`${path}.v1.bak`, "utf8"), original);
  assert.equal((await stat(`${path}.v1.bak`)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
});

test("an existing .v1.bak is never overwritten", async () => {
  const path = await tempFile();
  await writeFile(`${path}.v1.bak`, "keep me");
  await writeFile(path, JSON.stringify(V1));
  await writeStored(emptyStored(), path);
  assert.equal(await readFile(`${path}.v1.bak`, "utf8"), "keep me");
});

test("a first run and a v2 file make no backup", async () => {
  const path = await tempFile();
  await writeStored(emptyStored(), path); // nothing there yet
  await writeStored(emptyStored(), path); // over a v2 file
  await assert.rejects(stat(`${path}.v1.bak`));
  assert.equal(await backupV1(path), false);
});

test("a file written before the board had a default opens on the day", async () => {
  // The field is defaulted, not required, so an upgrade reads cleanly rather than as broken — the
  // same property the pill's lead time relies on, and the reason both carry .default().
  const path = await tempFile();
  await writeFile(path, JSON.stringify({ accounts: [], pillLeadMinutes: 15 }));
  const back = (await readStored(path)).stored;
  assert.equal(back.defaultView, "day");
  assert.equal(back.pillLeadMinutes, 15, "the settings already in the file are kept");
});

test("a view nobody drew is refused rather than stored", async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify({ accounts: [], pillLeadMinutes: 15, defaultView: "year" }));
  const result = await readStored(path);
  assert.equal(result.broken, true);
  assert.equal(result.stored.defaultView, "day", "the bad field falls back to its default");
  assert.equal(result.stored.pillLeadMinutes, 15, "and only that field");
});

test("storedChanged is false for the same state and true for any change", () => {
  const state = emptyStored();
  const text = JSON.stringify(state);
  assert.equal(storedChanged(text, state), false);
  assert.equal(storedChanged(text, { ...state, pillLeadMinutes: 15 }), true);
  assert.equal(storedChanged("", state), true, "nothing read yet means a write is due");
});

test("a tick that only moved lastSyncAt is not a change worth writing", () => {
  const read: Stored = { ...emptyStored(), accounts: [{ id: "a", sourceId: "s1", title: "Exchange",
    calendars: [{ id: "c1", name: "Calendar", shown: true }], lastError: "", ...BLANK, lastSyncAt: "2026-10-26T09:00:00.000Z" }] };
  const prev = JSON.stringify(read);
  const ticked = { ...read, accounts: [{ ...read.accounts[0], lastSyncAt: "2026-10-26T09:05:00.000Z" }] };
  assert.equal(storedChanged(prev, ticked), false);
  assert.equal(storedChanged(prev, { ...ticked, pillLeadMinutes: 10 }), true);
  assert.equal(storedChanged(prev, { ...read, accounts: [{ ...read.accounts[0], owner: "me@example.com" }] }), true);
  assert.equal(storedChanged("", read), true, "nothing recorded yet: write");
  assert.equal(storedChanged("{not json", read), true);
  assert.equal(storedKey(ticked), storedKey(read));
});
