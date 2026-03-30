import React from "react";
import { createStore, createKeyedStore } from "../store";
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
      if (!Object.is((config as any).value, value)) valueChanged = true;
    } else if (!(key in config.props)) {
      console.error(
        `Tried to update nonexistent property '${key}' of GUI element!`,
      );
    } else {
      if (!Object.is((config.props as any)[key], value)) propsChanged = true;
    }
  }

  if (!propsChanged && !valueChanged) return config;

  let newConfig: any = config;
  if (valueChanged) {
    newConfig = { ...newConfig, value: updates.value };
  }
  if (propsChanged) {
    const newProps = { ...config.props } as any;
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
      removeGui: (id) => {
        const guiConfig = configStore.get(id);
        if (guiConfig == undefined) {
          // TODO: this will currently happen when GUI elements are removed
          // and then a new client connects. Needs to be revisited.
          console.warn("(OK) Tried to remove non-existent component", id);
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [id]: _2, ...remainingOrders } = store.get().guiOrderFromUuid;
        const containerUuid = guiConfig.container_uuid;
        const containerSet = {
          ...store.get().guiUuidSetFromContainerUuid[containerUuid],
        };
        delete containerSet[id];
        const newContainerMap = {
          ...store.get().guiUuidSetFromContainerUuid,
        };
        if (Object.keys(containerSet).length === 0) {
          delete newContainerMap[containerUuid];
        } else {
          newContainerMap[containerUuid] = containerSet;
        }
        store.set({
          guiOrderFromUuid: remainingOrders,
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
          guiOrderFromUuid: cleanGuiState.guiOrderFromUuid,
          uploadsInProgress: cleanGuiState.uploadsInProgress,
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
