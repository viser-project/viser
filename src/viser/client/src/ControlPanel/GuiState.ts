import React from "react";
import { createStore, createKeyedStore } from "../store";
import { ColorTranslator } from "colortranslator";
import { buildPaneToStableKey } from "./panelIdentity";

import {
  GuiComponentMessage,
  GuiModalMessage,
  GuiPanelMessage,
  GuiSetPanelPositionMessage,
  RegisterCommandMessage,
  ThemeConfigurationMessage,
} from "../WebsocketMessages";

/** One placement axis as last written by the server: the value plus the
 * (counter, runId) stamp of the command that wrote it. Counters are comparable
 * only within one runId (one GuiApi instance); across runIds the later ARRIVAL
 * wins. */
export interface PlacementAxis<T> {
  value: T;
  counter: number;
  runId: string;
}

export type PlacementAxisName = "position" | "width" | "height" | "collapsed";

/** Client-owned placement state for a single panel (a standalone panel keyed by
 * its uuid, or the main control panel keyed by CONTROL_PANEL_ID). Each of the
 * four write-only `GuiSetPanel*` messages merges its single axis here; the dock
 * applies each axis INDEPENDENTLY (a set_width can never re-apply a stale
 * position -- the axes carry their own counters). */
export interface PanelPlacementState {
  position?: PlacementAxis<GuiSetPanelPositionMessage["position"]>;
  // null value = override cleared (revert to default/theme width; auto height).
  width?: PlacementAxis<number | null>;
  height?: PlacementAxis<number | null>;
  collapsed?: PlacementAxis<boolean>;
}

/** The (counter, runId) stamp of the last server command APPLIED for one axis
 * of one panel. The dock re-applies an axis only when the stored axis is newer
 * (same run, higher counter) or from a different run/scope. */
export interface AppliedAxisRecord {
  counter: number;
  runId: string;
}
export type AppliedAxes = Partial<Record<PlacementAxisName, AppliedAxisRecord>>;

/** One panel's layout-application tracking (see GuiState.panelLayoutTracking).
 * Named so the store and the placement gate share a single definition. */
export interface PanelLayoutEntry {
  applied: AppliedAxes;
  userTouched: boolean;
}

/** Merge one placement axis into a panel's entry. Same run: keep the higher
 * counter (an out-of-order replay can't regress the axis). Different run: the
 * later arrival wins (counters aren't comparable across runs/scopes). Returns
 * the partial state update for `store.set`. */
function mergePlacement<A extends PlacementAxisName>(
  state: { panelPlacement: { [uuid: string]: PanelPlacementState } },
  uuid: string,
  axis: A,
  axisValue: NonNullable<PanelPlacementState[A]>,
): Partial<{ panelPlacement: { [uuid: string]: PanelPlacementState } }> {
  const prev = state.panelPlacement[uuid];
  const prevAxis = prev?.[axis];
  if (
    prevAxis !== undefined &&
    prevAxis.runId === axisValue.runId &&
    prevAxis.counter >= axisValue.counter
  )
    return {};
  return {
    panelPlacement: {
      ...state.panelPlacement,
      [uuid]: { ...prev, [axis]: axisValue },
    },
  };
}

