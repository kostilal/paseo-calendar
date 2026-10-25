import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { boardView, errorCode } from "../shared/calendar.ts";

/**
 * A fixed path, because a plugin cannot find its own directory. It holds no secrets, but it
 * does list which of this person's mailboxes are read and which calendars they hide, so it is
 * written 0600 and never read by a client.
 */
export const STATE_FILE = join(homedir(), ".jobby-jobs", "calendar.json");

/** One macOS calendar source, read through EventKit. */
const account = z.object({
  id: z.string(),
  // Which macOS calendar source this account reads. This — not the title — is what identifies
  // an account: source titles are not unique and are often just the word "Exchange".
  sourceId: z.string().default(""),
  /** What macOS calls the source. Required: a row nobody can name is not one to show. */
  title: z.string(),
  owner: z.string().default(""),
  kind: z.string().default(""),
  calendars: z.array(z.object({ id: z.string(), name: z.string(), shown: z.boolean() })).default([]),
  lastError: z.string().default(""),
  errorCode: errorCode.default(""),
  missingSince: z.string().default(""),
  lastSyncAt: z.string().default(""),
});

/**
 * Every top-level field but the accounts. Kept apart so parseStored can validate each field on
 * its own: one bad setting falls back to its default instead of costing the whole file.
 */
const envelope = z.object({
  /**
   * Required, so a file from a newer build (version 3 and up) is a broken, read-only read:
   * this build cannot know what it would lose by writing one back. migrateStored brings a v1
   * file up to this before it is validated.
   */
  version: z.literal(2),
  /**
   * How many minutes before a meeting the composer pill appears; 0 means always, which is
   * what it did before this was a choice. Defaulted rather than required, so a file written
   * by an earlier build reads back with the new behaviour instead of being rejected.
   */
  pillLeadMinutes: z.number().int().min(0).max(24 * 60).default(30),
  /**
   * Which view the board opens on. Defaulted for the same reason as the line above — a file
   * written before this existed has to read back with the new behaviour rather than be
   * rejected — and defaulted to the day rather than the list, which is the question "what am
   * I doing now" instead of "what is coming at some point this fortnight".
   */
  defaultView: boardView.default("day"),
});

const stored = envelope.extend({ accounts: z.array(account).default([]) });

export type StoredAccount = z.output<typeof account>;
export type Stored = z.output<typeof stored>;

export function emptyStored(): Stored {
  return { version: 2, accounts: [], pillLeadMinutes: 30, defaultView: "day" };
}

/**
 * The one v1 → v2 step, applied on the way in.
 *
 * v1 had two doors. Google sign-in stored OAuth tokens and a client secret; the system door,
 * once called "microsoft" after the one vendor it was first used for, read a macOS calendar
 * source through EventKit. v2 has only the second, so:
 * - a Google sign-in row is dropped: macOS can read the same mailbox as a system row;
 * - a system or microsoft row keeps its id, its source and its shown/hidden choices, and its
 *   `email` (which for this door was always the source's title) becomes `title`;
 * - every secret goes: tokens, client id and secret, tenant.
 * A row behind any other door is left as it was, so validation refuses it and the read turns
 * read-only instead of quietly dropping something this build does not understand.
 */
export function migrateStored(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  // v2, or a newer build's file: not ours to rewrite. Returned as the same object, which is how
  // readStored tells a migration happened.
  if (record.version !== undefined && record.version !== 1) return raw;
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [entry];
        const { provider, email, clientId: _id, clientSecret: _secret, tenant: _tenant, tokens: _tokens, ...rest } =
          entry as Record<string, unknown>;
        if (provider === "google") return []; // the sign-in door is gone; its mailbox is a system row too
        if (provider !== "system" && provider !== "microsoft") return [entry]; // unknown door: validation refuses it
        return [{ ...rest, title: email }];
      })
    : record.accounts;
  return { ...record, version: 2, accounts };
}

/**
 * What one read found. `broken` reads are for showing only: sync never writes after one.
 * `migrated` is present, and true, only when the file on disk is still v1: sync must write the
 * v2 form back even though nothing else changed.
 */
export type ReadResult = { stored: Stored; broken: false; migrated?: true } | { stored: Stored; broken: true; aside: string };

/**
 * Field by field and account by account, so whatever did validate survives: one account a
 * build cannot read must not take the others with it. `problems` names what was left out or
 * defaulted; any entry at all makes the read broken.
 */
export function parseStored(raw: unknown): { stored: Stored; problems: string[] } {
  const fallback = emptyStored();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { stored: fallback, problems: ["root"] };
  const record = raw as Record<string, unknown>;
  const problems: string[] = [];
  const head: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(envelope.shape)) {
    const field = schema.safeParse(record[key]);
    if (field.success) head[key] = field.data;
    else {
      head[key] = fallback[key as keyof typeof fallback];
      problems.push(key);
    }
  }
  const accounts: StoredAccount[] = [];
  const list = record.accounts ?? [];
  if (!Array.isArray(list)) problems.push("accounts");
  else
    list.forEach((entry, index) => {
      const one = account.safeParse(entry);
      if (one.success) accounts.push(one.data);
      else problems.push(`accounts[${index}]`);
    });
  return { stored: { ...(head as Omit<Stored, "accounts">), accounts }, problems };
}

