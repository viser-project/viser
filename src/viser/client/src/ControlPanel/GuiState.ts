import React from "react";
import { createStore } from "../store";
import { ColorTranslator } from "colortranslator";

import {
  GuiComponentMessage,
  GuiModalMessage,
  ThemeConfigurationMessage,
} from "../WebsocketMessages";

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
  guiOrderFromUuid: { [id: string]: number };
  guiConfigFromUuid: { [id: string]: GuiComponentMessage | undefined };
  uploadsInProgress: {
    [uuid: string]: {
      notificationId: string;
      uploadedBytes: number;
      totalBytes: number;
      filename: string;
    };
  };
}

export interface GuiActions {
  setTheme: (theme: ThemeConfigurationMessage) => void;
  setShareUrl: (share_url: string | null) => void;
  addGui: (config: GuiComponentMessage) => void;
  addModal: (config: GuiModalMessage) => void;
  removeModal: (id: string) => void;
  updateGuiProps: (id: string, updates: { [key: string]: any }) => void;
  removeGui: (id: string) => void;
  resetGui: () => void;
  updateUploadState: (
    state: (
      | { uploadedBytes: number; totalBytes: number }
      | GuiState["uploadsInProgress"][string]
    ) & { componentId: string },
  ) => void;
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
  guiOrderFromUuid: {},
  guiConfigFromUuid: {},
  uploadsInProgress: {},
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
 * Apply property updates to a GUI component in the given state.
 * Returns a new guiConfigFromUuid with the update applied.
 * Shared by both the per-component updateGuiProps action and the batched
 * GUI update path in MessageHandler.
 */
export function applyGuiPropsUpdate(
  guiConfigFromUuid: { [id: string]: GuiComponentMessage | undefined },
  id: string,
  updates: { [key: string]: any },
): { [id: string]: GuiComponentMessage | undefined } {
  const config = guiConfigFromUuid[id];
  if (config === undefined) {
    console.error(
      `Tried to update non-existent component '${id}' with`,
      updates,
    );
    return guiConfigFromUuid;
  }

  // Build new props with updates applied.
  const newProps = { ...config.props } as any;
  let newConfig = config as any;

  for (const [key, value] of Object.entries(updates)) {
    // We don't put `value` in the props object to make types
    // stronger in the user-facing Python API. This results in some
    // nastiness here, we should revisit...
    if (key === "value") {
      newConfig = { ...newConfig, value };
    } else if (!(key in config.props)) {
      console.error(
        `Tried to update nonexistent property '${key}' of GUI element ${id}!`,
      );
    } else {
      newProps[key] = value;
    }
  }

  if (newConfig !== config) {
    // "value" key was updated -- newConfig is already a new object.
    newConfig = { ...newConfig, props: newProps };
  } else {
    newConfig = { ...config, props: newProps };
  }

  return { ...guiConfigFromUuid, [id]: newConfig };
}

export function useGuiState(initialServer: string) {
  return React.useState(() => {
    const store = createStore<GuiState>({
      ...cleanGuiState,
      server: initialServer,
    });

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
          guiConfigFromUuid: {
            ...state.guiConfigFromUuid,
            [guiConfig.uuid]: guiConfig,
          },
          guiUuidSetFromContainerUuid: {
            ...state.guiUuidSetFromContainerUuid,
            [guiConfig.container_uuid]: {
              ...containerSet,
              [guiConfig.uuid]: true as const,
            },
          },
        });
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
      removeGui: (id) => {
        const state = store.get();
        const guiConfig = state.guiConfigFromUuid[id];
        if (guiConfig == undefined) {
          // TODO: this will currently happen when GUI elements are removed
          // and then a new client connects. Needs to be revisited.
          console.warn("(OK) Tried to remove non-existent component", id);
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _1, ...remainingConfigs } = state.guiConfigFromUuid;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _2, ...remainingOrders } = state.guiOrderFromUuid;
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
          guiConfigFromUuid: remainingConfigs,
          guiOrderFromUuid: remainingOrders,
          guiUuidSetFromContainerUuid: newContainerMap,
        });
      },
      resetGui: () => {
        // No need to overwrite the theme or label. The former especially
        // can be jarring.
        store.set({
          shareUrl: cleanGuiState.shareUrl,
          guiUuidSetFromContainerUuid:
            cleanGuiState.guiUuidSetFromContainerUuid,
          modals: cleanGuiState.modals,
          guiOrderFromUuid: cleanGuiState.guiOrderFromUuid,
          guiConfigFromUuid: cleanGuiState.guiConfigFromUuid,
          uploadsInProgress: cleanGuiState.uploadsInProgress,
        });
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
      updateGuiProps: (id, updates) => {
        const state = store.get();
        store.set({
          guiConfigFromUuid: applyGuiPropsUpdate(
            state.guiConfigFromUuid,
            id,
            updates,
          ),
        });
      },
    };

    return { store, actions };
  })[0];
}

/** Type corresponding to the useGuiState hook return. */
export type UseGui = ReturnType<typeof useGuiState>;
