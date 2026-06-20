"""E2E tests for the scene-tree edit-props popover.

These cover the schema-driven widget dispatch (boolean -> Switch, color ->
ColorInput, string literal -> Select, default -> JSON TextInput) and the
hover tooltip that surfaces the TypeScript annotation.
"""

from __future__ import annotations

from playwright.sync_api import Locator, Page, expect

import viser

from .utils import wait_for_scene_node


def _open_props_popover(page: Page, node_name: str) -> Locator:
    """Hover the row, click its pencil button, return the popover dropdown."""
    row = page.locator(f'[data-scene-node="{node_name}"]')
    expect(row).to_be_visible(timeout=10_000)
    row.hover()

    pencil = row.locator(f'[aria-label="Edit props for {node_name}"]')
    expect(pencil).to_be_visible()
    pencil.click()

    popover = page.locator(f'[data-props-popover-for="{node_name}"]')
    expect(popover).to_be_visible(timeout=5_000)
    return popover


def _read_prop(page: Page, node_name: str, key: str) -> object:
    """Read a prop value out of the client-side scene tree store."""
    return page.evaluate(
        """([name, key]) => {
            const tree = window.__viserSceneTree;
            if (!tree) return null;
            const state = tree.getState();
            const node = state[name];
            if (!node) return null;
            const v = node.message.props[key];
            return ArrayBuffer.isView(v) ? Array.from(v) : v;
        }""",
        [node_name, key],
    )