export interface GuiState {
  theme: ThemeConfigurationMessage;
  label: string;
  server: string;
  shareUrl: string | null;
  websocketState: "connected" | "reconnecting" | "inactive";
  backgroundAvailable: boolean;
  showOrbitOriginTool: boolean;
  guiUuidSetFromContainerUuid: {
    [containerUuid: string]: { [uuid: string]: true } | undefined;
  };
  modals: GuiModalMessage[];
  /** Standalone panels (`server.gui.add_panel()`), keyed by uuid. A dedicated
   * top-level entity (like modals) -- NOT part of the inline GUI tree -- so
   * panels never appear in `guiUuidSetFromContainerUuid`. */
  panels: { [uuid: string]: GuiPanelMessage };
  guiOrderFromUuid: { [id: string]: number };
  /** Set of form UUIDs that currently have unsaved changes. Updated by
   * GuiFormDirtyMessage (adds) and GuiFormSubmitMessage (removes). */
  dirtyFormUuids: { [uuid: string]: true | undefined };
  uploadsInProgress: {
    [uuid: string]: {
      notificationId: string;
      uploadedBytes: number;
      totalBytes: number;
      filename: string;
    };
  };
  /** Registered command palette actions, keyed by UUID. */
  commands: { [uuid: string]: RegisterCommandMessage };
  /** Client-owned placement state, keyed by panel uuid (and CONTROL_PANEL_ID
   * for the main panel). Built up by the four write-only `GuiSetPanel*`
   * messages; the dock applies whatever fields are present. */
  panelPlacement: { [uuid: string]: PanelPlacementState };
  /** Per-panel layout-application tracking, keyed by STABLE KEY (not uuid -- a
   * panel's uuid is random per run; the stable key is derived from its tab
   * labels + creation order). Deliberately SURVIVES `resetGui`, so a reconnect
   * or program re-run can decide -- per panel, per AXIS -- whether to re-apply
   * server placement: an axis is re-applied to a user-touched panel only when
   * its (counter, runId) stamp is newer than the last applied (same run, higher
   * counter) or from a different run/scope. Entries for stable keys no longer
   * present are pruned as the layout settles (and immediately when the server
   * removes a panel). */
  panelLayoutTracking: {
    [stableKey: string]: PanelLayoutEntry;
  };
  /** Bumped by `resetPanelLayout` to force the dock to re-apply server placement
   * for every panel from scratch (the placement effects watch it and clear their
   * per-panel applied-key). Paired with clearing `panelLayoutTracking` so the
   * counter/dirty-bit gate lets every panel re-seed. */
  layoutResetNonce: number;
}

export interface GuiActions {
  setTheme: (theme: ThemeConfigurationMessage) => void;
  setShareUrl: (share_url: string | null) => void;
  addGui: (config: GuiComponentMessage) => void;
  addModal: (config: GuiModalMessage) => void;
  removeModal: (id: string) => void;
  addPanel: (config: GuiPanelMessage) => void;
  updatePanel: (id: string, updates: { [key: string]: any }) => void;
  removePanel: (id: string) => void;
  updateGuiProps: (id: string, updates: { [key: string]: any }) => void;
  removeGui: (id: string) => void;
  resetGui: () => void;
  updateUploadState: (
    state: (
      | { uploadedBytes: number; totalBytes: number }
      | GuiState["uploadsInProgress"][string]
    ) & { componentId: string },
  ) => void;
  setFormDirty: (uuid: string) => void;
  clearFormDirty: (uuid: string) => void;
  addCommand: (command: RegisterCommandMessage) => void;
  updateCommand: (uuid: string, updates: { [key: string]: any }) => void;
  removeCommand: (uuid: string) => void;
  setPanelPosition: (
    uuid: string,
    position: GuiSetPanelPositionMessage["position"],
    counter: number,
    runId: string,
  ) => void;
  setPanelWidth: (
    uuid: string,
    width: number | null,
    counter: number,
    runId: string,
  ) => void;
  setPanelHeight: (
    uuid: string,
    height: number | null,
    counter: number,
    runId: string,
  ) => void;
  setPanelCollapsed: (
    uuid: string,
    collapsed: boolean,
    counter: number,
    runId: string,
  ) => void;
  /** Record which placement axes (with their counter/runId stamps) have been
   * applied for the panel with this stable key, so a replay of the same
   * commands is ignored while a genuinely newer command still applies. */
  recordPanelLayoutApplied: (stableKey: string, applied: AppliedAxes) => void;
  /** Mark the panel with this stable key as user-moved, so server placement is
   * no longer auto-applied unless its counter increments. */
  markPanelUserTouched: (stableKey: string) => void;
  /** Drop tracking entries whose stable key is not in `activeKeys` (panels that
   * no longer exist), so a removed panel's state can't be inherited by a later
   * panel that happens to resolve to the same stable key. */
  pruneLayoutTracking: (activeKeys: ReadonlySet<string>) => void;
  /** Discard all user rearrangement: clear the touched/applied tracking and bump
   * `layoutResetNonce` so the dock re-applies every panel's server placement. */
  resetPanelLayout: () => void;
}

