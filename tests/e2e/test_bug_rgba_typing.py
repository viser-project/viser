"""E2E regression test for the RGBA color input fighting the user's typing.

Regression (``components/Rgba.tsx``): the "sync from prop" effect listed
``localValue`` in its dependency array::

    React.useEffect(() => {
      const parsedLocal = parseToRgba(localValue);
      if (!parsedLocal || !rgbaEqual(parsedLocal, value)) {
        setLocalValue(rgbaToString(value));
      }
    }, [value, localValue]);   // <-- re-runs on every keystroke

Because the effect re-runs on every ``localValue`` change, any intermediate
text that does not parse back to the *current* store ``value`` (e.g. a hex
string the user is typing, which is only committed on Enter/blur) immediately
snaps the field back to the stored color. The user can never enter a new color
by typing. The sibling ``Rgb.tsx`` correctly depends on ``[value]`` only.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import find_gui_input


def test_rgba_hex_entry_is_not_reverted(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Typing a hex color and pressing Enter should update the value.

    With the buggy effect, the field reverts to the previous color before
    Enter can commit, so the server-side value never changes.
    """
    handle = viser_server.gui.add_rgba("Color", initial_value=(255, 0, 0, 255))

    inp = find_gui_input(viser_page, "Color")
    inp.wait_for(state="visible", timeout=5_000)

    # Replace the field contents with a green hex color and commit with Enter.
    inp.click()
    inp.fill("#00ff00")
    inp.press("Enter")

    # The server-side handle should now hold green. Poll briefly for the
    # client -> server GUI update to arrive.
    deadline_iterations = 50
    for _ in range(deadline_iterations):
        if handle.value == (0, 255, 0, 255):
            break
        viser_page.wait_for_timeout(100)

    assert handle.value == (0, 255, 0, 255), (
        "Typing a hex color did not update the RGBA value -- the input reverted "
        f"to the previous color while typing. Server value is {handle.value}."
    )