def test_boolean_prop_renders_as_checkbox(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A boolean field (FrameMessage.show_axes) should render as a Checkbox
    and toggling it should flip the value in the local scene tree state."""
    viser_server.scene.add_frame("/bool_frame", show_axes=True)
    wait_for_scene_node(viser_page, "/bool_frame")

    assert _read_prop(viser_page, "/bool_frame", "show_axes") is True

    popover = _open_props_popover(viser_page, "/bool_frame")
    row = popover.locator('[data-prop-key="show_axes"]')
    cb = row.get_by_role("checkbox")
    expect(cb).to_be_checked()

    # Mantine Checkbox visually hides its underlying <input>; dispatch a
    # native click so we don't trip Playwright's visibility check.
    cb.dispatch_event("click")
    viser_page.wait_for_function(
        """([name]) => {
            const t = window.__viserSceneTree;
            return t && t.getState()[name].message.props.show_axes === false;
        }""",
        arg=["/bool_frame"],
        timeout=5_000,
    )


def test_color_prop_renders_as_color_input(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A Tuple[int, int, int] color field should render as a ColorInput, and
    typing a hex value should write the corresponding 0-255 RGB tuple."""
    viser_server.scene.add_frame("/color_frame", origin_color=(255, 0, 0))
    wait_for_scene_node(viser_page, "/color_frame")

    popover = _open_props_popover(viser_page, "/color_frame")
    row = popover.locator('[data-prop-key="origin_color"]')
    text_input = row.locator("input")
    expect(text_input).to_be_visible()

    text_input.fill("#00ff00")
    text_input.press("Enter")

    viser_page.wait_for_function(
        """([name]) => {
            const t = window.__viserSceneTree;
            const c = t && t.getState()[name].message.props.origin_color;
            return Array.isArray(c) && c[0] === 0 && c[1] === 255 && c[2] === 0;
        }""",
        arg=["/color_frame"],
        timeout=5_000,
    )


def test_string_literal_prop_renders_as_select(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A Literal[...] field (GridMessage.plane) should render as a Select
    dropdown listing every option, and choosing one should propagate."""
    viser_server.scene.add_grid("/grid_lit", plane="xy")
    wait_for_scene_node(viser_page, "/grid_lit")
    assert _read_prop(viser_page, "/grid_lit", "plane") == "xy"

    popover = _open_props_popover(viser_page, "/grid_lit")
    row = popover.locator('[data-prop-key="plane"]')
    # Mantine Select renders both a visible readonly input and a hidden form
    # value input -- exclude the hidden one.
    select_input = row.locator('input:not([type="hidden"])')
    expect(select_input).to_be_visible()
    expect(select_input).to_have_value("xy")

    select_input.click()
    # Mantine renders dropdown options as role=option in a portal.
    yz_option = viser_page.get_by_role("option", name="yz", exact=True)
    expect(yz_option).to_be_visible(timeout=2_000)
    yz_option.click()

    viser_page.wait_for_function(
        """([name]) => {
            const t = window.__viserSceneTree;
            return t && t.getState()[name].message.props.plane === "yz";
        }""",
        arg=["/grid_lit"],
        timeout=5_000,
    )


def test_default_prop_uses_json_text_input(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A field that doesn't match any special-case (here: a number) should
    keep the existing JSON TextInput path with a save button."""
    viser_server.scene.add_frame("/num_frame", axes_length=0.5)
    wait_for_scene_node(viser_page, "/num_frame")

    popover = _open_props_popover(viser_page, "/num_frame")
    row = popover.locator('[data-prop-key="axes_length"]')
    text_input = row.locator("input")
    expect(text_input).to_be_visible()
    expect(text_input).to_have_value("0.5")

    text_input.fill("2.5")
    text_input.press("Enter")

    viser_page.wait_for_function(
        """([name]) => {
            const t = window.__viserSceneTree;
            return t && t.getState()[name].message.props.axes_length === 2.5;
        }""",
        arg=["/num_frame"],
        timeout=5_000,
    )


def test_default_prop_handles_union_with_json(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Union shapes like Union[float, Tuple[float, float, float]] (FrameMessage.scale)
    stay as the JSON text input -- we picked that as the deliberate default."""
    viser_server.scene.add_frame("/union_frame", scale=1.0)
    wait_for_scene_node(viser_page, "/union_frame")

    popover = _open_props_popover(viser_page, "/union_frame")
    row = popover.locator('[data-prop-key="scale"]')
    text_input = row.locator("input")
    expect(text_input).to_be_visible()

    text_input.fill("[1, 2, 3]")
    text_input.press("Enter")

    viser_page.wait_for_function(
        """([name]) => {
            const t = window.__viserSceneTree;
            const s = t && t.getState()[name].message.props.scale;
            return Array.isArray(s) && s[0] === 1 && s[1] === 2 && s[2] === 3;
        }""",
        arg=["/union_frame"],
        timeout=5_000,
    )


def test_editor_hidden_prop_is_not_shown(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Props marked with infra.EditorHidden (e.g. PointCloud.precision, which
    is coupled to the dtype of `points` and can't be edited in isolation)
    must not render as an editable row."""
    import numpy as np

    viser_server.scene.add_point_cloud(
        "/cloud_hidden",
        points=np.zeros((4, 3), dtype=np.float32),
        colors=np.zeros((4, 3), dtype=np.uint8),
    )
    wait_for_scene_node(viser_page, "/cloud_hidden")

    popover = _open_props_popover(viser_page, "/cloud_hidden")

    # `point_size` (an unhidden prop) should be present; `precision` (hidden)
    # should not be.
    expect(popover.locator('[data-prop-key="point_size"]')).to_be_visible()
    expect(popover.locator('[data-prop-key="precision"]')).to_have_count(0)


def test_input_tooltip_shows_ts_annotation(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Hovering a prop's input should reveal a tooltip with the TypeScript
    type annotation for that prop -- e.g. the literal-union options for `plane`."""
    viser_server.scene.add_grid("/grid_tooltip", plane="xy")
    wait_for_scene_node(viser_page, "/grid_tooltip")

    popover = _open_props_popover(viser_page, "/grid_tooltip")
    input_el = popover.locator('[data-prop-key="plane"] input:not([type="hidden"])')
    input_el.hover()

    # Mantine portals tooltips into <body>; locate any visible tooltip
    # whose text contains the literal options.
    tooltip = viser_page.locator('[role="tooltip"]', has_text="'xz'")
    expect(tooltip.first).to_be_visible(timeout=3_000)
    expect(tooltip.first).to_contain_text("'yz'")


def test_pencil_tooltip_uses_message_type(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """The pencil-icon tooltip should reflect the scene-node message type
    (e.g. 'Frame props') instead of the generic 'Local props'."""
    viser_server.scene.add_frame("/pencil_tip", show_axes=True)
    wait_for_scene_node(viser_page, "/pencil_tip")

    row = viser_page.locator('[data-scene-node="/pencil_tip"]')
    expect(row).to_be_visible(timeout=10_000)
    row.hover()
    pencil = row.locator('[aria-label="Edit props for /pencil_tip"]')
    expect(pencil).to_be_visible()
    pencil.hover()

    tooltip = viser_page.locator('[role="tooltip"]', has_text="Frame Props")
    expect(tooltip.first).to_be_visible(timeout=3_000)


def test_schema_covers_all_scene_node_messages() -> None:
    """Every scene-node message class should appear in the generated
    SceneNodePropsSchema (catches drift between the codegen and the message
    list without spinning up a browser)."""
    import pathlib

    from viser._messages import Message

    ts_path = (
        pathlib.Path(__file__).resolve().parents[2]
        / "src/viser/client/src/WebsocketMessages.ts"
    )
    ts_source = ts_path.read_text()
    schema_start = ts_source.find("SceneNodePropsSchema")
    assert schema_start != -1, "SceneNodePropsSchema not found in generated TS"
    schema_section = ts_source[schema_start:]

    expected = {
        cls.__name__
        for cls in Message.get_subclasses()
        if "SceneNodeMessage" in getattr(cls, "_tags", ())
        # Remove messages have no props dataclass and are skipped by codegen.
        and cls.__name__ != "RemoveSceneNodeMessage"
    }
    # Each entry is emitted as `MessageName: {...}` -- presence-check by name.
    missing = {name for name in expected if f"  {name}: {{" not in schema_section}
    assert not missing, f"Missing from schema: {missing}"


def test_boolean_submit_not_blocked_by_invalid_text_field(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Toggling a boolean prop must submit even if an UNRELATED text field is
    mid-edit with invalid JSON.

    Regression: the boolean/select/color inputs submitted via the whole-form
    ``form.onSubmit``, so any invalid field aborted validation and silently
    dropped the valid toggle. They now submit only the changed field.
    """
    viser_server.scene.add_frame("/f", show_axes=True, axes_length=0.5)
    wait_for_scene_node(viser_page, "/f")
    assert _read_prop(viser_page, "/f", "show_axes") is True

    popover = _open_props_popover(viser_page, "/f")

    # Leave a different (text) field in an invalid-JSON state.
    len_input = popover.locator('[data-prop-key="axes_length"] input')
    len_input.click()
    len_input.fill("[1, 2,")

    # Toggle the boolean; it must still reach the store.
    checkbox = popover.locator('[data-prop-key="show_axes"]').get_by_role("checkbox")
    checkbox.dispatch_event("click")
    viser_page.wait_for_function(
        """([name]) => {
            const t = window.__viserSceneTree;
            return t && t.getState()[name].message.props.show_axes === false;
        }""",
        arg=["/f"],
        timeout=5_000,
    )
