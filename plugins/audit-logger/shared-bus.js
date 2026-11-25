/**
 * Process-wide shared event bus & session metadata registry for opencode-workflow.
 *
 * OpenCode's shared daemon (`openchamber.service`) loads plugins once per active location
 * directory in the same Node process. Location-scoped hooks (`session.prompt`,
 * `tool.execute.*`, `permission.evaluate`, `shell.create.before`) fire once per call on the
 * owning location, whereas `ctx.event.subscribe()` streams daemon-wide events to EVERY
 * loaded plugin instance — causing 3x-37x duplicate JSONL lines in production audit logs.
 *
 * This module solves both problems cleanly:
 *   1. Ref-counted single event subscriber per canonical `auditDir` group, with automatic
 *      failover to another live instance if the owning location unloads.
 *   2. Bounded LRU `eventID` deduplication set (`MAX_SEEN_EVENT_IDS`) as belt-and-braces
 *      against overlap during failover or host replay.
 *   3. Shared bounded `sessionMeta` map (`directory`, `workspaceID`, `model`, `agent`,
 *      `parentSessionID`, `rootSessionID`) so `tool.*` and `session.usage.updated` records
 *      carry authoritative workspace and model attribution.
 */

import path from 'node:path';

export const BUS_SYMBOL = Symbol.for('opencode-workflow.shared-bus.v2');
export const MAX_SEEN_EVENT_IDS = 10_000;
export const MAX_SESSION_META = 5_000;
export const SUBSCRIBER_STOP_TIMEOUT_MS = 1_000;

/** Bounded FIFO/LRU set for eventID deduplication. */
export class BoundedSeenSet {
  constructor(limit = MAX_SEEN_EVENT_IDS) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_SEEN_EVENT_IDS;
    this.set = new Set();
  }

  get size() {
    return this.set.size;
  }

  has(key) {
    return this.set.has(key);
  }

  /** Returns true when `key` is new and was inserted; false when already seen. */
  addIfNew(key) {
    if (typeof key !== 'string' || key.length === 0) return true;
    if (this.set.has(key)) return false;
    this.set.add(key);
    while (this.set.size > this.limit) {
      const oldest = this.set.values().next();
      if (oldest.done) break;
      this.set.delete(oldest.value);
    }
    return true;
  }

  clear() {
    this.set.clear();
  }
}

