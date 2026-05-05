import { useFrame } from "@react-three/fiber";
import React from "react";
import * as THREE from "three";

export interface BillboardProps {
  children: React.ReactNode;
  /** Lock rotation on X axis */
  lockX?: boolean;
  /** Lock rotation on Y axis */
  lockY?: boolean;
  /** Lock rotation on Z axis */
  lockZ?: boolean;
  /** Unrotated children. **/
  unrotatedChildren?: React.ReactNode;
}

/**
 * Billboard component that faces the camera.
 * Based on drei's Billboard component.
 */
export const Billboard = React.forwardRef<THREE.Group, BillboardProps>(
  function Billboard(
    {
      children,
      lockX = false,
      lockY = false,
      lockZ = false,
      unrotatedChildren,
    },
    fref,
  ) {
    const inner = React.useRef<THREE.Group>(null!);
    const localRef = React.useRef<THREE.Group>(null!);

    // Reuse objects to avoid allocations.
    const q = React.useRef(new THREE.Quaternion());
    const prevRotation = React.useRef(new THREE.Euler());

    useFrame(({ camera }) => {
      if (!localRef.current || !inner.current) return;

      // Save previous rotation in case we're locking an axis.
      prevRotation.current.copy(inner.current.rotation);

      // Always face the camera (billboard behavior).
      localRef.current.updateMatrix();
      localRef.current.updateWorldMatrix(false, false);
      localRef.current.getWorldQuaternion(q.current);
      camera
        .getWorldQuaternion(inner.current.quaternion)
        .premultiply(q.current.invert());

      // Readjust any axis that is locked.
      if (lockX) inner.current.rotation.x = prevRotation.current.x;
      if (lockY) inner.current.rotation.y = prevRotation.current.y;
      if (lockZ) inner.current.rotation.z = prevRotation.current.z;
    });

    React.useImperativeHandle(fref, () => localRef.current, []);

    return (
      <group ref={localRef}>
        <group ref={inner}>{children}</group>
        {unrotatedChildren}
      </group>
    );
  },
);