const searchParams = new URLSearchParams(window.location.search);
const hideViserLogo = searchParams.get("hideViserLogo") !== null;
const cleanGuiState: GuiState = {
  theme: {
    type: "ThemeConfigurationMessage",
    titlebar_content: null,
    control_layout: "floating",
    control_width: "medium",
    dark_mode: false,
    show_logo: !hideViserLogo,
    show_share_button: true,
    colors: null,
  },
  label: "",
  server: "ws://localhost:8080", // Currently this will always be overridden.
  shareUrl: null,
  websocketState: "inactive",
  backgroundAvailable: false,
  showOrbitOriginTool: false,
  guiUuidSetFromContainerUuid: { root: {} },
  modals: [],
  panels: {},
  guiOrderFromUuid: {},
  dirtyFormUuids: {},
  uploadsInProgress: {},
  commands: {},
  panelPlacement: {},
  panelLayoutTracking: {},
  layoutResetNonce: 0,
};

export function computeRelativeLuminance(color: string) {
  const colorTrans = new ColorTranslator(color);

  // Coefficients are from:
  // https://en.wikipedia.org/wiki/Relative_luminance#Relative_luminance_and_%22gamma_encoded%22_colorspaces
  return (
    ((0.2126 * colorTrans.R + 0.7152 * colorTrans.G + 0.0722 * colorTrans.B) /
      255.0) *
    100.0
  );
}

/**
 * Apply property updates to a GUI component.
 * Returns a new config with the updates applied, or the same config
 * reference if nothing actually changed.
 */
export function applyGuiConfigUpdate(
  config: GuiComponentMessage,
  updates: { [key: string]: any },
): GuiComponentMessage {
  let propsChanged = false;
  let valueChanged = false;

  for (const [key, value] of Object.entries(updates)) {
    if (key === "value") {
      const current = "value" in config ? config.value : undefined;
      if (!Object.is(current, value)) valueChanged = true;
    } else if (!(key in config.props)) {
      console.error(
        `Tried to update nonexistent property '${key}' of GUI element!`,
      );
    } else {
      if (!Object.is((config.props as Record<string, unknown>)[key], value))
        propsChanged = true;
    }
  }

  if (!propsChanged && !valueChanged) return config;

  let newConfig: any = config;
  if (valueChanged) {
    newConfig = { ...newConfig, value: updates.value };
  }
  if (propsChanged) {
    const newProps = { ...config.props } as Record<string, unknown>;
    for (const [key, value] of Object.entries(updates)) {
      if (key !== "value" && key in config.props) {
        newProps[key] = value;
      }
    }
    newConfig = { ...newConfig, props: newProps };
  }

  return newConfig;
}

