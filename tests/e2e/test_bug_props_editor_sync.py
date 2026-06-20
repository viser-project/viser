"""E2E regression tests for the scene-tree prop editor syncing with the server.

Regression (``ControlPanel/SceneTreeTable.tsx`` ``EditNodePropsInner``): the
editor recomputes ``initialValues`` from the reactive ``nodeMessage.props`` on
every render, but Mantine's ``useForm`` only reads ``initialValues`` at mount.
The editor now pushes server-changed fields into the form via an effect.

Two behaviours are covered:
- A prop changed on the server updates the open editor input.
- A server update to one prop must NOT discard an in-progress (uncommitted)
  edit of a *different* prop -- the earlier remount-on-every-change fix had
  that regression.
"""

from __future__ import annotations

from playwright.sync_api import Page, expect

import viser

from .utils import wait_for_scene_node


def _open_editor(viser_page: Page, node_name: str):
    viser_page.get_by_label(f"Edit props for {node_name}").click()
    popover = viser_page.locator(f'[data-props-popover-for="{node_name}"]')
    expect(popover).to_be_visible(timeout=5_000)
    return popover


def test_open_prop_editor_reflects_server_update(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A prop changed on the server should update the open editor input."""
    handle = viser_server.scene.add_frame("/myframe", axes_length=0.5)
    wait_for_scene_node(viser_page, "/myframe")
    viser_page.wait_for_timeout(500)

    popover = _open_editor(viser_page, "/myframe")
    axes_input = popover.locator('[data-prop-key="axes_length"] input')
    expect(axes_input).to_have_value("0.5", timeout=3_000)

    handle.axes_length = 2.0
    expect(axes_input).to_have_value("2", timeout=5_000)


def test_server_update_preserves_in_progress_edit_of_other_field(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Editing one field, then a server update to a DIFFERENT field, must not
    discard the in-progress edit."""
    handle = viser_server.scene.add_frame(
        "/myframe", axes_length=0.5, axes_radius=0.0125
    )
    wait_for_scene_node(viser_page, "/myframe")
    viser_page.wait_for_timeout(500)

    popover = _open_editor(viser_page, "/myframe")
    radius_input = popover.locator('[data-prop-key="axes_radius"] input')
    expect(radius_input).to_be_visible(timeout=3_000)

    # Type a new (uncommitted) value into axes_radius -- do NOT press Enter.
    radius_input.click()
    radius_input.fill("0.5")

    # Server updates a *different* prop on the same node.
    handle.axes_length = 3.0
    axes_input = popover.locator('[data-prop-key="axes_length"] input')
    expect(axes_input).to_have_value("3", timeout=5_000)

    # The in-progress edit of axes_radius must be preserved.
    expect(radius_input).to_have_value("0.5")
