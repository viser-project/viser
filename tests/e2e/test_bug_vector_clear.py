"""E2E regression test for vector inputs committing 0 when cleared.

Regression (``components/common.tsx`` ``VectorInput``): the ``onChange`` mapped
the transient empty string to ``0.0`` and sent it, so clearing a component to
retype it momentarily committed ``0`` to the server (and ignored ``min``). Every
other numeric input ignores the empty value; the vector input now does too.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import find_gui_input


def test_clearing_vector_field_does_not_commit_zero(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    handle = viser_server.gui.add_vector3(
        "vec", initial_value=(3.0, 4.0, 5.0), min=(1.0, 1.0, 1.0)
    )
    seen: list[tuple[float, ...]] = []
    handle.on_update(lambda _: seen.append(tuple(handle.value)))

    x_input = find_gui_input(viser_page, "vec").first
    x_input.wait_for(state="visible", timeout=5_000)

    # Clear the x field (as a user would before retyping).
    x_input.click()
    x_input.press("Control+a")
    x_input.press("Delete")
    viser_page.wait_for_timeout(400)

    assert not any(v[0] == 0.0 for v in seen), (
        f"clearing the vector field committed an out-of-range 0 to the server: {seen}"
    )
    assert handle.value[0] == 3.0, handle.value