export function useGuiState(initialServer: string) {
  return React.useState(() => {
    const store = createStore<GuiState>({
      ...cleanGuiState,
      server: initialServer,
    });

    // Per-component config store, keyed by UUID.
    const configStore = createKeyedStore<GuiComponentMessage>();

    // One setter per placement axis, differing only in the axis name: the
    // factory keeps the (value, counter, runId) -> mergePlacement wiring in a
    // single place, fully typed per axis.
    const setPanelAxis =
      <A extends PlacementAxisName>(axis: A) =>
      (
        uuid: string,
        value: NonNullable<PanelPlacementState[A]>["value"],
        counter: number,
        runId: string,
      ) =>
        store.set((state) =>
          mergePlacement(state, uuid, axis, {
            value,
            counter,
            runId,
          } as NonNullable<PanelPlacementState[A]>),
        );

    const actions: GuiActions = {
      setTheme: (theme) => store.set({ theme }),
      setShareUrl: (shareUrl) => store.set({ shareUrl }),
      addGui: (guiConfig) => {
        const state = store.get();
        const containerSet =
          state.guiUuidSetFromContainerUuid[guiConfig.container_uuid] ?? {};
        store.set({
          guiOrderFromUuid: {
            ...state.guiOrderFromUuid,
            [guiConfig.uuid]: guiConfig.props.order,
          },
          guiUuidSetFromContainerUuid: {
            ...state.guiUuidSetFromContainerUuid,
            [guiConfig.container_uuid]: {
              ...containerSet,
              [guiConfig.uuid]: true as const,
            },
          },
        });
        configStore.set({ [guiConfig.uuid]: guiConfig });
      },
      addModal: (modalConfig) => {
        store.set((state) => ({
          modals: [...state.modals, modalConfig],
        }));
      },
      removeModal: (id) => {
        store.set((state) => ({
          modals: state.modals.filter((m) => m.uuid !== id),
        }));
      },
      addPanel: (config) => {
        store.set((state) => ({
          panels: { ...state.panels, [config.uuid]: config },
        }));
      },
      updatePanel: (id, updates) => {
        store.set((state) => {
          const panel = state.panels[id];
          if (panel === undefined) {
            console.error(`Tried to update non-existent panel '${id}'`, updates);
            return {};
          }
          return {
            panels: {
              ...state.panels,
              [id]: { ...panel, props: { ...panel.props, ...updates } },
            },
          };
        });
      },
      removePanel: (id) => {
        store.set((state) => {
          if (state.panels[id] === undefined) return {};
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [id]: _removed, ...rest } = state.panels;
          // Drop its client-owned placement entry too (avoid a leak).
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [id]: _placement, ...restPlacement } = state.panelPlacement;
          // A server-REMOVED panel's layout tracking is pruned immediately (by
          // the stable key computed from the pre-removal panel set): a later
          // panel that resolves to the same stable key is a NEW panel and must
          // not inherit this one's userTouched/applied state. (Reconnect goes
          // through resetGui, which deliberately KEEPS tracking -- that's the
          // "same panel, remembered arrangement" path.)
          const stableKey = buildPaneToStableKey(state.panels).get(id);
          let tracking = state.panelLayoutTracking;
          if (stableKey !== undefined && stableKey in tracking) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [stableKey]: _tracked, ...restTracking } = tracking;
            tracking = restTracking;
          }
          return {
            panels: rest,
            panelPlacement: restPlacement,
            panelLayoutTracking: tracking,
          };
        });
      },
      removeGui: (id) => {
        const guiConfig = configStore.get(id);
        if (guiConfig == undefined) {
          // TODO: this will currently happen when GUI elements are removed
          // and then a new client connects. Needs to be revisited.
          console.warn("(OK) Tried to remove non-existent component", id);
          return;
        }
        const state = store.get();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _2, ...remainingOrders } = state.guiOrderFromUuid;
        const dirtyFormUuids = { ...state.dirtyFormUuids };
        delete dirtyFormUuids[id];
        const containerUuid = guiConfig.container_uuid;
        const containerSet = {
          ...state.guiUuidSetFromContainerUuid[containerUuid],
        };
        delete containerSet[id];
        const newContainerMap = {
          ...state.guiUuidSetFromContainerUuid,
        };
        if (Object.keys(containerSet).length === 0) {
          delete newContainerMap[containerUuid];
        } else {
          newContainerMap[containerUuid] = containerSet;
        }
        store.set({
          guiOrderFromUuid: remainingOrders,
          dirtyFormUuids,
          guiUuidSetFromContainerUuid: newContainerMap,
        });
        configStore.set({ [id]: undefined });
      },
      resetGui: () => {
        // No need to overwrite the theme or label. The former especially
        // can be jarring.
        store.set({
          shareUrl: cleanGuiState.shareUrl,
          guiUuidSetFromContainerUuid:
            cleanGuiState.guiUuidSetFromContainerUuid,
          modals: cleanGuiState.modals,
          panels: cleanGuiState.panels,
          guiOrderFromUuid: cleanGuiState.guiOrderFromUuid,
          dirtyFormUuids: cleanGuiState.dirtyFormUuids,
          uploadsInProgress: cleanGuiState.uploadsInProgress,
          commands: cleanGuiState.commands,
          panelPlacement: cleanGuiState.panelPlacement,
        });
        configStore.setAll({}, true);
      },
      updateUploadState: (uploadState) => {
        const state = store.get();
        const { componentId, ...rest } = uploadState;
        store.set({
          uploadsInProgress: {
            ...state.uploadsInProgress,
            [componentId]: {
              ...state.uploadsInProgress[componentId],
              ...rest,
            },
          },
        });
      },
      setFormDirty: (uuid) => {
        store.set((state) => ({
          dirtyFormUuids: { ...state.dirtyFormUuids, [uuid]: true },
        }));
      },
      clearFormDirty: (uuid) => {
        store.set((state) => {
          const next = { ...state.dirtyFormUuids };
          delete next[uuid];
          return { dirtyFormUuids: next };
        });
      },
      addCommand: (command) => {
        store.set((state) => {
          // Skip if an identical command is already registered (e.g. server
          // reconnect replaying RegisterCommandMessage for every existing
          // command). Prevents churning the whole subscriber set.
          if (Object.is(state.commands[command.uuid], command)) return state;
          return { commands: { ...state.commands, [command.uuid]: command } };
        });
      },
      updateCommand: (uuid, updates) => {
        store.set((state) => {
          const existing = state.commands[uuid];
          if (existing === undefined) return state;
          const existingProps = existing.props as Record<string, unknown>;
          const changed = Object.entries(updates).some(
            ([k, v]) => !Object.is(existingProps[k], v),
          );
          if (!changed) return state;
          const merged: RegisterCommandMessage = {
            ...existing,
            props: { ...existing.props, ...updates },
          };
          return { commands: { ...state.commands, [uuid]: merged } };
        });
      },
      removeCommand: (uuid) => {
        store.set((state) => {
          if (!(uuid in state.commands)) return state;
          const next = { ...state.commands };
          delete next[uuid];
          return { commands: next };
        });
      },
      // The four write-only GuiSetPanel* messages each merge their single AXIS
      // here, with the sending command's (counter, runId) stamp. One factory,
      // one axis apiece.
      setPanelPosition: setPanelAxis("position"),
      setPanelWidth: setPanelAxis("width"),
      setPanelHeight: setPanelAxis("height"),
      setPanelCollapsed: setPanelAxis("collapsed"),
      recordPanelLayoutApplied: (stableKey, applied) => {
        store.set((state) => {
          const prev = state.panelLayoutTracking[stableKey];
          // No-op when every stamp is already recorded: record runs on every
          // placement application, and an identical write would churn a new
          // tracking object through every subscriber for nothing.
          if (
            prev !== undefined &&
            Object.entries(applied).every(([axis, stamp]) => {
              const cur = prev.applied[axis as PlacementAxisName];
              return (
                cur !== undefined &&
                cur.counter === stamp.counter &&
                cur.runId === stamp.runId
              );
            })
          )
            return {};
          return {
            panelLayoutTracking: {
              ...state.panelLayoutTracking,
              [stableKey]: {
                applied: { ...prev?.applied, ...applied },
                userTouched: prev?.userTouched ?? false,
              },
            },
          };
        });
      },
      markPanelUserTouched: (stableKey) => {
        store.set((state) => {
          const prev = state.panelLayoutTracking[stableKey];
          if (prev?.userTouched === true) return {};
          return {
            panelLayoutTracking: {
              ...state.panelLayoutTracking,
              [stableKey]: {
                applied: prev?.applied ?? {},
                userTouched: true,
              },
            },
          };
        });
      },
      pruneLayoutTracking: (activeKeys) => {
        store.set((state) => {
          const entries = Object.entries(state.panelLayoutTracking).filter(
            ([key]) => activeKeys.has(key),
          );
          if (entries.length === Object.keys(state.panelLayoutTracking).length)
            return {}; // nothing to prune.
          return { panelLayoutTracking: Object.fromEntries(entries) };
        });
      },
      resetPanelLayout: () => {
        store.set((state) => ({
          panelLayoutTracking: {},
          layoutResetNonce: state.layoutResetNonce + 1,
        }));
      },
      updateGuiProps: (id, updates) => {
        const config = configStore.get(id);
        if (config === undefined) {
          console.error(
            `Tried to update non-existent component '${id}' with`,
            updates,
          );
          return;
        }
        const newConfig = applyGuiConfigUpdate(config, updates);
        if (newConfig !== config) {
          configStore.set({ [id]: newConfig });
        }
      },
    };

    return { store, configStore, actions };
  })[0];
}

/** Type corresponding to the useGuiState hook return. */
export type UseGui = ReturnType<typeof useGuiState>;
