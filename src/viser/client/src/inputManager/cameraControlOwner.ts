/**
 * Camera-control ownership.
 *
 * Single application path for ``CameraControls.enabled``. Every other
 * site in the client routes through this owner instead of writing
 * ``cameraControl.enabled = X`` directly. The owner combines two
 * inputs:
 *
 *   - The current Gesture (set by the InputManager once per
 *     pointerdown / move / up). Drives :func:`deriveCameraControlEnabled`,
 *     which encodes the design doc's behavior table.
 *   - A multiset of leases held by callers that need to disable the
 *     camera outside the gesture lifecycle (modal overlays,
 *     keyboard cinematics, in-flight server overrides, the existing
 *     rect-select / node-drag paths in App.tsx and DragLayer.tsx).
 *     The owner ANDs the gesture-derived bool with "no leases held"
 *     so two concurrent disablers can release independently.
 *
 * The current camera-controls instance is read lazily from a getter
 * passed at construction (typically ``() =>
 * viewerMutable.cameraControl``). This is robust to the camera-type
 * swap (perspective <-> orthographic) without explicit instance
 * tracking: drei rebuilds the underlying ``CameraControls`` and the
 * old instance is disposed, so its ``enabled`` flag is irrelevant.
 * The owner just writes to whatever the getter returns now.
 *
 * For tests that want to drive the owner directly without a real
 * three.js camera, ``setInstanceGetter`` overrides the getter at
 * runtime.
 */

import type { CameraControls } from "@react-three/drei";

import type { Gesture } from "./types";
import { deriveCameraControlEnabled } from "./reducers";

/** A handle returned by :func:`CameraControlOwner.acquireLease`. The
 * caller releases the lease (idempotently) when its ad-hoc disable
 * window is over -- modal closes, drag ends, rect-select committed,
 * etc. */
export interface CameraEnabledLease {
  /** Lease reason; surfaced for debugging. */
  readonly reason: string;
  /** Drop this lease. Idempotent. */
  release(): void;
}

/** Function the owner calls to read the current camera-controls
 * instance. Must return the live instance, or ``null`` if no camera is
 * mounted. The owner re-evaluates this getter on every state
 * application, so a camera-type swap requires no explicit notification:
 * the next ``acquireLease`` / ``setGesture`` call automatically writes
 * to the new instance. */
export type InstanceGetter = () => CameraControls | null;

const IDLE: Gesture = { kind: "idle" };

/**
 * Single writer for ``CameraControls.enabled``. Exactly one instance
 * lives on ``viewerMutable.cameraControlOwner``; constructed by the
 * Root component at viewer mount.
 */
export class CameraControlOwner {
  private gesture: Gesture = IDLE;
  private leases: Set<symbol> = new Set();
  private leaseReasons: Map<symbol, string> = new Map();
  private getInstance: InstanceGetter = () => null;

  /** Override the instance getter. Tests use this to inject a fake
   * controls object; the live viewer wires it up via
   * :func:`bindToViewerMutable`. */
  setInstanceGetter(getter: InstanceGetter): void {
    this.getInstance = getter;
    // Force the next apply through: the new instance has its own
    // ``enabled`` state independent of what we last wrote to the old
    // one. Without this, a swap from a disabled-by-lease old instance
    // to a fresh new one would skip the disable write because
    // ``lastEnabled === false``.
    this.lastEnabled = null;
    this.applyToCurrent();
  }

  /** Set the active gesture. The owner reapplies its derivation to
   * the current instance. ``idle`` is the default; the InputManager
   * calls this on every transition. Until step 5 of the migration the
   * gesture stays at ``idle`` and the owner is lease-only. */
  setGesture(gesture: Gesture): void {
    this.gesture = gesture;
    this.applyToCurrent();
  }

  /** Hold a lease that forces the camera disabled until released.
   * Multiple leases stack: enable returns only when *all* are released
   * AND the gesture-derived state is enabled. ``reason`` is for
   * debugging only -- the owner identifies the lease by symbol so
   * duplicate reasons don't collide. */
  acquireLease(reason: string): CameraEnabledLease {
    const id = Symbol(reason);
    this.leases.add(id);
    this.leaseReasons.set(id, reason);
    this.applyToCurrent();
    let released = false;
    return {
      reason,
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(id);
        this.leaseReasons.delete(id);
        this.applyToCurrent();
      },
    };
  }

  /** True if any lease is currently held. Surface for debugging /
   * tests; not used in the hot path. */
  hasLease(): boolean {
    return this.leases.size > 0;
  }

  /** Reasons for all currently-held leases. For debugging. */
  leaseReasonsList(): string[] {
    return Array.from(this.leaseReasons.values());
  }

  /** Compute the bool that should be written to the current instance.
   * Pure: gesture-derived AND no leases held. */
  private deriveEnabled(): boolean {
    return deriveCameraControlEnabled(this.gesture) && this.leases.size === 0;
  }

  /** Last enabled bool written through ``applyToCurrent``. Tracked so
   * we skip the assignment when the derived state hasn't changed --
   * ``CameraControls.enabled`` is a setter on drei's class and writing
   * the same value still toggles internal listeners. ``null`` until
   * the first apply, and reset on instance-getter swap to force the
   * next apply through. */
  private lastEnabled: boolean | null = null;

  /** Idempotent re-apply. Reads the current instance via the getter
   * and writes the derived enabled bool. ``try``/``catch`` guards
   * against writes to a disposed controls object across a remount. */
  private applyToCurrent(): void {
    const instance = this.getInstance();
    if (instance === null) return;
    const next = this.deriveEnabled();
    if (next === this.lastEnabled) return;
    this.lastEnabled = next;
    try {
      instance.enabled = next;
    } catch {
      /* instance disposed or not yet initialised; ignore. */
    }
  }
}
