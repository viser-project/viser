"""Client-side benchmarks for large scenes, in headless chromium.

For each scene: load it, render it, stream updates to it, toggle its visibility,
and remove it, while measuring main-thread time and memory. There's usually no
GPU available where this runs, and software rasterization would drown out
everything else. So GL draw calls are counted but not executed (disable with
``--draw``), and the metric for most phases is main-thread busy time (CDP
``TaskDuration``).

    python benchmarks/bench_client.py --out before.json
    python benchmarks/bench_client.py --scenes frames,boxes
    python benchmarks/bench_client.py --compare before.json after.json

The client must be built. See ``run_bench.py`` for CPU profiles of smaller
scenes; pass ``--profile DIR`` here for profiles of each phase. To benchmark
another checkout, set PYTHONPATH to its ``src``.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np
import psutil
from bench_server import compare
from playwright.sync_api import CDPSession, Page, sync_playwright
from run_bench import _chromium_executable, print_top, summarize_cpuprofile

import viser

SCENES: dict[str, Callable[[viser.ViserServer], list[Any]]] = {}


def scene(fn):
    SCENES[fn.__name__] = fn
    return fn


# Scenes put everything below /bench, and return handles to stream poses to.


def _pos(i: int) -> tuple[float, float, float]:
    return ((i % 70) * 0.2 - 7.0, (i // 70) * 0.2 - 7.0, 0.0)


@scene
def empty(server):
    """Lower bound for every metric."""
    return [server.scene.add_frame("/bench/0", show_axes=False)]


@scene
def frames(server):
    return [
        server.scene.add_frame(
            f"/bench/{i}", axes_length=0.1, axes_radius=0.005, position=_pos(i)
        )
        for i in range(4000)
    ]


@scene
def boxes(server):
    return [
        server.scene.add_box(
            f"/bench/{i}",
            dimensions=(0.1, 0.1, 0.1),
            color=(i % 255, 0, 0),
            position=_pos(i),
        )
        for i in range(3000)
    ]


@scene
def clickable(server):
    handles = boxes(server)
    for h in handles:
        h.on_click(lambda _: None)
    return handles


@scene
def meshes(server):
    rng = np.random.default_rng(0)
    vertices = rng.uniform(-0.1, 0.1, (300, 3)).astype(np.float32)
    faces = rng.integers(0, 300, (500, 3))
    return [
        server.scene.add_mesh_simple(
            f"/bench/{i}", vertices + i * 1e-4, faces, position=_pos(i)
        )
        for i in range(2000)
    ]


@scene
def invisible_tree(server):
    """Kinematic trees: lots of nodes, little to draw."""
    return [
        server.scene.add_frame(
            f"/bench/{i // 400}/{(i // 20) % 20}/{i % 20}",
            show_axes=False,
            position=_pos(i),
        )
        for i in range(8000)
    ]


@scene
def frustums(server):
    return [
        server.scene.add_camera_frustum(
            f"/bench/{i}", fov=1.0, aspect=1.5, scale=0.1, position=_pos(i)
        )
        for i in range(1000)
    ]


@scene
def labels(server):
    return [
        server.scene.add_label(f"/bench/{i}", f"label {i}", position=_pos(i))
        for i in range(2000)
    ]


@scene
def points(server):
    rng = np.random.default_rng(0)
    return [
        server.scene.add_point_cloud(
            f"/bench/{i}",
            rng.uniform(-5, 5, (1_000_000, 3)).astype(np.float32),
            rng.integers(0, 255, (1_000_000, 3), dtype=np.uint8),
            point_size=0.001,
            precision="float32",
        )
        for i in range(5)
    ]


@scene
def big_mesh(server):
    rng = np.random.default_rng(0)
    n = 1_000_000
    return [
        server.scene.add_mesh_simple(
            "/bench/mesh",
            rng.uniform(-5, 5, (n, 3)).astype(np.float32),
            rng.integers(0, n, (2 * n, 3)),
        )
    ]


@scene
def gui(server):
    with server.gui.add_folder("folder"):
        return [
            server.gui.add_slider(
                f"s{i}", min=0.0, max=1.0, step=0.001, initial_value=0.0
            )
            for i in range(300)
        ]


class Meter:
    def __init__(self, page: Page, cdp: CDPSession, profile_dir: Path | None) -> None:
        self.page = page
        self.cdp = cdp
        self.profile_dir = profile_dir

    def task_s(self) -> float:
        metrics = self.cdp.send("Performance.getMetrics")["metrics"]
        return {m["name"]: m["value"] for m in metrics}["TaskDuration"]

    def settle(self) -> None:
        """Wait until the main thread is (nearly) idle."""
        last = self.task_s()
        for _ in range(300):
            self.page.wait_for_timeout(400)
            now = self.task_s()
            # Idle scenes still render a 1 Hz heartbeat.
            if now - last < 0.1:
                return
            last = now

    def start(self) -> None:
        self.t0 = self.task_s()
        if self.profile_dir is not None:
            self.cdp.send("Profiler.start")

    def stop(self, name: str) -> float:
        out = self.task_s() - self.t0
        if self.profile_dir is not None:
            profile = self.cdp.send("Profiler.stop")["profile"]
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            (self.profile_dir / f"{name}.cpuprofile").write_text(json.dumps(profile))
            print(f"--- {name}: {out:.3f}s")
            print_top(
                [
                    r
                    for r in summarize_cpuprofile(profile, 20)
                    if r["function"] != "(idle)"
                ]
            )
        return out

    def heap_mb(self) -> float:
        """JS heap plus ArrayBuffer backing stores."""
        for _ in range(2):
            self.cdp.send("HeapProfiler.collectGarbage")
        usage = self.cdp.send("Runtime.getHeapUsage")
        return (usage["usedSize"] + usage.get("backingStorageSize", 0)) / 1e6


def renderer_rss_mb() -> float:
    return max(
        (
            p.memory_info().rss / 1e6
            for p in psutil.Process().children(recursive=True)
            if any("--type=renderer" in a for a in p.cmdline())
        ),
        default=0.0,
    )


JS_STUB_DRAWS = """
(() => {
  window.__benchDraws = 0;
  for (const name of ["drawElements", "drawArrays", "drawElementsInstanced",
                      "drawArraysInstanced", "drawRangeElements"]) {
    WebGL2RenderingContext.prototype[name] = () => { window.__benchDraws++; };
  }
  const getExtension = WebGL2RenderingContext.prototype.getExtension;
  WebGL2RenderingContext.prototype.getExtension = function (name) {
    const ext = getExtension.call(this, name);
    if (name === "WEBGL_multi_draw" && ext !== null) {
      const proto = Object.getPrototypeOf(ext);
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key.startsWith("multiDraw"))
          proto[key] = () => { window.__benchDraws++; };
      }
    }
    return ext;
  };
})();
"""

JS_RENDER_FRAMES = """
(n) => new Promise((resolve) => {
  const tick = () => {
    if (n-- === 0) return resolve();
    window.__viserMutable.requestRender();
    requestAnimationFrame(tick);
  };
  tick();
})
"""


def run_scene(
    pw, name: str, profile_dir: Path | None, stub_draws: bool
) -> dict[str, float]:
    server = viser.ViserServer(port=0, verbose=False)
    handles = SCENES[name](server)
    is_gui = name == "gui"
    num_nodes = 0 if is_gui else len(handles)

    out: dict[str, float] = {}
    browser = pw.chromium.launch(
        executable_path=_chromium_executable(),
        args=["--enable-unsafe-swiftshader"],
    )
    try:
        page = browser.new_context(
            viewport={"width": 480, "height": 320}, device_scale_factor=1
        ).new_page()
        cdp = page.context.new_cdp_session(page)
        for domain in ("Performance", "Profiler", "HeapProfiler"):
            cdp.send(f"{domain}.enable")
        if stub_draws:
            page.add_init_script(JS_STUB_DRAWS)
        meter = Meter(page, cdp, profile_dir)

        # --- Load.
        start = time.perf_counter()
        meter.start()
        page.goto(f"http://localhost:{server.get_port()}")
        page.wait_for_function(
            f"""() => {{
              const m = window.__viserMutable;
              return m && Object.keys(m.nodePoseData).length >= {num_nodes + 1}
                && document.querySelectorAll('.mantine-Slider-root').length
                   >= {len(handles) if is_gui else 0};
            }}""",
            timeout=60_000,
            polling=20,
        )
        out["load_s"] = time.perf_counter() - start
        meter.settle()
        out["load_task_s"] = meter.stop(f"{name}.load")
        out["heap_mb"] = meter.heap_mb()
        out["rss_mb"] = renderer_rss_mb()

        # --- Render (camera motion etc).
        page.evaluate(JS_RENDER_FRAMES, 10)
        draws = page.evaluate("window.__benchDraws") if stub_draws else 0
        meter.start()
        page.evaluate(JS_RENDER_FRAMES, 60)
        out["render_60_frames_task_s"] = meter.stop(f"{name}.render")
        if stub_draws:
            out["draws_per_frame"] = (page.evaluate("window.__benchDraws") - draws) / 60
        meter.settle()

        # --- Stream updates to 10% of the scene.
        subset = handles[::10]
        meter.start()
        for t in range(60):
            with server.atomic():
                for i, h in enumerate(subset):
                    if is_gui:
                        h.value = (t + 1) / 100
                    else:
                        x, y, _ = _pos(i * 10)
                        h.position = (x, y, 0.01 * (t + 1))
            time.sleep(1 / 30)
        meter.settle()
        out["stream_60_steps_task_s"] = meter.stop(f"{name}.stream")

        if not is_gui:
            # --- Toggle the visibility of everything.
            root = server.scene.get_handle_by_name("/bench")
            assert root is not None
            meter.start()
            for visible in (False, True, False, True):
                root.visible = visible
                page.wait_for_timeout(300)
            meter.settle()
            out["visibility_4x_task_s"] = meter.stop(f"{name}.visibility")

            if name == "clickable":
                meter.start()
                for i in range(40):
                    page.mouse.move(60 + i * 5, 160 + i)
                    page.wait_for_timeout(16)
                out["pointer_40_moves_task_s"] = meter.stop(f"{name}.pointer")
                meter.settle()

        # --- Remove everything.
        meter.start()
        if is_gui:
            server.gui.reset()
        else:
            server.scene.remove_by_name("/bench")
        meter.settle()
        out["remove_task_s"] = meter.stop(f"{name}.remove")
        out["heap_after_remove_mb"] = meter.heap_mb()
    finally:
        browser.close()
        server.stop()
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenes", default=",".join(SCENES))
    parser.add_argument("--out", default=None)
    parser.add_argument("--profile", type=Path, default=None)
    parser.add_argument("--draw", action="store_true")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"))
    args = parser.parse_args()
    if args.compare:
        compare(*args.compare)
        return

    results: dict[str, dict[str, float]] = {}
    with sync_playwright() as pw:
        for name in args.scenes.split(","):
            runs = [
                run_scene(pw, name, args.profile, not args.draw)
                for _ in range(args.repeats)
            ]
            results[name] = {k: min(r[k] for r in runs) for k in runs[0]}
            print(
                f"{name:16s} "
                + "  ".join(f"{k}={v:.3g}" for k, v in results[name].items()),
                flush=True,
            )
            if args.out:
                Path(args.out).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
