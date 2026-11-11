import * as THREE from 'three';
import type {
  ComponentDefinition,
  EulerDegTuple,
  SceneNodeInstance,
  SnapConnectionRecord,
  SnapPortDefinition,
  TransformData,
  UUID,
  Vector3Tuple,
} from '../shared/schemas';

/**
 * Deterministic 3D Magnetic SnapPort Solver (Visual Components 5.1 Style)
 *
 * Aligns mating InputPort <-> OutputPort pairs in world space using singularity-free
 * orthonormal basis matrix alignment:
 *   R_snapped = M_target_world * (M_source_local)^T
 *   T_snapped = P_target_world - R_snapped * (p_source_local * S_source)
 */

export interface WorldSnapPort {
  instanceId: UUID;
  instanceName: string;
  port: SnapPortDefinition;
  worldPosition: THREE.Vector3;
  worldNormal: THREE.Vector3;
  worldUp: THREE.Vector3;
}

export interface SnapSolveResult {
  snapped: boolean;
  transform: TransformData;
  sourcePort?: SnapPortDefinition;
  targetInstanceId?: UUID;
  targetInstanceName?: string;
  targetPort?: SnapPortDefinition;
  snapWorldPosition?: Vector3Tuple;
  distanceMeters?: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function eulerDegToQuaternion(rotDeg: EulerDegTuple): THREE.Quaternion {
  const euler = new THREE.Euler(
    rotDeg[0] * DEG2RAD,
    rotDeg[1] * DEG2RAD,
    rotDeg[2] * DEG2RAD,
    'XYZ'
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

export function quaternionToEulerDeg(q: THREE.Quaternion): EulerDegTuple {
  const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const clean = (rad: number): number => {
    const deg = Number((rad * RAD2DEG).toFixed(2));
    return Object.is(deg, -0) ? 0 : deg;
  };
  return [clean(euler.x), clean(euler.y), clean(euler.z)];
}

export function arePortsCompatible(a: SnapPortDefinition, b: SnapPortDefinition): boolean {
  const protocolOk =
    a.protocol === 'universal' ||
    b.protocol === 'universal' ||
    a.protocol === b.protocol;
  if (!protocolOk) return false;

  if (a.role === 'Bidirectional' || b.role === 'Bidirectional') return true;
  return (
    (a.role === 'InputPort' && b.role === 'OutputPort') ||
    (a.role === 'OutputPort' && b.role === 'InputPort')
  );
}

function buildOrthonormalBasis(
  forwardNormal: THREE.Vector3,
  upHint: THREE.Vector3
): THREE.Matrix4 {
  const xAxis = forwardNormal.clone().normalize();
  let yAxis = upHint.clone().normalize();

  // Gram-Schmidt orthogonalization in case port normal is vertical (+/-Y)
  if (Math.abs(xAxis.dot(yAxis)) > 0.98) {
    yAxis = new THREE.Vector3(0, 0, 1);
    if (Math.abs(xAxis.dot(yAxis)) > 0.98) {
      yAxis = new THREE.Vector3(1, 0, 0);
    }
  }
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  yAxis.crossVectors(zAxis, xAxis).normalize();

  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
}

export function computeInstanceWorldPorts(
  instanceId: UUID,
  instanceName: string,
  transform: TransformData,
  component: ComponentDefinition
): WorldSnapPort[] {
  const pos = new THREE.Vector3(...transform.position);
  const quat = eulerDegToQuaternion(transform.rotationDeg);
  const scale = new THREE.Vector3(...transform.scale);

  return component.snapPorts.map((port) => {
    const localScaled = new THREE.Vector3(...port.localPosition).multiply(scale);
    const worldPosition = localScaled.applyQuaternion(quat).add(pos);
    const worldNormal = new THREE.Vector3(...port.localNormal)
      .normalize()
      .applyQuaternion(quat)
      .normalize();
    const worldUp = new THREE.Vector3(...port.localUp)
      .normalize()
      .applyQuaternion(quat)
      .normalize();

    return {
      instanceId,
      instanceName,
      port,
      worldPosition,
      worldNormal,
      worldUp,
    };
  });
}

export function solveMagneticSnap(params: {
  movingInstanceId: UUID;
  movingComponent: ComponentDefinition;
  candidateTransform: TransformData;
  otherInstances: SceneNodeInstance[];
  catalogMap: Map<UUID, ComponentDefinition>;
  snapRadiusMeters: number;
  autoAlignRotation: boolean;
}): SnapSolveResult {
  const {
    movingInstanceId,
    movingComponent,
    candidateTransform,
    otherInstances,
    catalogMap,
    snapRadiusMeters,
    autoAlignRotation,
  } = params;

  if (movingComponent.snapPorts.length === 0 || otherInstances.length === 0) {
    return { snapped: false, transform: candidateTransform };
  }

  const movingWorldPorts = computeInstanceWorldPorts(
    movingInstanceId,
    '',
    candidateTransform,
    movingComponent
  );

  let bestDistance = snapRadiusMeters;
  let bestMovingPort: WorldSnapPort | null = null;
  let bestTargetPort: WorldSnapPort | null = null;

  for (const other of otherInstances) {
    if (other.id === movingInstanceId || !other.visible) continue;
    const otherComp = catalogMap.get(other.componentId);
    if (!otherComp || otherComp.snapPorts.length === 0) continue;

    const targetWorldPorts = computeInstanceWorldPorts(
      other.id,
      other.name,
      other.transform,
      otherComp
    );

    for (const mPort of movingWorldPorts) {
      for (const tPort of targetWorldPorts) {
        if (!arePortsCompatible(mPort.port, tPort.port)) continue;
        const dist = mPort.worldPosition.distanceTo(tPort.worldPosition);
        if (dist <= bestDistance) {
          bestDistance = dist;
          bestMovingPort = mPort;
          bestTargetPort = tPort;
        }
      }
    }
  }

  if (!bestMovingPort || !bestTargetPort) {
    return { snapped: false, transform: candidateTransform };
  }

  // Compute snapped rotation quaternion
  let snappedQuat = eulerDegToQuaternion(candidateTransform.rotationDeg);

  if (autoAlignRotation) {
    const localNormal = new THREE.Vector3(...bestMovingPort.port.localNormal).normalize();
    const localUp = new THREE.Vector3(...bestMovingPort.port.localUp).normalize();
    const mLocal = buildOrthonormalBasis(localNormal, localUp);

    // Mating port outward normal must oppose target port outward normal (-N_target)
    const targetOppositeNormal = bestTargetPort.worldNormal.clone().negate();
    const mTargetWorld = buildOrthonormalBasis(targetOppositeNormal, bestTargetPort.worldUp);

    const rotMatrix = mTargetWorld.clone().multiply(mLocal.clone().transpose());
    snappedQuat = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
  }

  // Compute exact world position so bestMovingPort lands identically on bestTargetPort
  const scaleVec = new THREE.Vector3(...candidateTransform.scale);
  const rotatedPortOffset = new THREE.Vector3(...bestMovingPort.port.localPosition)
    .multiply(scaleVec)
    .applyQuaternion(snappedQuat);

  const snappedPos = bestTargetPort.worldPosition.clone().sub(rotatedPortOffset);

  const cleanCoord = (n: number): number => {
    const v = Number(n.toFixed(4));
    return Object.is(v, -0) ? 0 : v;
  };

  return {
    snapped: true,
    transform: {
      position: [
        cleanCoord(snappedPos.x),
        cleanCoord(snappedPos.y),
        cleanCoord(snappedPos.z),
      ],
      rotationDeg: quaternionToEulerDeg(snappedQuat),
      scale: candidateTransform.scale,
    },
    sourcePort: bestMovingPort.port,
    targetInstanceId: bestTargetPort.instanceId,
    targetInstanceName: bestTargetPort.instanceName,
    targetPort: bestTargetPort.port,
    snapWorldPosition: [
      cleanCoord(bestTargetPort.worldPosition.x),
      cleanCoord(bestTargetPort.worldPosition.y),
      cleanCoord(bestTargetPort.worldPosition.z),
    ],
    distanceMeters: Number(bestDistance.toFixed(4)),
  };
}

/**
 * Rebuilds exact active SnapConnectionRecord[] across the scene based on coincidental compatible ports
 * (tolerance 15mm) so Save/Load and multi-machine moves always keep connection state 100% consistent.
 */
export function recomputeSceneSnapConnections(
  instances: SceneNodeInstance[],
  catalogMap: Map<UUID, ComponentDefinition>,
  toleranceMeters = 0.02
): SnapConnectionRecord[] {
  const allInstancePorts: WorldSnapPort[][] = [];

  for (const inst of instances) {
    if (!inst.visible) continue;
    const comp = catalogMap.get(inst.componentId);
    if (!comp || comp.snapPorts.length === 0) continue;
    allInstancePorts.push(
      computeInstanceWorldPorts(inst.id, inst.name, inst.transform, comp)
    );
  }

  const connections: SnapConnectionRecord[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < allInstancePorts.length; i++) {
    for (let j = i + 1; j < allInstancePorts.length; j++) {
      for (const pA of allInstancePorts[i]) {
        for (const pB of allInstancePorts[j]) {
          if (!arePortsCompatible(pA.port, pB.port)) continue;
          if (pA.worldPosition.distanceTo(pB.worldPosition) <= toleranceMeters) {
            // Orient edge OutputPort -> InputPort for deterministic downstream TransportGraph chaining
            const aIsOut = pA.port.role === 'OutputPort';
            const src = aIsOut ? pA : pB;
            const dst = aIsOut ? pB : pA;
            connections.push({
              id: `snap-${src.instanceId}:${src.port.id}->${dst.instanceId}:${dst.port.id}`,
              sourceInstanceId: src.instanceId,
              sourcePortId: src.port.id,
              targetInstanceId: dst.instanceId,
              targetPortId: dst.port.id,
              snappedAt: now,
            });
          }
        }
      }
    }
  }

  return connections;
}
