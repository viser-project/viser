"""GUI elements that are placed in the scene."""

from __future__ import annotations

import threading

from playwright.sync_api import Page, expect

import viser

from .utils import wait_for_scene_node


def test_3d_gui_container(viser_server: viser.ViserServer, viser_page: Page) -> None:
    """Contexts need to be bridged into the container, which used to crash."""
    clicked = threading.Event()
    container = viser_server.scene.add_3d_gui_container("/gui")
    with container:
        button = viser_server.gui.add_button("Button in scene")
        button.on_click(lambda _: clicked.set())
    locator = viser_page.get_by_role("button", name="Button in scene")
    expect(locator).to_be_visible()
    locator.click()
    assert clicked.wait(5.0)

    # Follows the node.
    before = locator.bounding_box()
    container.position = (0.0, 0.0, 1.0)
    viser_page.wait_for_timeout(500)
    after = locator.bounding_box()
    assert before is not None and after is not None
    assert before["y"] - after["y"] > 5.0

    container.visible = False
    expect(locator).not_to_be_visible()
    container.visible = True
    expect(locator).to_be_visible()
    container.remove()
    expect(locator).not_to_be_attached()


def test_children_of_labels_follow_them(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    viser_server.scene.add_label("/label", "hello", position=(1.0, 2.0, 3.0))
    for _ in range(2):
        child = viser_server.scene.add_frame("/label/child", position=(0.0, 1.0, 0.0))
        wait_for_scene_node(viser_page, "/label/child")
        viser_page.wait_for_function(
            """() => {
              const label = window.__viserMutable.nodeRefFromName["/label"];
              const e = label.matrixWorld.elements;
              const root = window.__viserMutable.nodeRefFromName[""];
              const position = label.position.clone();
              return (
                position.equals({ x: 1, y: 2, z: 3 })
                && position.applyMatrix4(root.matrixWorld).distanceTo(
                  { x: e[12], y: e[13], z: e[14] }
                ) < 1e-5
              );
            }""",
            timeout=5000,
        )
        child.remove()
        viser_page.wait_for_function(
            "() => !('/label/child' in window.__viserMutable.nodeRefFromName)"
        )
