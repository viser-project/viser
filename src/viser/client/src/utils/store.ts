import React from "react";

type EqualityFn<T> = (a: T, b: T) => boolean;

export type StoreHook<T> = {
  (): T;
  <U>(selector: (state: T) => U, eq?: EqualityFn<U>): U;
  get(): T;
  set(partial: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
};

export type KeyedStoreHook<V> = {
  (key: string): V | undefined;
  <U>(key: string, selector: (val: V | undefined) => U, eq?: EqualityFn<U>): U;
  get(key: string): V | undefined;
  getAll(): Record<string, V | undefined>;
  set(updates: Record<string, V | undefined>): void;
  setAll(state: Record<string, V | undefined>, replace?: boolean): void;
  subscribe(key: string, listener: () => void): () => void;
};

const identity = <T,>(value: T) => value;

export function createStore<T extends object>(initial: T): StoreHook<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  const get = () => state;

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const set = (partial: Partial<T> | ((prev: T) => Partial<T>)) => {
    const updates = typeof partial === "function" ? partial(state) : partial;
    const updateKeys = Object.keys(updates);
    if (updateKeys.length === 0) return;

    let hasChanged = false;
    for (const key of updateKeys) {
      const typedKey = key as keyof T;
      if (!Object.is(state[typedKey], updates[typedKey])) {
        hasChanged = true;
        break;
      }
    }
    if (!hasChanged) return;

    state = { ...state, ...updates };
    listeners.forEach((listener) => {
      listener();
    });
  };

  function useStore(): T;
  function useStore<U>(selector: (state: T) => U, eq?: EqualityFn<U>): U;
  function useStore<U>(
    selector?: (state: T) => U,
    eq: EqualityFn<U> = Object.is,
  ) {
    const selectorRef = React.useRef(selector ?? (identity as (state: T) => U));
    selectorRef.current = selector ?? (identity as (state: T) => U);

    const eqRef = React.useRef(eq);
    eqRef.current = eq;

    const [, forceRender] = React.useReducer((value) => value + 1, 0);
    const selectedRef = React.useRef(selectorRef.current(state));

    const selected = selectorRef.current(state);
    if (!eqRef.current(selectedRef.current, selected)) {
      selectedRef.current = selected;
    }

    React.useEffect(() => {
      return subscribe(() => {
        const nextSelected = selectorRef.current(state);
        if (!eqRef.current(selectedRef.current, nextSelected)) {
          selectedRef.current = nextSelected;
          forceRender();
        }
      });
    }, []);

    return selectedRef.current;
  }

  return Object.assign(useStore, { get, set, subscribe });
}

export function createKeyedStore<V>(
  initial: Record<string, V>,
): KeyedStoreHook<V> {
  let state: Record<string, V | undefined> = { ...initial };
  const listenersByKey = new Map<string, Set<() => void>>();

  const get = (key: string) => state[key];
  const getAll = () => state;

  const subscribe = (key: string, listener: () => void) => {
    let listeners = listenersByKey.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      listenersByKey.set(key, listeners);
    }
    listeners.add(listener);

    return () => {
      const currentListeners = listenersByKey.get(key);
      if (currentListeners === undefined) return;
      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        listenersByKey.delete(key);
      }
    };
  };

  const notifyKeys = (changedKeys: string[]) => {
    changedKeys.forEach((key) => {
      listenersByKey.get(key)?.forEach((listener) => {
        listener();
      });
    });
  };

  const set = (updates: Record<string, V | undefined>) => {
    const changedKeys: string[] = [];
    let nextState = state;

    for (const [key, value] of Object.entries(updates)) {
      if (Object.is(state[key], value)) continue;
      if (nextState === state) {
        nextState = { ...state };
      }
      nextState[key] = value;
      changedKeys.push(key);
    }

    if (changedKeys.length === 0) return;

    state = nextState;
    notifyKeys(changedKeys);
  };

  const setAll = (
    nextState: Record<string, V | undefined>,
    replace: boolean = false,
  ) => {
    if (!replace) {
      set(nextState);
      return;
    }

    const changedKeys = new Set<string>([
      ...Object.keys(state),
      ...Object.keys(nextState),
    ]);

    const changedEntries = [...changedKeys].filter(
      (key) => !Object.is(state[key], nextState[key]),
    );
    if (changedEntries.length === 0) return;

    state = { ...nextState };
    notifyKeys(changedEntries);
  };

  function useKeyedStore(key: string): V | undefined;
  function useKeyedStore<U>(
    key: string,
    selector: (val: V | undefined) => U,
    eq?: EqualityFn<U>,
  ): U;
  function useKeyedStore<U>(
    key: string,
    selector?: (val: V | undefined) => U,
    eq: EqualityFn<U> = Object.is,
  ) {
    const selectorRef = React.useRef(
      selector ?? (identity as (value: V | undefined) => U),
    );
    selectorRef.current = selector ?? (identity as (value: V | undefined) => U);

    const eqRef = React.useRef(eq);
    eqRef.current = eq;

    const [, forceRender] = React.useReducer((value) => value + 1, 0);
    const selectedRef = React.useRef(selectorRef.current(get(key)));

    const selected = selectorRef.current(get(key));
    if (!eqRef.current(selectedRef.current, selected)) {
      selectedRef.current = selected;
    }

    React.useEffect(() => {
      return subscribe(key, () => {
        const nextSelected = selectorRef.current(get(key));
        if (!eqRef.current(selectedRef.current, nextSelected)) {
          selectedRef.current = nextSelected;
          forceRender();
        }
      });
    }, [key]);

    return selectedRef.current;
  }

  return Object.assign(useKeyedStore, {
    get,
    getAll,
    set,
    setAll,
    subscribe,
  });
}
