/**
 * A one-at-a-time gate for the single control that performs a write.
 *
 * `disabled={isPending}` is not this guard. isPending only becomes true after mutate() has
 * triggered a state update, React has re-rendered, and the new prop has been committed and
 * propagated to the native touch responder — which reads it after the commit, not at the
 * moment of the press. A second press landing inside that window calls mutate() again, and
 * nothing downstream deduplicates it: useRpc is a bare callback with no in-flight tracking,
 * the mutation carries no key, and sync.ts's queue only orders operations. Both would run to
 * completion — two real events in somebody's calendar, synced to the account.
 *
 * So the gate has to close synchronously, at the top of the handler, before any of that
 * begins. `disabled` stays as the visible affordance; this is the correctness of it.
 */
export interface SubmitLatch {
  /** True for the first caller only, until release(). The write goes behind this. */
  claim(): boolean;
  /** Whether a claim is outstanding — what a control that must not act during the write
   *  reads before acting. */
  held(): boolean;
  /**
   * Reopens the latch. Belongs on a path that runs for both outcomes — react-query's
   * onSettled — so that a write which failed leaves the form usable rather than sealed
   * shut, which is the failure mode a latch invites and the reason to be careful with one.
   */
  release(): void;
}

export function createSubmitLatch(): SubmitLatch {
  let closed = false;
  return {
    claim() {
      if (closed) return false;
      closed = true;
      return true;
    },
    held() {
      return closed;
    },
    release() {
      closed = false;
    },
  };
}
