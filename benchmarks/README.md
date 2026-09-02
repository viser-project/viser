# viser client benchmarks

Headless-chromium performance harness for the viser web client.

## Layout

- `bench_scene.py` — a viser server hosting a deliberately heavy scene
  (~250 coordinate frames, 50 meshes, a 50k point cloud) and a heavy GUI
  (~100 controls + markdown + progress bar). Supports streaming modes.
- `run_bench.py` — spawns the server, drives the **built** client with
  Playwright headless chromium, and records metrics per mode.
- `results/<label>/<mode>.json` — metrics; `<mode>.cpuprofile` — V8 CPU
  profile, loadable in Chrome DevTools (Performance → Load profile).

## Modes

| mode  | what happens after load                                   |
| ----- | --------------------------------------------------------- |
| idle  | nothing; measures steady-state cost of a static scene     |
| orbit | server orbits the client camera at ~30 Hz                 |
| gui   | GUI-only updates (slider/progress/markdown) at ~30 Hz     |
| scene | pose updates streamed to 50 frames at ~30 Hz              |

## Metrics recorded

- Scene load time (navigation → all scene nodes mounted) and long tasks
  during load.
- rAF rate: fps + frame-interval mean/p50/p95/p99/max.
- WebGL renders/s, draw calls / triangles / programs per render
  (via the `window.__viserTestpoints.rendererInfo` e2e hook).
- Main-thread busy % and script/layout/style durations (CDP Performance
  domain deltas).
- Long tasks (PerformanceObserver `longtask`) during steady state.
- Sampled V8 CPU profile + top-self-time summary.

## Running

```bash
# Build the client first (or pass --build):
cd src/viser/client && npm run build && cd -

python benchmarks/run_bench.py --mode all --label baseline --seconds 10
python benchmarks/run_bench.py --mode idle,gui --label after-fix
```

Notes:

- Headless chromium rasterizes WebGL with SwiftShader (CPU). GPU-bound
  numbers are pessimistic, but CPU-side costs (three.js/React/JS) — the
  usual viser bottlenecks — are representative, and the harness is
  intended for before/after comparisons on the same machine.
- `results/` is gitignored except for checked-in reference summaries.
