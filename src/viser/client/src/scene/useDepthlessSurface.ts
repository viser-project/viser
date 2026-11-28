import React from "react";
import { ViewerContext } from "../ViewerContext";

/** Declare that a component draws a transparent surface that doesn't write depth.
 * See `AutoInstancer.addDepthlessSurface()`. */
export function useDepthlessSurface(active: boolean): void {
  const { autoInstancer } = React.useContext(ViewerContext)!;
  React.useLayoutEffect(() => {
    if (active) return autoInstancer.addDepthlessSurface();
  }, [autoInstancer, active]);
}
