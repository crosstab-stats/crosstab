/**
 * @file event-bus.js
 * App-wide publish/subscribe event system.
 *
 * The event bus is the loosest coupling mechanism in the engine. Core modules
 * and plugins emit named events and subscribe to them without holding direct
 * references to one another. This keeps the plugin contract small: a plugin
 * can react to "the data changed" without knowing which module changed it.
 *
 * Naming convention for event names is `namespace:verb`, e.g. `data:changed`,
 * `analysis:started`, `webr:ready`. Built-in event names are exported from
 * {@link CoreEvents} so callers do not hardcode strings.
 *
 * This module is intentionally dependency-free so every other core module can
 * import it.
 */

/**
 * Canonical names for events the engine itself emits. Plugins may define their
 * own event names freely; these are the ones the core guarantees.
 *
 * @readonly
 * @enum {string}
 */
export const CoreEvents = Object.freeze({
  /** The canonical dataset was replaced or mutated. Payload: see data-store. */
  DATA_CHANGED: 'data:changed',
  /** The user's variable selection in the UI changed. Payload: string[] names. */
  SELECTION_CHANGED: 'selection:changed',
  /** The WebR runtime finished initialising and can accept jobs. No payload. */
  WEBR_READY: 'webr:ready',
  /** The WebR runtime crashed (e.g. out of memory) and is unusable until
   * restarted. Further jobs fail fast until {@link WebRManager#restart}. No payload. */
  WEBR_CRASHED: 'webr:crashed',
  /** A WebR job moved through its lifecycle. Payload: { id, status }. */
  WEBR_JOB: 'webr:job',
  /** A plugin began an analysis. Payload: { plugin, title }. */
  ANALYSIS_STARTED: 'analysis:started',
  /** A plugin finished an analysis. Payload: { plugin, title }. */
  ANALYSIS_FINISHED: 'analysis:finished',
  /** A recoverable error surfaced that the UI may want to show. Payload: Error. */
  ERROR: 'app:error',
  /** The active (loaded) plugin set changed — a plugin was enabled/disabled or a
   * set was applied. Lets the project autosave re-record its `activePlugins`. No
   * payload. */
  PLUGINS_CHANGED: 'plugins:changed',
  /** A plugin workspace wrote its state blob. Lets the project autosave persist
   * the workspace sidecar. Payload: { id } (the workspace id). */
  WORKSPACE_CHANGED: 'workspace:changed',
});

/**
 * A minimal, synchronous-dispatch event bus.
 *
 * Handlers are invoked in subscription order. A throwing handler is isolated:
 * its error is reported to the console and (if listeners exist) re-emitted as a
 * {@link CoreEvents.ERROR} event, but it never prevents other handlers from
 * running. Dispatch is synchronous so that, for example, a results renderer can
 * rely on having reacted to `data:changed` before the emitting code continues.
 */
export class EventBus {
  /** @type {Map<string, Set<Function>>} */
  #handlers = new Map();

  /**
   * Subscribe to an event.
   *
   * @param {string} eventName - Event to listen for.
   * @param {(payload: any) => void} handler - Called with the emitted payload.
   * @returns {() => void} An unsubscribe function. Call it to remove `handler`.
   */
  on(eventName, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on: handler for "${eventName}" must be a function`);
    }
    let set = this.#handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.#handlers.set(eventName, set);
    }
    set.add(handler);
    return () => this.off(eventName, handler);
  }

  /**
   * Subscribe to an event for a single dispatch, then auto-unsubscribe.
   *
   * @param {string} eventName - Event to listen for.
   * @param {(payload: any) => void} handler - Called once.
   * @returns {() => void} An unsubscribe function (in case you want to cancel
   *   before the event ever fires).
   */
  once(eventName, handler) {
    const off = this.on(eventName, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /**
   * Remove a previously registered handler. No-op if it was not registered.
   *
   * @param {string} eventName - Event the handler was registered for.
   * @param {Function} handler - The exact handler reference passed to `on`.
   */
  off(eventName, handler) {
    const set = this.#handlers.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.#handlers.delete(eventName);
  }

  /**
   * Emit an event to all current subscribers.
   *
   * @param {string} eventName - Event to dispatch.
   * @param {any} [payload] - Arbitrary payload passed to each handler.
   */
  emit(eventName, payload) {
    const set = this.#handlers.get(eventName);
    if (!set) return;
    // Iterate a copy so handlers may unsubscribe (or subscribe) during dispatch.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // Avoid infinite loops: never re-emit ERROR from within ERROR dispatch.
        console.error(`EventBus: handler for "${eventName}" threw`, err);
        if (eventName !== CoreEvents.ERROR) {
          this.emit(CoreEvents.ERROR, err);
        }
      }
    }
  }

  /**
   * Remove every handler for an event, or every handler for every event.
   *
   * @param {string} [eventName] - If given, clear only this event; otherwise
   *   clear the entire bus. Mainly useful in tests and teardown.
   */
  clear(eventName) {
    if (eventName === undefined) this.#handlers.clear();
    else this.#handlers.delete(eventName);
  }
}