/** Bounded insertion-ordered map for session metadata and lineage tracking. */
export class BoundedMetaMap {
  constructor(limit = MAX_SESSION_META) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_SESSION_META;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return this;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

/** Normalize a Model.Ref object or string into a canonical `provider/model[#variant]` string. */
export function formatModelRef(model) {
  if (typeof model === 'string') {
    const trimmed = model.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!model || typeof model !== 'object') return null;
  const provider =
    typeof model.providerID === 'string'
      ? model.providerID.trim()
      : typeof model.provider === 'string'
        ? model.provider.trim()
        : '';
  const id =
    typeof model.id === 'string'
      ? model.id.trim()
      : typeof model.modelID === 'string'
        ? model.modelID.trim()
        : typeof model.model === 'string'
          ? model.model.trim()
          : '';
  if (!id) return null;
  const variant = typeof model.variant === 'string' ? model.variant.trim() : '';
  const base = provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
  return variant ? `${base}#${variant}` : base;
}

function getRegistry() {
  if (!globalThis[BUS_SYMBOL]) {
    globalThis[BUS_SYMBOL] = new Map();
  }
  return globalThis[BUS_SYMBOL];
}

function createGroup(groupKey) {
  const seenEventIDs = new BoundedSeenSet(MAX_SEEN_EVENT_IDS);
  const sessionMeta = new BoundedMetaMap(MAX_SESSION_META);
  /** @type {Map<string, object>} */
  const instances = new Map();
  let nextInstanceSeq = 1;

  /** Active event stream owner state. */
  let activeOwnerId = null;
  let activeController = null;
  let activeStreamPromise = null;
  let activeStreamState = { ended: true };
  let subscriberGeneration = 0;
  let stoppingSubscriber = false;

  function updateSessionMeta(sessionID, patch = {}) {
    if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
    const prev = sessionMeta.get(sessionID) ?? {
      sessionID,
      directory: null,
      workspaceID: null,
      model: null,
      agent: null,
      parentSessionID: null,
      rootSessionID: null,
      updatedAt: 0,
    };
    const next = { ...prev, updatedAt: Date.now() };
    if (typeof patch.directory === 'string' && patch.directory.length > 0) {
      next.directory = patch.directory;
    }
    if (typeof patch.workspaceID === 'string' && patch.workspaceID.length > 0) {
      next.workspaceID = patch.workspaceID;
    }
    if (patch.model !== undefined && patch.model !== null) {
      const formatted = formatModelRef(patch.model);
      if (formatted) next.model = formatted;
    }
    if (typeof patch.agent === 'string' && patch.agent.length > 0) {
      next.agent = patch.agent;
    }
    if (typeof patch.parentSessionID === 'string' && patch.parentSessionID.length > 0) {
      next.parentSessionID = patch.parentSessionID;
    }
    if (typeof patch.rootSessionID === 'string' && patch.rootSessionID.length > 0) {
      next.rootSessionID = patch.rootSessionID;
    }
    sessionMeta.set(sessionID, next);
    return next;
  }

  function linkChildSession(childSessionID, parentSessionID, extra = {}) {
    if (typeof childSessionID !== 'string' || childSessionID.length === 0) return null;
    const rootSessionID = resolveRootSessionID(parentSessionID) ?? parentSessionID ?? childSessionID;
    const parentMeta = parentSessionID ? sessionMeta.get(parentSessionID) : null;
    return updateSessionMeta(childSessionID, {
      parentSessionID,
      rootSessionID,
      directory: extra.directory ?? parentMeta?.directory ?? null,
      workspaceID: extra.workspaceID ?? parentMeta?.workspaceID ?? null,
      agent: extra.agent ?? null,
    });
  }

  function resolveRootSessionID(sessionID) {
    if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
    let cursor = sessionID;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const meta = sessionMeta.get(cursor);
      if (!meta) break;
      if (meta.rootSessionID && meta.rootSessionID !== cursor) {
        cursor = meta.rootSessionID;
        continue;
      }
      if (meta.parentSessionID && meta.parentSessionID !== cursor) {
        cursor = meta.parentSessionID;
        continue;
      }
      break;
    }
    return cursor;
  }

  function getSessionMeta(sessionID) {
    if (typeof sessionID !== 'string' || sessionID.length === 0) return null;
    return sessionMeta.get(sessionID) ?? null;
  }

  function dispatchEvent(event, owner) {
    let eventID = null;
    try {
      eventID = event?.id;
    } catch {
      eventID = null;
    }
    if (typeof eventID === 'string' && eventID.length > 0) {
      if (!seenEventIDs.addIfNew(eventID)) {
        return false; // Duplicate eventID dropped.
      }
    }

    // Write the audit record via ONE active instance (preferring the owner, else first live).
    const writer = instances.has(owner.id) ? owner : instances.values().next().value;
    if (writer && typeof writer.onAuditEvent === 'function') {
      try {
        writer.onAuditEvent(event);
      } catch (error) {
        writer.onError?.('event.handler', error);
      }
    }

    // Notify any registered per-event observers (e.g., Blackboard / Wave 2 Reactive Guard)
    // once per unique event.
    for (const inst of instances.values()) {
      if (typeof inst.onBusEvent === 'function') {
        try {
          inst.onBusEvent(event);
        } catch (error) {
          inst.onError?.('event.observer', error);
        }
      }
    }
    return true;
  }

  function startSubscriber(owner) {
    if (!owner || !owner.eventDomain || typeof owner.eventDomain.subscribe !== 'function') {
      activeOwnerId = null;
      activeController = null;
      activeStreamPromise = null;
      activeStreamState = { ended: true };
      return;
    }
    const gen = ++subscriberGeneration;
    const controller = new AbortController();
    const streamState = { ended: false };
    activeOwnerId = owner.id;
    activeController = controller;
    activeStreamState = streamState;

    const promise = (async () => {
      try {
        const stream = owner.eventDomain.subscribe({
          types: owner.eventTypes,
          signal: controller.signal,
        });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          dispatchEvent(event, owner);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          owner.onError?.('event.subscriber', error);
        }
      } finally {
        streamState.ended = true;
        // If this stream ended unexpectedly (not aborted by teardown) and another live
        // sibling instance exists in the group, fail over once cleanly.
        if (
          !controller.signal.aborted &&
          !stoppingSubscriber &&
          subscriberGeneration === gen &&
          activeOwnerId === owner.id
        ) {
          const replacement = pickNextOwner(owner.id);
          if (replacement) {
            activeOwnerId = null;
            activeController = null;
            activeStreamPromise = null;
            startSubscriber(replacement);
          }
        }
      }
    })().catch(() => {
      streamState.ended = true;
    });

