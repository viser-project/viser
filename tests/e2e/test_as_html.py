"""E2E tests for StateSerializer.as_html() and SceneApi.as_html()."""

from __future__ import annotations

import tempfile
from pathlib import Path

from playwright.sync_api import Page

import viser

from .utils import JS_GET_SCENE_CHILD_NAMES, wait_for_scene_node


def test_as_html_returns_valid_html(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """as_html() should return a complete HTML document with embedded scene data."""
    viser_server.scene.add_icosphere("/html_sphere", radius=0.5, color=(255, 0, 0))

    # Wait for the scene to be populated on the server side.
    wait_for_scene_node(viser_page, "/html_sphere")

    html = viser_server.scene.as_html()

    assert isinstance(html, str)
    assert "<!doctype html>" in html.lower() or "<html" in html.lower()
    assert "__VISER_EMBED_DATA__" in html
    assert "__VISER_EMBED_CONFIG__" in html


def test_as_html_dark_mode(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """as_html(dark_mode=True) should inject darkMode:true in the config."""
    viser_server.scene.add_box("/dark_box", dimensions=(1.0, 1.0, 1.0))
    wait_for_scene_node(viser_page, "/dark_box")

    html_light = viser_server.scene.as_html(dark_mode=False)
    html_dark = viser_server.scene.as_html(dark_mode=True)

    assert "darkMode:false" in html_light
    assert "darkMode:true" in html_dark


def test_as_html_renders_scene(
    viser_server: viser.ViserServer,
    page: Page,
    viser_page: Page,
) -> None:
    """The standalone HTML from as_html() should render the scene when loaded."""
    viser_server.scene.add_icosphere("/render_sphere", radius=0.3, color=(0, 255, 0))
    viser_server.scene.add_box(
        "/render_box", dimensions=(0.5, 0.5, 0.5), color=(0, 0, 255)
    )
    wait_for_scene_node(viser_page, "/render_sphere")
    wait_for_scene_node(viser_page, "/render_box")

    html = viser_server.scene.as_html()

    # Write to a temp file and load it in a fresh page (no server needed).
    with tempfile.NamedTemporaryFile(
        "w", suffix=".html", delete=False, encoding="utf-8"
    ) as f:
        f.write(html)
        tmp_path = f.name

    page.goto(f"file://{tmp_path}")

    # The embedded viewer should render a canvas.
    canvas = page.locator("canvas")
    canvas.first.wait_for(state="visible", timeout=15_000)

    # The scene nodes from the serialized data should appear.
    page.wait_for_function(
        """() => {
            const m = window.__viserMutable;
            return m && m.nodeRefFromName
                && m.nodeRefFromName['/render_sphere'] != null
                && m.nodeRefFromName['/render_box'] != null;
        }""",
        timeout=15_000,
    )

    names = page.evaluate(JS_GET_SCENE_CHILD_NAMES)
    assert "/render_sphere" in names
    assert "/render_box" in names

    Path(tmp_path).unlink(missing_ok=True)


def test_serializer_as_html(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """StateSerializer.as_html() should work directly."""
    viser_server.scene.add_frame("/ser_frame", show_axes=True)
    wait_for_scene_node(viser_page, "/ser_frame")

    serializer = viser_server.get_scene_serializer()
    html = serializer.as_html(dark_mode=True)

    assert isinstance(html, str)
    assert "__VISER_EMBED_DATA__" in html
    assert "darkMode:true" in html


def test_skinned_mesh_animates_across_playback_loops(
    viser_server: viser.ViserServer,
    page: Page,
    viser_page: Page,
) -> None:
    """Bone animation must survive playback loops.

    FilePlayback's loop deliberately keeps scene nodes mounted (resetScene
    hides instead of removing) and re-pushes the same add messages. The
    SkinnedMeshMessage handler used to REPLACE the mesh's mutable state entry
    on every add, stranding the mounted component's ownership guard on a dead
    reference: bones froze at the first loop's final pose and every later
    update was silently dropped."""
    import numpy as np

    v = 8
    mesh = viser_server.scene.add_mesh_skinned(
        "/skinned",
        np.array([[np.cos(i), np.sin(i), i * 0.1] for i in range(v)], dtype=np.float32),
        np.array([[0, 1, 2], [3, 4, 5], [5, 6, 7]], dtype=np.uint32),
        bone_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]]),
        bone_positions=np.zeros((2, 3)),
        skin_weights=np.abs(np.random.rand(v, 2)).astype(np.float32),
    )
    wait_for_scene_node(viser_page, "/skinned")

    # Record ~0.8s of bone animation, including a same-batch remove +
    # re-add (no sleep between them): the replayed remove deletes the mesh's
    # state entry and the re-add recreates it within one message batch, so
    # the mounted component must ADOPT the fresh entry -- it never remounts.
    serializer = viser_server.get_scene_serializer()
    for step in range(3):
        serializer.insert_sleep(0.2)
        mesh.bones[1].position = (0.0, 0.0, 1.0 + step)
    mesh.remove()
    # Re-add with DIFFERENT geometry (x shifted by +5): the replayed re-add
    # must also rebuild the rendered geometry -- in a recording every array
    # views ONE shared buffer, so memoization keyed on .buffer identity kept
    # the old vertices forever.
    mesh = viser_server.scene.add_mesh_skinned(
        "/skinned",
        np.array(
            [[np.cos(i) + 5.0, np.sin(i), i * 0.1] for i in range(v)],
            dtype=np.float32,
        ),
        np.array([[0, 1, 2], [3, 4, 5], [5, 6, 7]], dtype=np.uint32),
        bone_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]]),
        bone_positions=np.zeros((2, 3)),
        skin_weights=np.abs(np.random.rand(v, 2)).astype(np.float32),
    )
    serializer.insert_sleep(0.2)
    mesh.bones[1].position = (0.0, 0.0, 9.0)
    html = serializer.as_html()

    with tempfile.NamedTemporaryFile(
        "w", suffix=".html", delete=False, encoding="utf-8"
    ) as f:
        f.write(html)
        tmp_path = f.name
    page.goto(f"file://{tmp_path}")
    page.locator("canvas").first.wait_for(state="visible", timeout=15_000)

    js_bone_z = """() => {
        const m = window.__viserMutable;
        const node = m && m.nodeRefFromName && m.nodeRefFromName['/skinned'];
        if (!node) return null;
        const bones = [];
        node.traverse((o) => { if (o.type === 'Bone') bones.push(o); });
        if (bones.length < 2) return null;
        let vx = null;
        node.traverse((o) => {
            if (vx === null && o.isSkinnedMesh)
                vx = o.geometry.attributes.position.array[0];
        });
        return { z: bones[1].position.z, vx };
    }"""
    page.wait_for_function(js_bone_z, timeout=15_000)

    # Sample bone z well past the first loop (recording is ~0.8s; sample for
    # ~2.4s => at least 2 full loops). The LATE window must still show
    # motion; frozen bones make it constant.
    samples: list[float] = []
    vx_samples: list[float] = []
    for _ in range(30):
        out = page.evaluate(js_bone_z)
        if out is not None:
            samples.append(float(out["z"]))
            if out["vx"] is not None:
                vx_samples.append(float(out["vx"]))
        page.wait_for_timeout(80)
    late = samples[len(samples) // 2 :]
    assert len(set(f"{z:.3f}" for z in late)) > 1, (
        f"bone froze after the first playback loop: late samples={late[:10]}..."
    )
    # The re-added (shifted) geometry must actually render: vertex 0's x is
    # cos(0) + 5 = 6 after the in-recording re-add.
    assert any(vx > 3.0 for vx in vx_samples), (
        f"re-added geometry never rendered (stale memo): vx={vx_samples[:10]}..."
    )

    Path(tmp_path).unlink(missing_ok=True)


def test_playback_resets_environment_across_loops(
    viser_server: viser.ViserServer,
    page: Page,
    viser_page: Page,
) -> None:
    """A global environment change (fog) set MID-recording must reset on each
    loop, not stick from the previous pass. resetScene only touched scene
    nodes; the environment store had no per-loop reset, so fog enabled at t=1
    stayed on during the [0, 1) window of every later loop."""
    viser_server.scene.add_icosphere("/s", radius=0.3)
    wait_for_scene_node(viser_page, "/s")

    serializer = viser_server.get_scene_serializer()
    serializer.insert_sleep(0.4)
    viser_server.scene.configure_fog(near=5.0, far=20.0, enabled=True)
    serializer.insert_sleep(0.4)
    html = serializer.as_html()

    with tempfile.NamedTemporaryFile(
        "w", suffix=".html", delete=False, encoding="utf-8"
    ) as f:
        f.write(html)
        tmp_path = f.name
    page.goto(f"file://{tmp_path}")
    page.locator("canvas").first.wait_for(state="visible", timeout=15_000)

    js_fog = "() => { const m = window.__viserMutable; return !!(m && m.scene && m.scene.fog); }"
    # Sample fog presence across ~2.4s (recording is ~0.8s -> at least 2 loops).
    # With the reset, fog TOGGLES (off during each loop's [0, 0.4) window, on
    # after); without it, fog is on continuously once first reached.
    fog_states: list[bool] = []
    for _ in range(40):
        fog_states.append(bool(page.evaluate(js_fog)))
        page.wait_for_timeout(80)
    # LATE window only (loop 2+): loop 1's initial [0, 0.4) fog-off ramp is
    # expected regardless of the fix, so assert on samples past the first
    # loop. With the reset, fog goes OFF again during each later loop's
    # [0, 0.4) window; WITHOUT it, fog is stuck ON continuously after loop 1.
    late = fog_states[len(fog_states) // 2 :]
    assert any(late), f"fog never turned on -- test setup wrong, got {fog_states}"
    assert not all(late), (
        f"fog stuck on after the first loop (env not reset), got {fog_states}"
    )
    Path(tmp_path).unlink(missing_ok=True)
