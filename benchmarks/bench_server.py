"""Server-side (Python) benchmarks.

Each case runs in its own subprocess, so peak memory and GC state don't leak
between cases. Websocket clients run in further subprocesses, so they don't
share the server's GIL.

    python benchmarks/bench_server.py                        # run everything
    python benchmarks/bench_server.py --cases replay_nodes   # subset
    python benchmarks/bench_server.py --out before.json
    python benchmarks/bench_server.py --compare before.json after.json

To benchmark another checkout with this harness:

    PYTHONPATH=/path/to/other/src python benchmarks/bench_server.py --out before.json

All metrics are "lower is better". ``*_s`` are wall-clock seconds, ``cpu_s`` is
process CPU time, and ``*_mb`` are megabytes.
"""

from __future__ import annotations

import argparse
import contextlib
import gc
import json
import os
import resource
import subprocess
import sys
import time
from typing import Callable, Iterator

import numpy as np

CASES: dict[str, Callable[[], dict[str, float]]] = {}


def case(fn: Callable[[], dict[str, float]]) -> Callable[[], dict[str, float]]:
    CASES[fn.__name__] = fn
    return fn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_server():
    import rich

    rich.print = lambda *args, **kwargs: None  # type: ignore
    import viser

    return viser.ViserServer(port=0, verbose=False)


def rss_mb() -> float:
    gc.collect()
    with open("/proc/self/statm") as f:
        return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e3


@contextlib.contextmanager
def timed(out: dict[str, float], name: str) -> Iterator[None]:
    start = time.perf_counter()
    cpu = time.process_time()
    yield
    out[f"{name}_s"] = time.perf_counter() - start
    out[f"{name}_cpu_s"] = time.process_time() - cpu


CLIENT_SCRIPT = r"""
import sys, time, struct
import zstandard
from websockets.sync.client import connect
import viser

port, until = int(sys.argv[1]), sys.argv[2].encode()
start = time.perf_counter()
with connect(
    f"ws://localhost:{port}", max_size=None, compression=None,
    subprotocols=[f"viser-v{viser.__version__}"],
) as ws:
    print("OPEN", flush=True)
    ttfb = None
    total = 0
    while True:
        data = ws.recv()
        if ttfb is None:
            ttfb = time.perf_counter() - start
        total += len(data)
        size, csize = struct.unpack("<QQ", data[:16])
        inner = zstandard.ZstdDecompressor().decompress(
            data[16:16 + csize], max_output_size=size)
        if until in inner:
            break
    print(time.perf_counter() - start, ttfb, total / 1e6, flush=True)
    # Stay connected (and draining) until the parent closes stdin.
    if len(sys.argv) > 3:
        sys.stdin.read()
"""


class Client:
    """Websocket client in a subprocess: drains until a payload containing
    ``until`` arrives."""

    def __init__(self, port: int, until: str = "ReplayDoneMessage") -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-c", CLIENT_SCRIPT, str(port), until],
            stdout=subprocess.PIPE,
            text=True,
        )
        assert self.proc.stdout is not None
        assert self.proc.stdout.readline().strip() == "OPEN"

    def wait(self) -> tuple[float, float, float]:
        """Returns (total seconds, time to first batch, megabytes)."""
        assert self.proc.stdout is not None
        total, ttfb, mb = map(float, self.proc.stdout.readline().split())
        self.proc.wait()
        return total, ttfb, mb


def replay(server, out: dict[str, float], name: str = "replay") -> None:
    cpu = time.process_time()
    total, _, _ = Client(server.get_port()).wait()
    out[f"{name}_s"] = total
    out[f"{name}_cpu_s"] = time.process_time() - cpu


# ---------------------------------------------------------------------------
# Scene construction
# ---------------------------------------------------------------------------


@case
def add_frames() -> dict[str, float]:
    """10k flat frames, no clients connected."""
    server = make_server()
    out: dict[str, float] = {}
    before = rss_mb()
    with timed(out, "add"):
        handles = [
            server.scene.add_frame(f"/frames/{i}", position=(float(i), 0.0, 0.0))
            for i in range(10_000)
        ]
    out["rss_mb"] = rss_mb() - before
    del handles
    return out


@case
def add_remove_nodes() -> dict[str, float]:
    """Remove 10k nodes one by one, then 10k through a parent cascade."""
    server = make_server()
    out: dict[str, float] = {}
    handles = [server.scene.add_frame(f"/a/{i}") for i in range(10_000)]
    with timed(out, "remove_each"):
        for h in handles:
            h.remove()
    parent = server.scene.add_frame("/b")
    for i in range(10_000):
        server.scene.add_frame(f"/b/{i}")
    with timed(out, "remove_cascade"):
        parent.remove()
    return out


