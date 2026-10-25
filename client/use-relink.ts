import { useRpc } from "@getpaseo/plugin/client";
import { type UseMutationResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { type SettingsView, relinkAccount } from "../shared/calendar.ts";
import { nudgePill } from "./pill-watch.ts";

/** The two cache calls a relink's outcome makes; QueryClient has both. */
export interface RelinkCache {
  setQueryData(key: readonly unknown[], data: SettingsView): unknown;
  invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<unknown>;
}

/**
 * Lands a relink's answer in the cache; `undefined` when the call itself failed. The offer on
 * screen must not outlive the tap either way, or it invites a second one the server refuses
 * again: a moved row's settings go straight into the cache, and a refusal or a lost call reads
 * them again, since nothing polls Settings in the background to correct a stale offer.
 */
export function landRelink(
  cache: RelinkCache,
  result: { error: string; settings: SettingsView | null } | undefined,
): void {
  if (!result?.settings) {
    void cache.invalidateQueries({ queryKey: ["calendar", "settings"] });
    return;
  }
  cache.setQueryData(["calendar", "settings"], result.settings);
  // The row now reads a different source, so its meetings are read again. A refusal moved
  // nothing, and leaves them be.
  void cache.invalidateQueries({ queryKey: ["calendar", "events"] });
  void cache.invalidateQueries({ queryKey: ["calendar", "range"] });
}

/**
 * Move a row onto the source its macOS account moved to. Shared by Settings and the board, so
 * both land the answer the same way (landRelink). The error stays with the caller to show.
 */
export function useRelink(): UseMutationResult<
  { error: string; settings: SettingsView | null },
  Error,
  { accountId: string; sourceId: string }
> {
  const askRelink = useRpc(relinkAccount);
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; sourceId: string }) => askRelink(input),
    onSuccess(result) {
      landRelink(queries, result);
      // The pill reads no react-query key, so a row that moved has it asked on its own, once
      // landRelink has invalidated the events. A refusal moved nothing, and leaves it be.
      if (result.settings) nudgePill();
    },
    onError() {
      landRelink(queries, undefined);
    },
  });
}
