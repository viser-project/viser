"""E2E tests for the CameraControlOwner adapter.

Asserts that a single writer for ``cameraControl.enabled`` produces
correct enable/disable behavior across:

  - Plain leases (acquired + released).
  - Concurrent leases (rect-select while a node-drag is active).
  - Camera-type swap mid-lease (the previous instance gets re-enabled,
    the new instance picks up the lease-derived disabled state).

The owner lives at ``window.__viserMutable.cameraControlOwner``; the
viewer canvas mounts it via the ``CameraControls`` ref callback.

These tests do NOT exercise the InputManager wiring (steps 4+); they
verify just the ownership primitive that App.tsx and DragLayer.tsx
now route through.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser


def test_lease_disables_camera_releases_re_enables(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A single lease drives ``cameraControl.enabled`` to false; release
    flips it back to true."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cameraControlOwner;
            const initial = window.__viserMutable.cameraControl.enabled;
            const lease = owner.acquireLease("test");
            const duringLease = window.__viserMutable.cameraControl.enabled;
            lease.release();
            const afterRelease = window.__viserMutable.cameraControl.enabled;
            return { initial, duringLease, afterRelease };
        }
        """
    )
    assert out == {"initial": True, "duringLease": False, "afterRelease": True}


def test_lease_release_is_idempotent(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Multiple ``release()`` calls on the same lease behave like one;
    the second should not flip a separately-held lease's state."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cameraControlOwner;
            const lease = owner.acquireLease("test");
            lease.release();
            lease.release();
            const firstReleaseEnabled =
                window.__viserMutable.cameraControl.enabled;
            // Acquire a fresh lease, release the (already-released)
            // first one, ensure the fresh lease's state survives.
            const lease2 = owner.acquireLease("test2");
            lease.release();
            const stillDisabled = window.__viserMutable.cameraControl.enabled;
            lease2.release();
            const finalEnabled = window.__viserMutable.cameraControl.enabled;
            return { firstReleaseEnabled, stillDisabled, finalEnabled };
        }
        """
    )
    assert out == {
        "firstReleaseEnabled": True,
        "stillDisabled": False,
        "finalEnabled": True,
    }


def test_concurrent_leases_stack(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Two simultaneous leases (rect-select + node-drag) keep the
    camera disabled until both are released. Releasing only one keeps
    the other's hold in effect."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cameraControlOwner;
            const a = owner.acquireLease("rect-select");
            const b = owner.acquireLease("node-drag");
            const both = window.__viserMutable.cameraControl.enabled;
            a.release();
            const onlyB = window.__viserMutable.cameraControl.enabled;
            b.release();
            const none = window.__viserMutable.cameraControl.enabled;
            return { both, onlyB, none };
        }
        """
    )
    assert out == {"both": False, "onlyB": False, "none": True}


def test_swap_applies_lease_state_to_new_instance(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The owner reads its current instance through a getter, so a
    camera-type swap (perspective <-> orthographic) is observed
    automatically: a lease acquired before the swap continues to
    drive ``enabled=false`` against the new instance, and a release
    after the swap flips the new instance back to enabled.

    Old instances get disposed by drei on type swap, so leaking their
    ``enabled`` flag is harmless and the owner does not track them."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cameraControlOwner;
            const real = window.__viserMutable.cameraControl;

            // Hold a lease before the simulated swap.
            const lease = owner.acquireLease("test");
            const realDisabled = real.enabled;

            // Swap: install a fake instance via the getter override
            // (mirrors what drei does internally on camera-type swap).
            const fake = { enabled: true };
            owner.setInstanceGetter(() => fake);

            // The owner reapplies on getter swap: fake should now be
            // disabled because the lease is still held.
            const fakeDisabled = fake.enabled;

            // Drop the lease; fake should become enabled.
            lease.release();
            const fakeReEnabled = fake.enabled;

            // Restore the real getter so subsequent tests see the
            // live viewer.
            owner.setInstanceGetter(
                () => window.__viserMutable.cameraControl,
            );
            return { realDisabled, fakeDisabled, fakeReEnabled };
        }
        """
    )
    assert out == {
        "realDisabled": False,
        "fakeDisabled": False,
        "fakeReEnabled": True,
    }


def test_owner_present_on_viewer_mutable(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """The owner is wired up at viewer construction. Sanity-check it
    is reachable and exposes the public surface other tests rely on."""
    del viser_server
    out = viser_page.evaluate(
        """
        () => {
            const owner = window.__viserMutable.cameraControlOwner;
            return {
                hasOwner: owner !== undefined && owner !== null,
                hasAcquire: typeof owner.acquireLease === "function",
                hasSetInstanceGetter:
                    typeof owner.setInstanceGetter === "function",
                hasSetGesture: typeof owner.setGesture === "function",
                noLeasesInitially: !owner.hasLease(),
            };
        }
        """
    )
    assert out == {
        "hasOwner": True,
        "hasAcquire": True,
        "hasSetInstanceGetter": True,
        "hasSetGesture": True,
        "noLeasesInitially": True,
    }