    activeStreamPromise = promise;
  }

  async function stopActiveSubscriber() {
    stoppingSubscriber = true;
    const controller = activeController;
    const streamPromise = activeStreamPromise;
    const streamState = activeStreamState;
    activeOwnerId = null;
    activeController = null;
    activeStreamPromise = null;
    activeStreamState = { ended: true };

    let aborted = false;
    try {
      if (controller) {
        try {
          controller.abort();
          aborted = controller.signal.aborted;
        } catch {
          aborted = false;
        }
      }
      if (streamPromise) {
        try {
          let timer;
          await Promise.race([
            streamPromise,
            new Promise((resolve) => {
              timer = setTimeout(resolve, SUBSCRIBER_STOP_TIMEOUT_MS);
              if (typeof timer.unref === 'function') timer.unref();
            }),
          ]);
          if (timer) clearTimeout(timer);
        } catch {
          // ignore
        }
      }
      return { aborted, ended: streamState.ended };
    } finally {
      stoppingSubscriber = false;
    }
  }

  function pickNextOwner(excludeId = null) {
    for (const inst of instances.values()) {
      if (excludeId && inst.id === excludeId) continue;
      if (inst.eventDomain && typeof inst.eventDomain.subscribe === 'function') {
        return inst;
      }
    }
    return null;
  }

  function registerInstance({ eventDomain, eventTypes, directory, onAuditEvent, onBusEvent, onError }) {
    const id = `inst_${nextInstanceSeq++}`;
    const entry = {
      id,
      eventDomain,
      eventTypes,
      directory: directory ?? null,
      onAuditEvent,
      onBusEvent,
      onError,
    };
    instances.set(id, entry);
    // Never start a competing subscriber while `stopActiveSubscriber()` is mid-await;
    // the finishing `unregister()` will pick up this instance if needed.
    if (
      activeOwnerId === null &&
      !stoppingSubscriber &&
      eventDomain &&
      typeof eventDomain.subscribe === 'function'
    ) {
      startSubscriber(entry);
    }

    let released = false;
    return {
      id,
      get isSubscriberOwner() {
        return activeOwnerId === id;
      },
      async unregister() {
        if (released) return { aborted: false, ended: activeStreamState.ended, failedOver: false };
        released = true;
        instances.delete(id);

        if (activeOwnerId === id) {
          const stopped = await stopActiveSubscriber();
          if (activeOwnerId === null) {
            const replacement = pickNextOwner();
            if (replacement) {
              startSubscriber(replacement);
              return { aborted: stopped.aborted, ended: stopped.ended, failedOver: true };
            }
          }
          if (instances.size === 0) {
            getRegistry().delete(groupKey);
          }
          return { aborted: stopped.aborted, ended: stopped.ended, failedOver: false };
        }

        if (instances.size === 0) {
          const stopped = await stopActiveSubscriber();
          getRegistry().delete(groupKey);
          return { aborted: stopped.aborted, ended: stopped.ended, failedOver: false };
        }
        return { aborted: false, ended: false, failedOver: false };
      },
    };
  }

  return {
    key: groupKey,
    registerInstance,
    updateSessionMeta,
    linkChildSession,
    resolveRootSessionID,
    getSessionMeta,
    seenEventIDs,
    sessionMeta,
    get instanceCount() {
      return instances.size;
    },
    get activeOwnerId() {
      return activeOwnerId;
    },
  };
}

/** Retrieve (or create) the shared bus group for a given canonical audit directory. */
export function getSharedBus(auditDir) {
  const key = typeof auditDir === 'string' && auditDir.length > 0 ? path.resolve(auditDir) : 'default';
  const registry = getRegistry();
  let group = registry.get(key);
  if (!group) {
    group = createGroup(key);
    registry.set(key, group);
  }
  return group;
}

/** Test-only helper to reset the process-wide registry between isolated tests. */
export function resetSharedBusForTests() {
  const registry = getRegistry();
  registry.clear();
}
