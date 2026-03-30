import React from "react";
import { ColorTranslator } from "colortranslator";
import {
  GuiComponentMessage,
  GuiModalMessage,
  ThemeConfigurationMessage,
} from "../WebsocketMessages";
import { createStore } from "../utils/store";

interface GuiState {
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

interface GuiActions {
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
 * Apply property updates to a GUI component and return updated state.
 */
export function withGuiPropsUpdate<T extends GuiState>(
  state: T,
  id: string,
  updates: { [key: string]: any },
): T {
  const config = state.guiConfigFromUuid[id];
  if (config === undefined) {
    console.error(
      `Tried to update non-existent component '${id}' with`,
      updates,
    );
    return state;
  }

  let nextConfig = config;
  let nextProps = config.props;
  let hasChanged = false;

  // Iterate over key/value pairs.
  for (const [key, value] of Object.entries(updates)) {
    // We don't put `value` in the props object to make types
    // stronger in the user-facing Python API. This results in some
    // nastiness here, we should revisit...
    if (key === "value") {
      if ((nextConfig as any).value !== value) {
        nextConfig = { ...nextConfig, value } as typeof nextConfig;
        hasChanged = true;
      }
    } else if (!(key in config.props)) {
      console.error(
        `Tried to update nonexistent property '${key}' of GUI element ${id}!`,
      );
    } else {
      if ((nextProps as any)[key] !== value) {
        nextProps = { ...nextProps, [key]: value };
        hasChanged = true;
      }
    }
  }

  if (!hasChanged) return state;
  if (nextProps !== config.props) {
    nextConfig = { ...nextConfig, props: nextProps } as typeof config;
  }
  return {
    ...state,
    guiConfigFromUuid: {
      ...state.guiConfigFromUuid,
      [id]: nextConfig,
    },
  } as T;
}

export function useGuiState(initialServer: string) {
  return React.useState(() => {
    const initialState: GuiState & GuiActions = {
      ...cleanGuiState,
      server: initialServer,
      setTheme: (theme) => useGuiStore.set({ theme }),
      setShareUrl: (share_url) => useGuiStore.set({ shareUrl: share_url }),
      addGui: (guiConfig) =>
        useGuiStore.set((state) => ({
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
              ...(state.guiUuidSetFromContainerUuid[guiConfig.container_uuid] ??
                {}),
              [guiConfig.uuid]: true,
            },
          },
        })),
      addModal: (modalConfig) =>
        useGuiStore.set((state) => ({
          modals: [...state.modals, modalConfig],
        })),
      removeModal: (id) =>
        useGuiStore.set((state) => ({
          modals: state.modals.filter((m) => m.uuid !== id),
        })),
      removeGui: (id) =>
        useGuiStore.set((state) => {
          const guiConfig = state.guiConfigFromUuid[id];
          if (guiConfig == undefined) {
            console.warn("(OK) Tried to remove non-existent component", id);
            return {};
          }

          const nextGuiUuidSet = {
            ...(state.guiUuidSetFromContainerUuid[guiConfig.container_uuid] ??
              {}),
          };
          delete nextGuiUuidSet[id];

          const nextContainerMap = {
            ...state.guiUuidSetFromContainerUuid,
          };
          if (Object.keys(nextGuiUuidSet).length === 0) {
            delete nextContainerMap[guiConfig.container_uuid];
          } else {
            nextContainerMap[guiConfig.container_uuid] = nextGuiUuidSet;
          }

          const nextGuiOrderFromUuid = { ...state.guiOrderFromUuid };
          delete nextGuiOrderFromUuid[id];

          const nextGuiConfigFromUuid = { ...state.guiConfigFromUuid };
          delete nextGuiConfigFromUuid[id];

          return {
            guiUuidSetFromContainerUuid: nextContainerMap,
            guiOrderFromUuid: nextGuiOrderFromUuid,
            guiConfigFromUuid: nextGuiConfigFromUuid,
          };
        }),
      resetGui: () =>
        useGuiStore.set({
          shareUrl: cleanGuiState.shareUrl,
          guiUuidSetFromContainerUuid: cleanGuiState.guiUuidSetFromContainerUuid,
          modals: cleanGuiState.modals,
          guiOrderFromUuid: cleanGuiState.guiOrderFromUuid,
          guiConfigFromUuid: cleanGuiState.guiConfigFromUuid,
          uploadsInProgress: cleanGuiState.uploadsInProgress,
        }),
      updateUploadState: (state) =>
        useGuiStore.set((globalState) => {
          const { componentId, ...rest } = state;
          return {
            uploadsInProgress: {
              ...globalState.uploadsInProgress,
              [componentId]: {
                ...globalState.uploadsInProgress[componentId],
                ...rest,
              },
            },
          };
        }),
      updateGuiProps: (id, updates) => {
        useGuiStore.set((state) => withGuiPropsUpdate(state, id, updates));
      },
    };
    const useGuiStore = createStore<GuiState & GuiActions>(initialState);
    return useGuiStore;
  })[0];
}

/** Type corresponding to a zustand-style useGuiState hook. */
export type UseGui = ReturnType<typeof useGuiState>;
