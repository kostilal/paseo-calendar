import type { PluginButton, PluginButtonRegistration } from "@getpaseo/plugin/client";

/**
 * The registry's own narrow view of an agent update: only the two kinds it acts on. This
 * is described structurally rather than imported from @getpaseo/client's wide
 * PaseoAgentUpdate on purpose — that package is not among this plugin's allowed
 * client-bundle imports, and pulling it in would buy nothing here besides a name for two
 * fields. contributeClient casts the real update into this shape at the one point they
 * meet; everything the real type carries beyond these two kinds is simply not this
 * registry's business, the same as before this module existed.
 */
export type AgentUpdate =
  | { kind: "upsert"; agent: { id: string; workspaceId?: string } }
  | { kind: "remove"; agentId: string };

export interface PillRegistry {
  /**
   * Seeds from an already-fetched agent list. The update stream below only speaks when an
   * agent changes, so agents already sitting there when the client connects would stay
   * untracked until one of them changed — this is what covers them instead.
   */
  seed(entries: ReadonlyArray<{ agentId: string; workspaceId: string }>): void;
  /** The upsert/remove discrimination this module exists for. */
  apply(update: AgentUpdate): void;
  /**
   * Pushes one patch to every live pill. This is how the client entry reaches pills that are
   * currently hidden: their icons are unmounted, so nothing inside them can be re-rendered
   * into showing them again — see client/pill-watch.ts for why that matters.
   */
  updateAll(patch: Partial<PluginButton>): void;
  /** Removes every live registration. Idempotent; nothing applied afterwards does anything. */
  stop(): void;
}

/**
 * The bookkeeping behind one pill per agent: an agentId -> { workspaceId, registration } Map,
 * kept correct across both ways an agent can be reported (an upsert, repeated or not) and the
 * one way it can stop being reported (a remove). Knows nothing about React, react-native,
 * icons or JSX — `deps.attach` is the only place any of that lives, supplied by the caller.
 *
 * A repeat report for an already-tracked agent keeps its pill when it names the same
 * workspace, and removes-and-recreates it only when the workspace moved.
 * PluginButtonRegistration.update() can patch everything about a pill except its
 * workspaceId, so that is the one field that needs a new registration. An upsert without a
 * workspaceId is ignored outright, so one that names the pill's current workspace is provably
 * unchanged in that field. Rebuilding on every report, as this used to, re-mounted the pill on
 * every agent update and flashed its placeholder. A remove deletes the map entry outright:
 * without that branch a departed agent's registration would sit here forever, on the
 * unverifiable hope that the host unmounts an icon nobody can see.
 */
export function createPillRegistry(deps: {
  attach(agentId: string, workspaceId: string): PluginButtonRegistration;
}): PillRegistry {
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let stopped = false;

  function attach(agentId: string, workspaceId: string) {
    if (stopped) return;
    const existing = pills.get(agentId);
    if (existing?.workspaceId === workspaceId) return;
    existing?.registration.remove();
    pills.set(agentId, { workspaceId, registration: deps.attach(agentId, workspaceId) });
  }

  return {
    seed(entries) {
      for (const entry of entries) attach(entry.agentId, entry.workspaceId);
    },
    apply(update) {
      // Guards apply() itself now that the registry is a standalone unit a test can drive
      // directly: previously "no update arrives after stop" was true only because
      // unsubscribe() had already cut the real stream off by the time stopped flipped, a
      // property this module cannot lean on once it is called by hand.
      if (stopped) return;
      if (update.kind === "remove") {
        pills.get(update.agentId)?.registration.remove();
        pills.delete(update.agentId);
        return;
      }
      if (update.kind !== "upsert" || !update.agent.workspaceId) return;
      attach(update.agent.id, update.agent.workspaceId);
    },
    updateAll(patch) {
      if (stopped) return;
      for (const { registration } of pills.values()) registration.update(patch);
    },
    stop() {
      stopped = true;
      for (const { registration } of pills.values()) registration.remove();
      pills.clear();
    },
  };
}

/** The two calls tracking makes on `client.paseo.agents`, described structurally for the
 *  same reason AgentUpdate is: @getpaseo/client is not a client-bundle import. */
export interface AgentSource<Update> {
  list(options: { subscribe: {} }): Promise<{
    entries: ReadonlyArray<unknown>;
    subscription?: { release(): Promise<void> };
  }>;
  subscribe(handler: (update: Update) => void): () => void;
}

/** An entry's agent, wherever the host put it: `entry.agent` on the wire, the entry itself
 *  on older hosts. */
function agentOf(raw: unknown): { agentId: string; workspaceId: string } | null {
  const probe = (raw ?? {}) as Record<string, unknown>;
  const agent = (probe.agent ?? probe) as Record<string, unknown>;
  if (typeof agent.id !== "string" || typeof agent.workspaceId !== "string" || agent.workspaceId === "") return null;
  return { agentId: agent.id, workspaceId: agent.workspaceId };
}

/**
 * Feeds the registry every agent: the ones already there, then every one that comes or
 * goes. Returns the stop, which also stops the registry.
 *
 * The list is a *subscribing* one, and that is the whole of a fix. Paseo 0.10 streams
 * `agent_update` only to a client holding a list subscription; `agents.subscribe()` is a
 * local listener and asks the daemon for nothing. On 0.8 the plain listener was enough, so
 * after the upgrade the seed still worked and the stream went silent — every chat opened
 * after the plugin loaded had no pill until something reloaded it.
 */
export function trackAgents<Update>(agents: AgentSource<Update>, registry: PillRegistry): () => void {
  let stopped = false;
  let release: (() => Promise<void>) | null = null;

  const unsubscribe = agents.subscribe((update) => {
    registry.apply(update as unknown as AgentUpdate);
  });

  void agents
    .list({ subscribe: {} })
    .then((result) => {
      const subscription = result.subscription;
      if (subscription !== undefined) release = () => subscription.release();
      if (stopped) {
        void release?.().catch(() => {});
        return;
      }
      const entries: Array<{ agentId: string; workspaceId: string }> = [];
      for (const entry of result.entries) {
        const agent = agentOf(entry);
        if (agent !== null) entries.push(agent);
      }
      registry.seed(entries);
    })
    .catch(() => {
      // Nothing to seed from; the listener above still hears whatever the daemon sends.
    });

  return () => {
    stopped = true;
    unsubscribe();
    void release?.().catch(() => {});
    registry.stop();
  };
}
