# Measured performance (DoD-17)

Measured by `frontend/e2e/05-perf.spec.ts` on 2026-10-23T11:12:08.027Z.

| Item | Value |
|---|---|
| CPU | AMD Ryzen 7 5700U with Radeon Graphics |
| GPU / renderer | ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164C) Direct3D11 vs_5_0 ps_5_0, D3D11) |
| Quality | medium |
| Viewport | 1600x900 |
| Load | running at 60x with an active bearing-wear fault |
| Frame limiter / vsync | disabled (uncapped, so the figure is headroom) |
| Samples (fps) | 77.9, 73.7, 75 |
| **Minimum** | **73.7 fps** |

Notes: Medium disables image-based lighting and MSAA (each costs ~10 fps on this integrated GPU; High enables both and bloom). Quality auto-downgrades if the frame rate stays below 38 fps for three seconds.
