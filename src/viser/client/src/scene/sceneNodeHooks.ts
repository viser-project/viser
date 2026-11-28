import React from "react";
import { HoverableContext } from "../HoverContext";
import { ViewerContext } from "../ViewerContext";

/** Declare whether a component has something that needs to be drawn, which isn't
 * already accounted for by its scene node. See SceneNodeGraph. */
export function useDrawable(active: boolean): void {
  const { sceneNodeGraph } = React.useContext(ViewerContext)!;
  const name = React.useContext(HoverableContext)?.nodeName;
  React.useLayoutEffect(() => {
    if (!active || name === undefined) return;
    return sceneNodeGraph.addDrawable(name);
  }, [active, name, sceneNodeGraph]);
}

/** Should be used by components that add objects to a scene node, after it has
 * been mounted. See SceneNodeGraph. */
export function useMarkTransformsDirty(deps: React.DependencyList): void {
  const { sceneNodeGraph } = React.useContext(ViewerContext)!;
  const name = React.useContext(HoverableContext)?.nodeName;
  React.useLayoutEffect(() => {
    if (name !== undefined) sceneNodeGraph.markTransformsDirty(name);
  }, [sceneNodeGraph, name, ...deps]);
}

/** Declare whether a component draws a transparent surface.
 * See `AutoInstancer.addTransparentSurface()`. */
export function useTransparentSurface(active: boolean): void {
  const { autoInstancer } = React.useContext(ViewerContext)!;
  React.useLayoutEffect(() => {
    if (active) return autoInstancer.addTransparentSurface();
  }, [autoInstancer, active]);
}
