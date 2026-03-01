"""E2E test for texture memory leak when updating ViserImage."""

from __future__ import annotations

import numpy as np
from playwright.sync_api import Page

import viser

from .utils import find_free_port, wait_for_connection, wait_for_scene_node

# JS: check if the image node has a texture loaded on its material.
JS_HAS_TEXTURE = """
() => {
    const nodeRef = window.__viserMutable?.nodeRefFromName?.['/test_image'];
    if (!nodeRef) return false;
    let found = false;
    nodeRef.traverse((obj) => {
        if (obj.material && obj.material.map && obj.material.map.isTexture) {
            found = true;
        }
    });
    return found;
}
"""

# JS: wait until the texture UUID differs from a given value.
JS_TEXTURE_UUID_CHANGED = """
(prevUuid) => {
    const nodeRef = window.__viserMutable?.nodeRefFromName?.['/test_image'];
    if (!nodeRef) return false;
    let changed = false;
    nodeRef.traverse((obj) => {
        if (obj.material && obj.material.map && obj.material.map.isTexture) {
            if (obj.material.map.uuid !== prevUuid) changed = true;
        }
    });
    return changed;
}
"""


def test_texture_memory_leak_when_updating_image(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Test that updating an image properly disposes old GPU textures.

    Verifies the ViserImage component disposes old THREE.Texture instances
    when image data changes, preventing GPU memory leaks.
    """
    # Create initial image.
    initial_image = np.random.randint(0, 255, (100, 100, 3), dtype=np.uint8)
    image_handle = viser_server.scene.add_image(
        "/test_image",
        image=initial_image,
        render_width=1.0,
        render_height=1.0,
        position=(0, 0, 0),
    )

    # Wait for the image to appear in the scene.
    wait_for_scene_node(viser_page, "/test_image")

    # Wait for the texture to actually load on the material.
    viser_page.wait_for_function(JS_HAS_TEXTURE, timeout=10_000)

    # Track texture UUIDs to detect leaks.
    # We'll track which textures are currently active vs which have been disposed.
    initial_texture_info = viser_page.evaluate("""
        () => {
            window.textureHistory = [];  // Track all textures seen

            // Check through React Fiber to find the ViserImage component and its texture
            const nodeRef = window.__viserMutable?.nodeRefFromName?.['/test_image'];
            let currentTexture = null;
            if (nodeRef) {
                nodeRef.traverse((obj) => {
                    if (obj.material && obj.material.map && obj.material.map.isTexture) {
                        currentTexture = {
                            uuid: obj.material.map.uuid,
                            disposed: false
                        };
                        window.textureHistory.push(currentTexture);

                        // Override dispose to track when textures are disposed
                        const originalDispose = obj.material.map.dispose;
                        obj.material.map.dispose = function() {
                            currentTexture.disposed = true;
                            originalDispose.call(this);
                        };
                    }
                });
            }

            return {
                currentUuid: currentTexture ? currentTexture.uuid : null,
                totalCount: window.textureHistory.length
            };
        }
    """)

    print(f"Initial texture info: {initial_texture_info}")

    # Track the current texture UUID so we can detect when it changes.
    prev_uuid = initial_texture_info.get("currentUuid")

    # Update the image 10 times with different content.
    for i in range(10):
        # Create a new random image with different content.
        new_image = np.random.randint(0, 255, (100, 100, 3), dtype=np.uint8)
        # Add some pattern to ensure it's different.
        new_image[i * 10 : (i + 1) * 10, :, 0] = 255  # Red stripe.

        # Update the image.
        image_handle.image = new_image

        # Wait until the texture UUID changes (proving the update was processed).
        if prev_uuid is not None:
            viser_page.wait_for_function(
                JS_TEXTURE_UUID_CHANGED, arg=prev_uuid, timeout=10_000
            )

        # Track new textures created after each update.
        texture_info = viser_page.evaluate("""
            () => {
                // Check the image node for new textures
                const nodeRef = window.__viserMutable?.nodeRefFromName?.['/test_image'];
                let currentTexture = null;

                if (nodeRef) {
                    nodeRef.traverse((obj) => {
                        if (obj.material && obj.material.map && obj.material.map.isTexture) {
                            // Check if this is a new texture we haven't seen
                            const existingTexture = window.textureHistory.find(t => t.uuid === obj.material.map.uuid);
                            if (!existingTexture) {
                                currentTexture = {
                                    uuid: obj.material.map.uuid,
                                    disposed: false
                                };
                                window.textureHistory.push(currentTexture);

                                // Override dispose to track when textures are disposed
                                const originalDispose = obj.material.map.dispose;
                                obj.material.map.dispose = function() {
                                    currentTexture.disposed = true;
                                    originalDispose.call(this);
                                };
                            } else {
                                currentTexture = existingTexture;
                            }
                        }
                    });
                }

                // Count how many textures are NOT disposed
                const activeTextures = window.textureHistory.filter(t => !t.disposed);
                const disposedTextures = window.textureHistory.filter(t => t.disposed);

                return {
                    currentUuid: currentTexture ? currentTexture.uuid : null,
                    totalCreated: window.textureHistory.length,
                    activeCount: activeTextures.length,
                    disposedCount: disposedTextures.length
                };
            }
        """)

        print(f"Update {i + 1}: {texture_info}")
        prev_uuid = texture_info.get("currentUuid")

    # Final check - analyze texture disposal pattern.
    final_texture_analysis = viser_page.evaluate("""
        () => {
            const result = {
                totalCreated: window.textureHistory.length,
                activeTextures: [],
                disposedTextures: []
            };

            window.textureHistory.forEach(tex => {
                if (tex.disposed) {
                    result.disposedTextures.push(tex.uuid);
                } else {
                    result.activeTextures.push(tex.uuid);
                }
            });

            return result;
        }
    """)

    print(f"\nFinal texture analysis:")
    print(f"  Total textures created: {final_texture_analysis['totalCreated']}")
    print(f"  Active (not disposed): {len(final_texture_analysis['activeTextures'])}")
    print(f"  Disposed: {len(final_texture_analysis['disposedTextures'])}")

    # If textures are properly disposed, we should have:
    # - Only 1 active texture (the current one).
    # - All others should be disposed.
    active_count = len(final_texture_analysis['activeTextures'])
    total_created = final_texture_analysis['totalCreated']

    # Assert that only the current texture is active, all others are disposed.
    assert active_count <= 2, (
        f"Found {active_count} active (non-disposed) textures after {total_created} total created. "
        f"Expected at most 2 active textures if properly managed (current + maybe loading), "
        f"but {active_count} textures are still in memory, indicating a leak."
    )