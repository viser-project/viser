import React from "react";
// @ts-ignore - troika-three-text doesn't have type definitions
import { Text as TroikaText } from "troika-three-text";

/**
 * Context for accessing the global batched label manager.
 */
export interface BatchedLabelManagerContextValue {
  registerText: (
    text: TroikaText,
    nodeName: string,
    depthTest: boolean,
    fontSizeMode: "screen" | "scene",
    fontScreenScale: number,
    fontSceneHeight: number,
    anchorX: "left" | "center" | "right",
    anchorY: "top" | "middle" | "bottom",
  ) => void;
  unregisterText: (text: TroikaText) => void;
  updateText: (
    text: TroikaText,
    depthTest: boolean,
    fontSizeMode: "screen" | "scene",
    fontScreenScale: number,
    fontSceneHeight: number,
    anchorX: "left" | "center" | "right",
    anchorY: "top" | "middle" | "bottom",
  ) => void;
  syncBatchedText: () => void;
  syncText: (text: TroikaText) => void;
}

export const BatchedLabelManagerContext =
  React.createContext<BatchedLabelManagerContextValue | null>(null);