/**
 * The store as JSON with every account's `lastSyncAt` blanked: what counts as a change worth
 * writing. `lastSyncAt` moves on every read, so it reaches the disk with the next real change,
 * and sync holds the live value meanwhile.
 */
export function storedKey(stored: Stored): string {
  return JSON.stringify({ ...stored, accounts: stored.accounts.map((account) => ({ ...account, lastSyncAt: "" })) });
}

/**
 * Whether `next` differs from the text last read or written (`prev`) in anything but a read
 * time. Both sides go through storedKey, so key order is the writer's own. A `prev` that is
 * empty (nothing recorded yet), not JSON, or not shaped like a store with an accounts list
 * (a raw v1 text, say) always counts as changed: the write is what puts it right.
 */
export function storedChanged(prev: string, next: Stored): boolean {
  if (!prev) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(prev);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { accounts?: unknown }).accounts)) return true;
  return storedKey(parsed as Stored) !== storedKey(next);
}

/**
 * The copy already made of each broken file. Sync reads on every tick and every settings poll,
 * so without this one broken file would gain a new copy every few minutes. Forgotten on a clean
 * read, and never reused once the copy is gone from disk: a banner naming a copy that no longer
 * exists would make deleting the only one look safe.
 */
const asides = new Map<string, { raw: string; aside: string }>();

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Copies a broken file beside itself, once per distinct content. "" when no copy could be made. */
async function setAside(path: string, raw: string, bytes: Buffer): Promise<string> {
  const known = asides.get(path);
  if (known?.raw === raw && (await exists(known.aside))) return known.aside;
  // UTC, YYYYMMDDTHHMMSS: sorts by time and has no character a shell or Finder minds.
  const base = `${path}.broken-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  for (let attempt = 1; attempt <= 9; attempt++) {
    const aside = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      // wx: never overwrite an earlier copy. The chmod is because the mode given to writeFile
      // passes through the umask; the copy is as private as the original (a v1 one may still
      // hold tokens).
      await writeFile(aside, bytes, { mode: 0o600, flag: "wx" });
      await chmod(aside, 0o600);
      asides.set(path, { raw, aside });
      return aside;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "";
    }
  }
  return "";
}

/**
 * Three outcomes, and only one of them is a first run. Absent (ENOENT) is the empty store.
 * Unreadable, not JSON, or failing validation anywhere is `broken`: whatever did validate is
 * returned to be shown, the file as found is copied aside, and sync must not write until a
 * read comes back clean. Treating broken as empty is what used to let the next tick write an
 * empty store over a file that only needed fixing.
 */
export async function readStored(path: string = STATE_FILE): Promise<ReadResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stored: emptyStored(), broken: false };
    return { stored: emptyStored(), broken: true, aside: "" };
  }
  const raw = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stored: emptyStored(), broken: true, aside: await setAside(path, raw, bytes) };
  }
  const next = migrateStored(parsed);
  const { stored, problems } = parseStored(next);
  // A migration that leaves problems is still a broken read: read-only beats half a v2 file.
  if (problems.length === 0) {
    asides.delete(path);
    return { stored, broken: false, ...(next !== parsed ? { migrated: true as const } : {}) };
  }
  return { stored, broken: true, aside: await setAside(path, raw, bytes) };
}

/**
 * Keeps a pre-v2 original beside the store as `<path>.v1.bak`, once. Called by writeStored
 * before every write, so the first v2 write over a v1 file is the one that makes it; true
 * only when a copy was made now. A v2 or newer file, a missing one or one that is not JSON
 * has nothing worth keeping, and an existing backup is never overwritten: a second v1 file
 * appearing later (an old build run again) must not replace the first original.
 */
export async function backupV1(path: string = STATE_FILE): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  if (version !== undefined && version !== 1) return false;
  const backup = `${path}.v1.bak`;
  try {
    // 0600 and chmod for setAside's reason: a v1 file holds OAuth tokens and a client secret.
    await writeFile(backup, bytes, { mode: 0o600, flag: "wx" });
    await chmod(backup, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Temp file then rename, so a daemon killed mid-write leaves either the old file or the
 * new one and never half of each. The temp file is created 0600 as well: the account list
 * must not be world-readable even for the moment between write and rename.
 */
export async function writeStored(value: Stored, path: string = STATE_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Before the temp file, and allowed to fail the write: losing the v1 original is worse than
  // one more tick spent on v1.
  await backupV1(path);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  // rename preserves the temp file's mode, but an older file at the destination may have
  // been created before this rule existed.
  await chmod(path, 0o600);
}
