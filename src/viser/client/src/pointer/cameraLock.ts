import type { CameraControls } from "@react-three/drei";

/**
 * Per-viewer owner for `CameraControls.enabled`.
 *
 * Every camera-disable site gets a lease from this manager instead of
 * writing `cameraControl.enabled` directly. Leases stack and release
 * idempotently; the camera is enabled only when no leases remain.
 */
export class CameraLockManager {
  private readonly reasons = new Map<symbol, string>();

  constructor(private readonly getInstance: () => CameraControls | null) {}

  /** Disable the camera until the returned release function is called. */
  acquire(reason: string): () => void {
    const id = Symbol(reason);
    this.reasons.set(id, reason);
    this.apply();
    return () => {
      if (!this.reasons.has(id)) return;
      this.reasons.delete(id);
      this.apply();
    };
  }

  /** Re-apply the current lease state to the current camera-control instance. */
  apply(): void {
    const instance = this.getInstance();
    if (instance === null) return;
    const next = this.reasons.size === 0;
    if (instance.enabled !== next) instance.enabled = next;
  }

  /** Dev-only inspection: list reason strings for currently-held locks. */
  reasonsForTest(): string[] {
    return Array.from(this.reasons.values());
  }

  /** Reset state for tests / HMR teardown. */
  resetForTest(): void {
    this.reasons.clear();
    this.apply();
  }
}
