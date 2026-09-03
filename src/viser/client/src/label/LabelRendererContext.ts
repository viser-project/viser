/** Context + public types for the label renderer. Kept separate from the
 * LabelRenderer component so importing the context doesn't break fast
 * refresh. */
import React from "react";

export interface LabelConfig {
  /** Scene node name; the label follows this node's world transform. */
  name: string;
  text: string;
  depthTest: boolean;
  fontSizeMode: "screen" | "scene";
  fontScreenScale: number;
  fontSceneHeight: number;
  anchor: string;
}

export interface LabelHandle {
  update(config: LabelConfig): void;
  dispose(): void;
}

export interface LabelRendererApi {
  register(config: LabelConfig): LabelHandle;
}

export const LabelRendererContext =
  React.createContext<LabelRendererApi | null>(null);
