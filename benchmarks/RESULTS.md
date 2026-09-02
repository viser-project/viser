# Reference results

Recorded with `run_bench.py` on a 4-core container, headless chromium with
SwiftShader (software WebGL), 1280x720 @ DPR 1, default scene (250 coordinate
frames, 50 meshes, 50k-point cloud, ~100 GUI controls), 10 s steady state.
Absolute numbers are machine-specific; the before/after ratios are the point.

Software GL makes each `gl.render` expensive (~80-150 ms here), so on this
box the render count dominates main-thread busy time. On a real GPU the same
changes translate into freed CPU time and fewer draw calls per frame rather
than raw FPS.

| step | mode | load (s) | GL renders/s | draw calls/render | main-thread busy | script (s/10 s) |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | idle | 2.04 | 6.5 | 235 | 109% | 0.68 |
| baseline | orbit | 1.69 | 3.8 | 673 | 115% | 0.66 |
| baseline | gui | 1.73 | 6.1 | 235 | 107% | 1.11 |
| baseline | scene | 1.66 | 6.3 | 233 | 107% | 0.93 |
| 1: frames + tree | idle | 1.09 | 12.2 | 203 | 105% | 0.30 |
| 1: frames + tree | orbit | 1.00 | 6.5 | 297 | 108% | 0.26 |
| 1: frames + tree | scene | 0.96 | 10.8 | 203 | 105% | 0.36 |
| 2: on-demand render | idle | 0.96 | 1.1 | 203 | 12% | 0.05 |
| 2: on-demand render | orbit | 0.97 | 6.3 | 293 | 108% | 0.27 |
| 2: on-demand render | gui | 0.98 | 11.4 | 203 | 105% | 0.70 |
| 2: on-demand render | scene | 0.98 | 11.0 | 203 | 105% | 0.37 |
| 3: GUI batches bypass loop | idle | 1.01 | 1.2 | 203 | 15% | 0.07 |
| 3: GUI batches bypass loop | gui | 1.12 | 1.3 | 203 | 33% | 0.79 |
| 4: base64 loader | idle | 1.00 | 1.0 | 203 | 19% | 0.03 |
| final (all steps) | idle | 1.10* | 1.3 | 203 | 20% | 0.10 |
| final (all steps) | orbit | 1.19 | 5.0 | 422** | 113% | 0.29 |
| final (all steps) | gui | 1.13 | 1.2 | 203 | 39% | 1.02 |
| final (all steps) | scene | 1.10 | 9.8 | 203 | 105% | 0.50 |

\* first browser launch after a cold start measured 1.95 s; the other modes
in the same run loaded in 1.1-1.2 s.
\*\* orbit draw calls depend on where in the orbit the sample lands (the
whole 250-frame grid is in view for part of it); 293-422 across runs, vs 673
at baseline.

Reading the table:

- **Step 1** (merged coordinate-frame geometry, no per-node fiber traversal,
  selector-based `useThree`): load time halves, orbit draw calls drop 2.3x,
  per-frame script time drops ~2x. Renders/s go *up* because each frame got
  cheaper; the loop was still continuous.
- **Step 2** (`frameloop="demand"`): a static scene costs the 1 Hz heartbeat.
  Streaming modes are unchanged by design: 30 Hz of scene/camera updates
  needs 30 Hz of frames (capped by SwiftShader here).
- **Step 3** (GUI-only batches applied outside the frame loop, memoized
  markdown, contained progress bar): GUI streaming no longer renders the 3D
  scene. Layout count rises in `gui` mode only because every batch is now
  applied promptly instead of being throttled by the render loop.
- **Step 4** (native base64 loader): decode is ~25-40 ms → a few ms on desktop
  (below the resolution of the load metric here, which is dominated by scene
  construction); gzipped `index.html` shrinks by ~8 KB.