@case
def replace_nodes() -> dict[str, float]:
    """Same-name replacement: the classic 're-add everything each step' loop."""
    server = make_server()
    out: dict[str, float] = {}
    with timed(out, "replace"):
        for _ in range(10):
            for i in range(1_000):
                server.scene.add_frame(f"/frames/{i}", position=(float(i), 0.0, 0.0))
    return out


@case
def add_large_arrays() -> dict[str, float]:
    """One 10M-point cloud and one 4M-triangle mesh, plus resident memory."""
    server = make_server()
    out: dict[str, float] = {}
    points = np.random.default_rng(0).uniform(-1, 1, (10_000_000, 3)).astype(np.float32)
    colors = np.zeros((10_000_000, 3), dtype=np.uint8)
    faces = np.zeros((4_000_000, 3), dtype=np.uint32)
    base = rss_mb()
    with timed(out, "add_points"):
        server.scene.add_point_cloud("/points", points, colors, precision="float32")
    with timed(out, "add_mesh"):
        server.scene.add_mesh_simple("/mesh", points, faces)
    out["rss_mb"] = rss_mb() - base
    out["peak_mb"] = peak_rss_mb() - base
    return out


# ---------------------------------------------------------------------------
# Streaming updates
# ---------------------------------------------------------------------------


@case
def pose_updates() -> dict[str, float]:
    """100k pose writes, no clients connected."""
    server = make_server()
    out: dict[str, float] = {}
    handles = [server.scene.add_frame(f"/f/{i}") for i in range(200)]
    wxyz = np.array([1.0, 0.0, 0.0, 0.0])
    with timed(out, "update"):
        for t in range(1, 251):
            wxyz[1] = t
            pos = (float(t), 0.0, 0.0)
            for h in handles:
                h.position = pos
                h.wxyz = wxyz
    return out


@case
def pose_stream_clients() -> dict[str, float]:
    """60 Hz x 300 frames x 8 clients, 3 s. CPU time for whole server."""
    server = make_server()
    out: dict[str, float] = {}
    handles = [server.scene.add_frame(f"/f/{i}") for i in range(300)]
    clients = [Client(server.get_port(), until="/stream_done") for _ in range(8)]
    time.sleep(0.5)
    start_cpu = time.process_time()
    start = time.perf_counter()
    for t in range(1, 181):
        with server.atomic():
            pos = (float(t), 0.0, 0.0)
            for h in handles:
                h.position = pos
        time.sleep(max(0.0, start + t / 60.0 - time.perf_counter()))
    out["stream_s"] = time.perf_counter() - start
    server.scene.add_frame("/stream_done")
    for c in clients:
        c.wait()
    out["drained_s"] = time.perf_counter() - start
    out["cpu_s"] = time.process_time() - start_cpu
    return out


@case
def prop_updates() -> dict[str, float]:
    """50k scalar prop writes + 200 1M-point array writes."""
    server = make_server()
    out: dict[str, float] = {}
    handles = [server.scene.add_box(f"/b/{i}") for i in range(100)]
    with timed(out, "scalar"):
        for t in range(500):
            color = (t % 255, 0, 0)
            for h in handles:
                h.color = color
    points = np.zeros((1_000_000, 3), dtype=np.float32)
    cloud = server.scene.add_point_cloud(
        "/points", points, (255, 0, 0), precision="float32"
    )
    with timed(out, "array"):
        for t in range(100):
            points[:] = t + 1
            cloud.points = points
    return out


@case
def gui() -> dict[str, float]:
    """Add 2k sliders, then 50k value writes, then remove everything."""
    server = make_server()
    out: dict[str, float] = {}
    with timed(out, "add"):
        with server.gui.add_folder("folder"):
            sliders = [
                server.gui.add_slider(
                    f"s{i}", min=0.0, max=1.0, step=0.001, initial_value=0.0
                )
                for i in range(2_000)
            ]
    with timed(out, "update"):
        for t in range(25):
            for s in sliders:
                s.value = (t + 1) / 100
    with timed(out, "remove"):
        server.gui.reset()
    return out


# ---------------------------------------------------------------------------
# Connecting clients
# ---------------------------------------------------------------------------


@case
def replay_nodes() -> dict[str, float]:
    """Connect to a scene with 20k frames."""
    server = make_server()
    out: dict[str, float] = {}
    for i in range(20_000):
        server.scene.add_frame(f"/f/{i}", position=(float(i), 0.0, 0.0))
    replay(server, out, "first")
    replay(server, out, "second")
    return out


@case
def replay_history() -> dict[str, float]:
    """Connect after a long animation: few live messages, but a message
    counter in the tens of millions (~1.5h of 60 Hz x 100 nodes)."""
    server = make_server()
    out: dict[str, float] = {}
    handles = [server.scene.add_frame(f"/f/{i}") for i in range(100)]
    buffer = server._websock_server._broadcast_buffer
    with buffer.buffer_lock:
        buffer.message_counter += 30_000_000
    for h in handles:
        h.position = (1.0, 2.0, 3.0)
    replay(server, out)
    return out


