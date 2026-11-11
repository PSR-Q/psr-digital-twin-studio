# PSR Digital Twin Studio (`VC Digital Twin Studio`)

**Standalone 3D Industrial Digital Twin & Virtual Commissioning Desktop Editor** (`v0.4.0` — Complete Milestone 1–4 Suite).

- **Live 3D Cloud Web Preview:** https://psr-q.github.io/psr-digital-twin-studio/
- **Standalone Windows `.exe` Releases:** https://github.com/PSR-Q/psr-digital-twin-studio/releases

---

## Architecture (3-Tier Process Isolation)
1. **Renderer Process (`src/`):** React 19, Tailwind CSS v4, Zustand, React Three Fiber (R3F), `@react-three/drei`, Three.js (`glTF` `.glb`/`.gltf` + **OpenUSD** `.usd`/`.usda`/`.usdc`/`.usdz`).
2. **PLC & Cyclic Sync Worker (`electron/worker/`):** Dedicated Node.js `UtilityProcess` running deterministic `5ms–20ms` cyclic scan loops isolated from 60–144Hz WebGL rendering.
3. **Zero-Overhead Binary IPC Bus (`src/shared/schemas/binaryIpcLayout.ts`):** Pre-allocated 4,096-byte binary frames (`Uint8Array` / `DataView`) read directly inside R3F `useFrame` with zero React re-renders.

## Completed Milestone Roadmap
- [x] **Milestone 1:** Electron shell + Core TypeScript Schemas (`SceneSchema`, `ComponentDefinition`, `TransportGraph`, `PlcTagMap`, `BinaryIpcBufferLayout`) + R3F Viewport + `.glb` / OpenUSD Loader + Magnetic `SnapPort` Docking + Scene `.json` Save/Load.
- [x] **Milestone 2:** Component Builder UI + Sub-Mesh `LinearAxis` / `RotaryAxis` / `VisualEffect` (RPM belt drive) Forward Kinematics + Standalone Signal Force Console.
- [x] **Milestone 3:** Directed Spline Transport Graph + `FlowItem` Spawner & Zero-Jitter Stopper Accumulation + Sub-Frame `Photoelectric` / `Proximity` Sensors + Virtual HSC Encoder (`DINT` Pulses & `REAL` Servo Position/Velocity).
- [x] **Milestone 4:** `UtilityProcess` Live PLC Adapters (**Siemens S7-PLCSIM Advanced** RFC1006/S7Comm + SHM Hook, **Mitsubishi GX Simulator3** 3E Binary MC Protocol, **Omron Sysmac / CODESYS** OPC UA Binary TCP, **InternalSim**) + Full-Width I/O Tag Binding Matrix, 1-Click Vendor Auto-Addressing, Scale/Offset & CSV Import/Export.

## Local Development & Building `.exe` on Windows
```bash
npm install
npm run generate:glbs
npm run dev          # Launch interactive web workbench
npm run dist:win     # Package single standalone Windows Portable .exe in release/
```
