"""Headless-chromium benchmark runner for the viser client.

Spawns ``bench_scene.py`` (a heavy viser server), drives the built client with
Playwright chromium, and records:

  * scene load time (connect -> all nodes mounted),
  * rAF rate (mean/percentile frame intervals),
  * main-thread busy time (CDP Performance domain deltas),
  * long tasks (PerformanceObserver "longtask"),
  * three.js draw calls / programs / triangles per frame,
  * a V8 CPU profile (.cpuprofile, loadable in Chrome DevTools) + top self-time
    summary.

Usage:

    python benchmarks/run_bench.py --mode idle --seconds 10
    python benchmarks/run_bench.py --mode all --label baseline

Results land in benchmarks/results/<label>/<mode>.json (+ .cpuprofile).

The client must be built (``npm run build`` in src/viser/client); the viser
server serves the build directory. Pass ``--build`` to (re)build first.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENT_DIR = REPO_ROOT / "src" / "viser" / "client"
RESULTS_DIR = Path(__file__).resolve().parent / "results"

INIT_SCRIPT = """
(() => {
  const bench = (window.__bench = {
    rafTimes: [],
    longTasks: [],
    rafRecording: false,
  });
  // rAF interval recorder: started on demand from the harness.
  bench.startRaf = () => {
    bench.rafTimes.length = 0;
    bench.rafRecording = true;
    const tick = (t) => {
      if (!bench.rafRecording) return;
      bench.rafTimes.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  bench.stopRaf = () => {
    bench.rafRecording = false;
  };
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        bench.longTasks.push({ start: e.startTime, duration: e.duration });
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (e) {}
})();
"""


def _chromium_executable() -> str | None:
    """Fall back to a system-provided chromium if playwright's is missing."""
    import os

    for candidate in (os.environ.get("BENCH_CHROMIUM"), "/opt/pw-browsers/chromium"):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def start_server(mode: str, port: int, args: argparse.Namespace) -> subprocess.Popen:
    proc = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve().parent / "bench_scene.py"),
            "--port",
            str(port),
            "--mode",
            mode,
            "--num-frames",
            str(args.num_frames),
            "--num-meshes",
            str(args.num_meshes),
            "--num-controls",
            str(args.num_controls),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    # Wait for the ready line.
    deadline = time.monotonic() + 60
    assert proc.stdout is not None
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if "BENCH_READY" in line:
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"bench server exited early:\\n{line}")
    raise RuntimeError("bench server did not become ready")


def get_perf_metrics(cdp) -> dict[str, float]:
    metrics = cdp.send("Performance.getMetrics")["metrics"]
    return {m["name"]: m["value"] for m in metrics}


