import { useCallback, useRef, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// createStore<T> -- simple reactive store
// ---------------------------------------------------------------------------

type Listener = () => void;
type SetArg<T> = Partial<T> | ((prev: T) => Partial<T>);

export interface Store<T> {
  /** React hook: subscribe to the full state or a selected slice. */
  (): T;
  <U>(selector: (state: T) => U, equalityFn?: (a: U, b: U) => boolean): U;

  /** Read current state (non-reactive). */
  get: () => T;
  /** Merge partial state or apply an updater. */
  set: (arg: SetArg<T>) => void;
  /** Subscribe to any state change. Returns unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
}

export function createStore<T extends object>(initialState: T): Store<T> {
  let state = initialState;
  const listeners = new Set<Listener>();

  function get(): T {
    return state;
  }

  function set(arg: SetArg<T>): void {
    const partial = typeof arg === "function" ? arg(state) : arg;
    // Skip notify if nothing changed.
    const keys = Object.keys(partial) as (keyof T)[];
    if (keys.every((k) => Object.is(state[k], (partial as T)[k]))) return;
    state = Object.assign({}, state, partial);
    listeners.forEach((l) => l());
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  // The callable hook with overloads.
  function useStore(): T;
  function useStore<U>(
    selector: (s: T) => U,
    equalityFn?: (a: U, b: U) => boolean,
  ): U;
  function useStore<U>(
    selector?: (s: T) => U,
    equalityFn?: (a: U, b: U) => boolean,
  ): T | U {
    if (!selector) {
      // No selector -- subscribe to full state.
      return useSyncExternalStore(subscribe, get);
    }

    // Cache the last selected value to avoid unnecessary re-renders
    // when the selector returns a structurally-equal result.
    const cache = useRef<{ value: U; initialized: boolean }>({
      value: undefined as U,
      initialized: false,
    });

    const value = useSyncExternalStore(subscribe, () => {
      const next = selector(state);
      if (
        cache.current.initialized &&
        (equalityFn
          ? equalityFn(cache.current.value, next)
          : Object.is(cache.current.value, next))
      ) {
        return cache.current.value;
      }
      cache.current.value = next;
      cache.current.initialized = true;
      return next;
    });

    return value;
  }

  useStore.get = get;
  useStore.set = set;
  useStore.subscribe = subscribe;

  return useStore as Store<T>;
}

// ---------------------------------------------------------------------------
// createKeyedStore<V> -- per-key subscription store (for SceneTreeState)
// ---------------------------------------------------------------------------

export interface KeyedStore<V> {
  /** React hook: subscribe to a single key, optionally with selector. */
  (key: string): V | undefined;
  <U>(
    key: string,
    selector: (val: V | undefined) => U,
    equalityFn?: (a: U, b: U) => boolean,
  ): U;

  /** Read one key (non-reactive). */
  get: (key: string) => V | undefined;
  /** Read all entries (non-reactive). */
  getAll: () => Record<string, V | undefined>;
  /**
   * Batch-set entries. Keys mapped to undefined are deleted.
   * Only listeners for affected keys are notified.
   */
  set: (updates: Record<string, V | undefined>) => void;
  /**
   * Replace the entire store contents. If replace=true, keys not in
   * newState are deleted.
   */
  setAll: (newState: Record<string, V>, replace?: boolean) => void;
  /** Subscribe to changes for a specific key. Returns unsubscribe. */
  subscribe: (key: string, listener: Listener) => () => void;
}

export function createKeyedStore<V>(
  initialEntries?: Record<string, V>,
): KeyedStore<V> {
  const map = new Map<string, V>(
    initialEntries ? Object.entries(initialEntries) : [],
  );
  // Per-key listeners.
  const keyListeners = new Map<string, Set<Listener>>();
  // Per-key version counters (bumped on every change to that key).
  const keyVersions = new Map<string, number>();

  function getVersion(key: string): number {
    return keyVersions.get(key) ?? 0;
  }

  function bumpVersion(key: string): void {
    keyVersions.set(key, getVersion(key) + 1);
  }

  function notifyKey(key: string): void {
    const set = keyListeners.get(key);
    if (set) set.forEach((l) => l());
  }

  function get(key: string): V | undefined {
    return map.get(key);
  }

  function getAll(): Record<string, V | undefined> {
    return Object.fromEntries(map);
  }

  function set(updates: Record<string, V | undefined>): void {
    const changedKeys: string[] = [];

    for (const key of Object.keys(updates)) {
      const value = updates[key];
      if (value === undefined) {
        if (map.has(key)) {
          map.delete(key);
          bumpVersion(key);
          changedKeys.push(key);
        }
      } else {
        const prev = map.get(key);
        if (!Object.is(prev, value)) {
          map.set(key, value);
          bumpVersion(key);
          changedKeys.push(key);
        }
      }
    }

    // Notify only affected keys.
    for (const key of changedKeys) {
      notifyKey(key);
    }
  }

  function setAll(newState: Record<string, V>, replace?: boolean): void {
    const affectedKeys = new Set<string>();

    if (replace) {
      // Mark all existing keys as affected (they may be removed).
      for (const key of map.keys()) {
        affectedKeys.add(key);
      }
      map.clear();
    }

    for (const [key, value] of Object.entries(newState)) {
      map.set(key, value);
      bumpVersion(key);
      affectedKeys.add(key);
    }

    if (replace) {
      // Bump versions for keys that were removed.
      for (const key of affectedKeys) {
        if (!map.has(key)) {
          bumpVersion(key);
        }
      }
    }

    for (const key of affectedKeys) {
      notifyKey(key);
    }
  }

  function subscribeToKey(key: string, listener: Listener): () => void {
    if (!keyListeners.has(key)) {
      keyListeners.set(key, new Set());
    }
    keyListeners.get(key)!.add(listener);
    return () => {
      const s = keyListeners.get(key);
      if (s) {
        s.delete(listener);
        if (s.size === 0) keyListeners.delete(key);
      }
    };
  }

  // The callable hook with overloads.
  function useKeyedStore(key: string): V | undefined;
  function useKeyedStore<U>(
    key: string,
    selector: (val: V | undefined) => U,
    equalityFn?: (a: U, b: U) => boolean,
  ): U;
  function useKeyedStore<U>(
    key: string,
    selector?: (val: V | undefined) => U,
    equalityFn?: (a: U, b: U) => boolean,
  ): V | undefined | U {
    const cache = useRef<{
      value: V | undefined | U;
      version: number;
      key: string;
    }>({ value: undefined, version: -1, key: "" });

    // New subscribe identity when key changes, so useSyncExternalStore
    // re-subscribes to the correct key.
    const subscribe = useCallback(
      (listener: Listener) => subscribeToKey(key, listener),
      [key],
    );

    const value = useSyncExternalStore(subscribe, () => {
      const ver = getVersion(key);
      // If key or version changed, recompute.
      if (cache.current.key !== key || cache.current.version !== ver) {
        const raw = map.get(key);
        const next = selector ? selector(raw) : raw;
        if (cache.current.key === key && cache.current.version !== ver) {
          // Same key, new version -- check equality.
          if (
            equalityFn
              ? equalityFn(cache.current.value as U, next as U)
              : Object.is(cache.current.value, next)
          ) {
            cache.current.version = ver;
            return cache.current.value as V | undefined | U;
          }
        }
        cache.current = { value: next, version: ver, key };
        return next;
      }
      return cache.current.value as V | undefined | U;
    });

    return value;
  }

  useKeyedStore.get = get;
  useKeyedStore.getAll = getAll;
  useKeyedStore.set = set;
  useKeyedStore.setAll = setAll;
  useKeyedStore.subscribe = subscribeToKey;

  return useKeyedStore as KeyedStore<V>;
}
