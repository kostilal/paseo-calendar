/**
 * Which meeting the board should open when it next has the chance.
 *
 * The composer pill and the board are two components with no relationship: `openSurface`
 * takes a surface name and nothing else, and the board holds the opened event in its own
 * local state. So pressing a pill that says "Standup in 1 min" could only ever land on the
 * agenda, leaving somebody to find in a list the thing they had just pointed at.
 *
 * This is the one-slot mailbox between them. It has to be a mailbox rather than a callback
 * because of the ordering: the press happens first, the board mounts second, and its events
 * arrive third — so the request has to sit and wait to be collected, not be delivered.
 */

let wanted: string | null = null;
const listeners = new Set<() => void>();

/** `key` is shared/group.ts's eventKey — {accountId, id}, unique per occurrence. */
export function requestFocus(key: string): void {
  wanted = key;
  // Copied before iterating: a listener that unsubscribes itself while being notified would
  // otherwise mutate the set mid-loop.
  for (const listener of [...listeners]) listener();
}

/** Still waiting to be collected. Deliberately does not clear: see clearFocus. */
export function pendingFocus(): string | null {
  return wanted;
}

/**
 * Collected. Kept separate from reading because the board can read this before its events
 * have loaded, and a request dropped on that first read would be a press that did nothing.
 * It clears only once the event it names has actually been found and opened.
 */
export function clearFocus(): void {
  wanted = null;
}

export function subscribeFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