@case
def replay_many_arrays() -> dict[str, float]:
    """Connect to a scene with 400 x 1 MB meshes; peak memory matters."""
    server = make_server()
    out: dict[str, float] = {}
    verts = np.random.default_rng(0).uniform(size=(50_000, 3)).astype(np.float32)
    faces = np.arange(99_999, dtype=np.uint32).reshape(-1, 3) % 50_000
    for i in range(400):
        server.scene.add_mesh_simple(f"/m/{i}", verts, faces)
    base = rss_mb()
    replay(server, out)
    out["peak_extra_mb"] = peak_rss_mb() - base
    return out


@case
def live_latency_during_replay() -> dict[str, float]:
    """How long the event loop is unresponsive while a large scene replays."""
    import asyncio

    server = make_server()
    out: dict[str, float] = {}
    for i in range(20_000):
        server.scene.add_frame(f"/f/{i}", position=(float(i), 0.0, 0.0))
    loop = server._event_loop
    gaps: list[float] = []

    async def heartbeat() -> None:
        last = time.perf_counter()
        while True:
            await asyncio.sleep(0.001)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    task = asyncio.run_coroutine_threadsafe(heartbeat(), loop)
    time.sleep(0.2)
    gaps.clear()
    Client(server.get_port()).wait()
    task.cancel()
    out["max_stall_s"] = max(gaps)
    return out


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


@case
def incoming() -> dict[str, float]:
    """Deserialize 50k camera messages."""
    import msgspec

    from viser import _messages

    out: dict[str, float] = {}
    payload = msgspec.msgpack.encode(
        {
            "type": "ViewerCameraMessage",
            "wxyz": [1.0, 0.0, 0.0, 0.0],
            "position": [0.0, 1.0, 2.0],
            "fov": 1.0,
            "near": 0.1,
            "far": 100.0,
            "look_at": [0.0, 0.0, 0.0],
            "up_direction": [0.0, 0.0, 1.0],
            "image_height": 1080,
            "image_width": 1920,
        }
    )
    _messages.Message.deserialize(payload)
    with timed(out, "deserialize"):
        for _ in range(50_000):
            _messages.Message.deserialize(payload)
    return out


@case
def record_scene() -> dict[str, float]:
    """Serialize a 10k-node scene to a .viser payload."""
    server = make_server()
    out: dict[str, float] = {}
    for i in range(10_000):
        server.scene.add_frame(f"/f/{i}", position=(float(i), 0.0, 0.0))
    with timed(out, "serialize"):
        server.get_scene_serializer().serialize()
    return out


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def run_all(names: list[str], repeats: int) -> dict[str, dict[str, float]]:
    results: dict[str, dict[str, float]] = {}
    for name in names:
        runs = []
        for _ in range(repeats):
            proc = subprocess.run(
                [sys.executable, os.path.abspath(__file__), "--run-one", name],
                check=False,
                stdout=subprocess.PIPE,
                text=True,
            )
            if proc.returncode != 0:
                print(f"{name}: FAILED", flush=True)
                break
            runs.append(json.loads(proc.stdout.strip().splitlines()[-1]))
        if not runs:
            continue
        # Minimum over repeats: the least noise-contaminated estimate.
        results[name] = {k: min(r[k] for r in runs) for k in runs[0]}
        print(
            f"{name:28s} "
            + "  ".join(f"{k}={v:.4g}" for k, v in results[name].items()),
            flush=True,
        )
    return results


def compare(before_path: str, after_path: str) -> None:
    with open(before_path) as f:
        before = json.load(f)
    with open(after_path) as f:
        after = json.load(f)
    print(f"| {'case':40s} | {'before':>10s} | {'after':>10s} | {'ratio':>7s} |")
    print(f"|{'-' * 42}|{'-' * 11}:|{'-' * 11}:|{'-' * 8}:|")
    for name in before:
        for k, b in before[name].items():
            a = after.get(name, {}).get(k)
            if a is None:
                continue
            ratio = b / a if a else float("inf")
            print(f"| {name + '.' + k:40s} | {b:10.4g} | {a:10.4g} | {ratio:6.1f}x |")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", default=",".join(CASES))
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--out", default=None)
    parser.add_argument("--run-one", default=None)
    parser.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"))
    args = parser.parse_args()
    if args.compare:
        compare(*args.compare)
    elif args.run_one:
        out = CASES[args.run_one]()
        print(json.dumps(out), flush=True)
        os._exit(0)
    else:
        results = run_all(args.cases.split(","), args.repeats)
        if args.out:
            with open(args.out, "w") as f:
                json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
