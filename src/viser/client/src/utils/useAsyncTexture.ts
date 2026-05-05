import React from "react";
import * as THREE from "three";

/** Load image data as a Three.js texture, with proper cancellation and disposal. */
export function useAsyncTexture(
  format: string | null,
  data: BlobPart | null,
): THREE.Texture | undefined {
  const [texture, setTexture] = React.useState<THREE.Texture>();

  React.useEffect(() => {
    let cancelled = false;
    if (format !== null && data !== null) {
      const url = URL.createObjectURL(
        new Blob([data], { type: "image/" + format }),
      );
      new THREE.TextureLoader().load(url, (tex) => {
        if (!cancelled) setTexture(tex);
        else tex.dispose();
        URL.revokeObjectURL(url);
      });
    } else {
      setTexture(undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [format, data]);

  // Dispose previous texture when it changes, and current texture on unmount.
  React.useEffect(() => {
    return () => {
      if (texture) texture.dispose();
    };
  }, [texture]);

  return texture;
}
