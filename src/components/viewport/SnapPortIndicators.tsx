import { Html } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { computeInstanceWorldPorts } from '../../engine/snapEngine';
import { resolveViewportTheme } from '../../engine/viewportTheme';
import type {
  ComponentDefinition,
  SceneNodeInstance,
  SnapConnectionRecord,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

interface PortVisualItem {
  key: string;
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  role: 'InputPort' | 'OutputPort' | 'Bidirectional';
  isConnected: boolean;
  label: string;
}

const UP_Y = new THREE.Vector3(0, 1, 0);

export function SnapPortIndicators() {
  const showSnapPorts = useEditorStore((s) => s.scene.environment.showSnapPorts);
  const viewportTheme = useEditorStore(
    (s) => s.scene.environment.viewportTheme ?? 'sketchup-white'
  );
  const customFloorColor = useEditorStore(
    (s) => s.scene.environment.customFloorColor ?? '#ffffff'
  );
  const inputPortColor = useMemo(
    () => resolveViewportTheme({ viewportTheme, customFloorColor }).inputPortColor,
    [viewportTheme, customFloorColor]
  );
  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);
  const snapConnections = useEditorStore((s) => s.scene.snapConnections);
  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const activeSnapPreview = useEditorStore((s) => s.activeSnapPreview);

  const portVisuals = useMemo<PortVisualItem[]>(() => {
    if (!showSnapPorts) return [];

    const catalogMap = new Map<string, ComponentDefinition>(
      library.map((c) => [c.id, c])
    );

    const connectedPortKeys = new Set<string>();
    snapConnections.forEach((conn: SnapConnectionRecord) => {
      connectedPortKeys.add(`${conn.sourceInstanceId}:${conn.sourcePortId}`);
      connectedPortKeys.add(`${conn.targetInstanceId}:${conn.targetPortId}`);
    });

    const items: PortVisualItem[] = [];

    for (const inst of instances as SceneNodeInstance[]) {
      if (!inst.visible) continue;
      const comp = catalogMap.get(inst.componentId);
      if (!comp || comp.snapPorts.length === 0) continue;

      const worldPorts = computeInstanceWorldPorts(
        inst.id,
        inst.name,
        inst.transform,
        comp
      );

      for (const wp of worldPorts) {
        const isConnected = connectedPortKeys.has(`${inst.id}:${wp.port.id}`);
        // Cone default tip points +Y; orient cone tip along flow direction:
        // OutputPort points outward (+worldNormal), InputPort points inward (-worldNormal)
        const dir =
          wp.port.role === 'InputPort'
            ? wp.worldNormal.clone().negate()
            : wp.worldNormal.clone();
        const quat = new THREE.Quaternion().setFromUnitVectors(UP_Y, dir.normalize());

        items.push({
          key: `${inst.id}:${wp.port.id}`,
          position: [wp.worldPosition.x, wp.worldPosition.y, wp.worldPosition.z],
          quaternion: quat,
          role: wp.port.role,
          isConnected,
          label: `${wp.port.name}`,
        });
      }
    }

    return items;
  }, [showSnapPorts, instances, library, snapConnections]);

  if (!showSnapPorts && !activeSnapPreview?.snapped) return null;

  return (
    <group name="SnapPortIndicatorsLayer">
      {portVisuals.map((item) => {
        const isSelectedOwner =
          selectedInstanceId !== null && item.key.startsWith(`${selectedInstanceId}:`);

        const color = item.isConnected
          ? '#10b981' // Emerald when magnetically mated
          : item.role === 'InputPort'
            ? inputPortColor // CAD Blue / Cyan for InputPort
            : item.role === 'OutputPort'
              ? '#f59e0b' // Industrial Amber for OutputPort
              : '#0ea5e9';

        return (
          <group key={item.key} position={item.position} quaternion={item.quaternion}>
            {/* Mating collar ring */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[item.isConnected ? 0.068 : 0.055, 0.011, 12, 24]} />
              <meshBasicMaterial color={color} toneMapped={false} />
            </mesh>

            {/* Directional flow cone */}
            {!item.isConnected && (
              <mesh position={[0, 0.055, 0]}>
                <coneGeometry args={[0.036, 0.09, 14]} />
                <meshBasicMaterial color={color} toneMapped={false} />
              </mesh>
            )}

            {/* Show compact port tag on the currently selected machine */}
            {isSelectedOwner && (
              <Html
                position={[0, 0.13, 0]}
                center
                zIndexRange={[20, 0]}
                style={{ pointerEvents: 'none' }}
              >
                <div className="vc-port-tag" data-connected={item.isConnected ? 'true' : 'false'}>
                  {item.isConnected ? 'LOCKED · ' : ''}
                  {item.label}
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* Live Magnetic Capture Beacon during Gizmo Drag */}
      {activeSnapPreview?.snapped && activeSnapPreview.snapWorldPosition && (
        <group position={activeSnapPreview.snapWorldPosition}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.09, 0.145, 32]} />
            <meshBasicMaterial
              color="#10b981"
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.042, 16, 16]} />
            <meshBasicMaterial color="#34d399" toneMapped={false} />
          </mesh>
          <Html
            position={[0, 0.24, 0]}
            center
            zIndexRange={[25, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div className="vc-snap-beacon-badge">
              MAGNETIC SNAP · {activeSnapPreview.sourcePort?.name} ⇄{' '}
              {activeSnapPreview.targetPort?.name}
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}
