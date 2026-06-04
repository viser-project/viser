"""E2E regression test for tab-group selection breaking on sibling removal.

Regression (``components/TabGroup.tsx``): the Mantine ``Tabs`` was uncontrolled
with ``defaultValue="0"`` and each tab/panel identified by its *array index*::

    <Tabs ... defaultValue={"0"}>
      <Tabs.Tab value={index.toString()} key={index}> ...
      <Tabs.Panel value={index.toString()} key={containerUuid}> ...

Selection is stored internally as an index string. When a tab is added or
removed on the server the index -> content mapping shifts, so the previously
selected tab's content no longer matches the retained selection index. Removing
a *non-active* tab leaves the selection pointing at an index that no longer
exists, and the still-present active tab's panel disappears.
"""

from __future__ import annotations

from playwright.sync_api import Page, expect

import viser


def test_active_tab_survives_removal_of_earlier_tab(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing an earlier, non-active tab must not hide the active tab."""
    tabs = viser_server.gui.add_tab_group()

    tab_a = tabs.add_tab("AlphaTab")
    with tab_a:
        viser_server.gui.add_button("alpha-content")

    tab_b = tabs.add_tab("BetaTab")
    with tab_b:
        viser_server.gui.add_button("beta-content")

    # Both tab triggers should render.
    expect(viser_page.get_by_role("tab", name="AlphaTab")).to_be_visible(timeout=5_000)

    # Select the second tab; it should become the active/selected tab.
    beta_tab = viser_page.get_by_role("tab", name="BetaTab")
    beta_tab.click()
    expect(beta_tab).to_have_attribute("aria-selected", "true", timeout=3_000)

    # Remove the first (non-active) tab on the server, and wait for the removal
    # to actually take effect on the client before asserting.
    tab_a.remove()
    expect(viser_page.get_by_role("tab", name="AlphaTab")).to_have_count(
        0, timeout=5_000
    )

    # The Beta tab is still present and was the user's selection, so it must
    # stay selected. With the index-keyed/uncontrolled bug, the retained
    # selection index ("1") no longer maps to any tab after Alpha (index "0")
    # is removed and Beta is re-indexed to "0", so *no* tab is selected.
    expect(beta_tab).to_have_attribute("aria-selected", "true", timeout=3_000)