def read_renderer_info(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const info = window.__viserTestpoints?.rendererInfo;
          if (!info) return null;
          return {
            frame: info.render.frame,
            calls: info.render.calls,
            triangles: info.render.triangles,
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            programs: info.programs?.length ?? null,
          };
        }"""
    )


def summarize_cpuprofile(profile: dict, top_n: int = 30) -> list[dict]:
    """Aggregate self time by function across the profile."""
    nodes = {n["id"]: n for n in profile["nodes"]}
    total_us = defaultdict(int)
    samples = profile.get("samples", [])
    deltas = profile.get("timeDeltas", [])
    for node_id, dt in zip(samples, deltas):
        node = nodes.get(node_id)
        if node is None:
            continue
        cf = node["callFrame"]
        url = cf.get("url", "")
        # Shorten bundle URLs.
        if "/" in url:
            url = url.rsplit("/", 1)[-1]
        key = (cf.get("functionName") or "(anonymous)", url, cf.get("lineNumber", -1))
        total_us[key] += max(dt, 0)
    rows = sorted(total_us.items(), key=lambda kv: -kv[1])[:top_n]
    total = sum(total_us.values()) or 1
    return [
        {
            "function": k[0],
            "url": k[1],
            "line": k[2],
            "self_ms": v / 1000,
            "self_pct": 100 * v / total,
        }
        for k, v in rows
    ]


def percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return float("nan")
    idx = min(len(sorted_vals) - 1, int(p / 100 * len(sorted_vals)))
    return sorted_vals[idx]


def run_mode(pw, mode: str, args: argparse.Namespace, out_dir: Path) -> dict:
    port = find_free_port()
    server = start_server(mode, port, args)
    result: dict = {"mode": mode, "config": vars(args) | {"port": port}}
    browser = None
    try:
        browser = pw.chromium.launch(
            headless=True,
            # Prefer the pre-installed chromium when the pinned playwright
            # download is absent (e.g. sandboxed CI images).
            executable_path=_chromium_executable(),
            args=[
                "--enable-unsafe-swiftshader",
                "--disable-features=CalculateNativeWinOcclusion",
            ],
        )
        # Small viewport: SwiftShader (software WebGL) raster cost scales with
        # pixel count and can drown out the JS/three.js costs we optimize.
        context = browser.new_context(
            viewport={"width": args.viewport_width, "height": args.viewport_height},
            device_scale_factor=1,
        )
        page = context.new_page()
        page.add_init_script(INIT_SCRIPT)
        errors: list[str] = []
        page.on(
            "console",
            lambda msg: errors.append(msg.text) if msg.type == "error" else None,
        )
        cdp = context.new_cdp_session(page)
        cdp.send("Performance.enable")
        cdp.send("Profiler.enable")
        cdp.send("Profiler.setSamplingInterval", {"interval": 250})

        # --- Load phase -------------------------------------------------
        # Profiled too: scene construction (message decode, React commits,
        # geometry/material creation, first renders) is what every user pays.
        cdp.send("Profiler.start")
        t_nav = time.monotonic()
        page.goto(f"http://localhost:{port}", wait_until="domcontentloaded")
        # Wait until every scene node has a mounted three.js object.
        expected_min_nodes = args.num_frames + args.num_meshes + 1
        page.wait_for_function(
            f"""() => {{
              const m = window.__viserMutable;
              return m && Object.keys(m.nodeRefFromName).length >= {expected_min_nodes};
            }}""",
            timeout=120_000,
        )
        load_s = time.monotonic() - t_nav
        load_profile = cdp.send("Profiler.stop")["profile"]
        (out_dir / f"{mode}.load.cpuprofile").write_text(json.dumps(load_profile))
        load_metrics = get_perf_metrics(cdp)
        result["load"] = {
            "nav_to_scene_mounted_s": load_s,
            "task_duration_s": load_metrics.get("TaskDuration", 0),
            "script_duration_s": load_metrics.get("ScriptDuration", 0),
            "cpu_top": summarize_cpuprofile(load_profile),
            "long_tasks_during_load": page.evaluate(
                "() => ({count: window.__bench.longTasks.length,"
                " total_ms: window.__bench.longTasks.reduce((a, t) => a + t.duration, 0),"
                " max_ms: window.__bench.longTasks.reduce((a, t) => Math.max(a, t.duration), 0)})"
            ),
        }

        # Let things settle before steady-state measurement.
        page.wait_for_timeout(3000)

        # --- Steady-state phase ----------------------------------------
        page.evaluate(
            "() => { window.__bench.longTasks.length = 0; window.__bench.startRaf(); }"
        )
        m0 = get_perf_metrics(cdp)
        info0 = read_renderer_info(page)
        cdp.send("Profiler.start")
        t0 = time.monotonic()
        page.wait_for_timeout(args.seconds * 1000)
        elapsed = time.monotonic() - t0
        profile = cdp.send("Profiler.stop")["profile"]
        m1 = get_perf_metrics(cdp)
        info1 = read_renderer_info(page)
        raf_times, long_tasks = page.evaluate(
            "() => { window.__bench.stopRaf();"
            " return [window.__bench.rafTimes, window.__bench.longTasks]; }"
        )

        intervals = sorted(
            raf_times[i + 1] - raf_times[i] for i in range(len(raf_times) - 1)
        )
        n = len(intervals)
        renders = (info1["frame"] - info0["frame"]) if info0 and info1 else None
        result["steady"] = {
            "elapsed_s": elapsed,
            "raf": {
                "frames": len(raf_times),
                "fps": (len(raf_times) - 1) / elapsed if len(raf_times) > 1 else 0,
                "interval_ms": {
                    "mean": sum(intervals) / n if n else None,
                    "p50": percentile(intervals, 50),
                    "p95": percentile(intervals, 95),
                    "p99": percentile(intervals, 99),
                    "max": intervals[-1] if n else None,
                },
            },
            "gl_renders": renders,
            "gl_renders_per_s": renders / elapsed if renders is not None else None,
            "draw_calls_per_render": info1["calls"] if info1 else None,
            "triangles_per_render": info1["triangles"] if info1 else None,
            "geometries": info1["geometries"] if info1 else None,
            "textures": info1["textures"] if info1 else None,
            "programs": info1["programs"] if info1 else None,
            "long_tasks": {
                "count": len(long_tasks),
                "total_ms": sum(t["duration"] for t in long_tasks),
            },
            "cdp_deltas": {
                k: m1.get(k, 0) - m0.get(k, 0)
                for k in (
                    "TaskDuration",
                    "ScriptDuration",
                    "LayoutDuration",
                    "RecalcStyleDuration",
                    "LayoutCount",
                    "RecalcStyleCount",
                    "JSHeapUsedSize",
                )
            },
            "main_thread_busy_pct": 100
            * (m1.get("TaskDuration", 0) - m0.get("TaskDuration", 0))
            / elapsed,
        }
        result["cpu_top"] = summarize_cpuprofile(profile)
        result["console_errors"] = errors[:20]

        (out_dir / f"{mode}.cpuprofile").write_text(json.dumps(profile))
    finally:
        if browser is not None:
            browser.close()
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        default="idle",
        help="idle | orbit | gui | scene | all (comma-separated ok)",
    )
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--label", default="run")
    parser.add_argument("--num-frames", type=int, default=250)
    parser.add_argument("--num-meshes", type=int, default=50)
    parser.add_argument("--num-controls", type=int, default=100)
    parser.add_argument("--build", action="store_true", help="npm run build first")
    parser.add_argument(
        "--profile-build",
        action="store_true",
        help="vite build WITHOUT minification first, so CPU profiles carry real "
        "function names (slower to load; for attribution, not for timing)",
    )
    parser.add_argument(
        "--load-top",
        type=int,
        default=0,
        help="print the top-N self-time functions of the load-phase profile",
    )
    parser.add_argument("--viewport-width", type=int, default=640)
    parser.add_argument("--viewport-height", type=int, default=400)
    args = parser.parse_args()

    if args.build:
        print("Building client...", flush=True)
        subprocess.run(
            ["npm", "run", "build"], cwd=CLIENT_DIR, check=True, capture_output=True
        )
    if args.profile_build:
        print("Building unminified client for profiling...", flush=True)
        subprocess.run(
            ["npx", "vite", "build", "--minify", "false"],
            cwd=CLIENT_DIR,
            check=True,
            capture_output=True,
        )

    modes = (
        ["idle", "orbit", "gui", "scene"]
        if args.mode == "all"
        else args.mode.split(",")
    )
    out_dir = RESULTS_DIR / args.label
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        for mode in modes:
            print(f"=== mode: {mode} ===", flush=True)
            result = run_mode(pw, mode, args, out_dir)
            (out_dir / f"{mode}.json").write_text(json.dumps(result, indent=2))
            s = result.get("steady", {})
            raf = s.get("raf", {})
            print(
                f"  load: {result['load']['nav_to_scene_mounted_s']:.2f}s"
                f" (long tasks: {result['load']['long_tasks_during_load']['total_ms']:.0f}ms,"
                f" script: {result['load']['script_duration_s']:.2f}s)\n"
                f"  fps: {raf.get('fps', 0):.1f}"
                f"  interval p50/p95/p99: {raf.get('interval_ms', {}).get('p50'):.1f}"
                f"/{raf.get('interval_ms', {}).get('p95'):.1f}"
                f"/{raf.get('interval_ms', {}).get('p99'):.1f} ms\n"
                f"  gl renders/s: {s.get('gl_renders_per_s'):.1f}"
                f"  draw calls/render: {s.get('draw_calls_per_render')}"
                f"  programs: {s.get('programs')}\n"
                f"  main-thread busy: {s.get('main_thread_busy_pct'):.1f}%"
                f"  script: {s.get('cdp_deltas', {}).get('ScriptDuration', 0):.2f}s"
                f"  layout count: {s.get('cdp_deltas', {}).get('LayoutCount')}\n"
                f"  long tasks: {s['long_tasks']['count']}"
                f" ({s['long_tasks']['total_ms']:.0f}ms)",
                flush=True,
            )
            if args.load_top > 0:
                print("  load-phase top self-time:")
                for row in result["load"]["cpu_top"][: args.load_top]:
                    print(
                        f"    {row['self_ms']:8.1f}ms {row['self_pct']:5.1f}%"
                        f"  {row['function']} ({row['url']}:{row['line']})"
                    )
            top = result["cpu_top"][:8]
            print("  top self-time:")
            for row in top:
                print(
                    f"    {row['self_ms']:8.1f}ms {row['self_pct']:5.1f}%"
                    f"  {row['function']} ({row['url']}:{row['line']})"
                )


if __name__ == "__main__":
    main()
