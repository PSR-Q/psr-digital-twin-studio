# VC Digital Twin Studio

**Standalone 3D Industrial Digital Twin & Virtual Commissioning Desktop Editor** inspired by Visual Components 5.1.

## Architecture (3-Tier Process Isolation)
1. **Renderer Process (`src/`):** React 19, Tailwind CSS v4, Zustand, React Three Fiber (R3F), `@react-three/drei`, Three.js.
2. **PLC & Cyclic Sync Worker (`electron/worker/`):** Dedicated Node.js `UtilityProcess` running deterministic 5ms–20ms scan loops.
3. **Zero-Overhead Binary IPC Bus (`src/shared/schemas/binaryIpcLayout.ts`):** Pre-allocated 4096-byte binary frames (`Uint8Array` / `DataView`) read directly inside R3F `useFrame` without triggering React re-renders.

## Milestone Roadmap
- [x] **Milestone 1:** Electron shell + Core TypeScript Schemas (`SceneSchema`, `ComponentDefinition`, `TransportGraph`, `PlcTagMap`, `BinaryIpcBufferLayout`) + R3F Viewport + `.glb` Loader + Magnetic `SnapPort` Docking + Scene `.json` Save/Load.
- [ ] **Milestone 2:** Component Builder UI + 1-Axis Linear/Rotary Forward Kinematics + Internal Signal Force Panel.
- [ ] **Milestone 3:** Spline Transport Graph + `FlowItem` Spawner/Accumulation + Path Sensors + Virtual HSC Encoder (`DINT` / `REAL`).
- [ ] **Milestone 4:** `UtilityProcess` Live PLC Adapters (S7-PLCSIM Advanced, GX Simulator3 3E MC, Omron/OPC UA) + Tag Binding Matrix UI.

## Local Development & Building `.exe` on Windows
```bash
npm install
npm run generate:glbs
npm run dev          # Launch interactive web workbench
npm run dist:win     # Package single standalone Windows Portable .exe in release/
```
