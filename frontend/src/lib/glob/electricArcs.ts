import * as THREE from 'three';
import type { NeuralNode } from './nodes';

const MAX_ARCS_IDLE = 12;
const MAX_ARCS_ACTIVE = 24;
const ARC_SEGMENTS = 8;
const ARC_LIFETIME = 0.4;
const SPAWN_RATE_IDLE = 0.08;
const SPAWN_RATE_ACTIVE = 0.04;
const MAX_DISTANCE = 0.6;

export interface ElectricArc {
  sourceId: number;
  targetId: number;
  life: number;
  maxLife: number;
  active: boolean;
  offsets: Float32Array;
}

export interface ElectricArcSystem {
  arcs: ElectricArc[];
  lineSegments: THREE.LineSegments;
  material: THREE.ShaderMaterial;
  positions: Float32Array;
  alphas: Float32Array;
  spawnTimer: number;
}

function generateArcOffsets(): Float32Array {
  const offsets = new Float32Array(ARC_SEGMENTS * 3);
  for (let i = 1; i < ARC_SEGMENTS - 1; i++) {
    offsets[i * 3] = (Math.random() - 0.5) * 0.06;
    offsets[i * 3 + 1] = (Math.random() - 0.5) * 0.06;
    offsets[i * 3 + 2] = (Math.random() - 0.5) * 0.06;
  }
  return offsets;
}

export function createElectricArcSystem(color: THREE.Color): ElectricArcSystem {
  const arcs: ElectricArc[] = [];
  const vertexCount = MAX_ARCS_ACTIVE * ARC_SEGMENTS * 2;
  const positions = new Float32Array(vertexCount * 3);
  const alphas = new Float32Array(vertexCount);

  for (let i = 0; i < MAX_ARCS_ACTIVE; i++) {
    arcs.push({
      sourceId: 0,
      targetId: 0,
      life: 0,
      maxLife: ARC_LIFETIME,
      active: false,
      offsets: generateArcOffsets()
    });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        vec3 color = mix(uColor, vec3(1.0), 0.6);
        gl_FragColor = vec4(color, vAlpha);
      }
    `,
    uniforms: {
      uColor: { value: color }
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  const lineSegments = new THREE.LineSegments(geometry, material);

  return { arcs, lineSegments, material, positions, alphas, spawnTimer: 0 };
}

function findRandomNearbyPair(nodes: NeuralNode[]): { source: number; target: number } | null {
  const attempts = 20;
  for (let a = 0; a < attempts; a++) {
    const i = Math.floor(Math.random() * nodes.length);
    const j = Math.floor(Math.random() * nodes.length);
    if (i === j) continue;

    const dx = nodes[i].position.x - nodes[j].position.x;
    const dy = nodes[i].position.y - nodes[j].position.y;
    const dz = nodes[i].position.z - nodes[j].position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < MAX_DISTANCE && dist > 0.05) {
      return { source: i, target: j };
    }
  }
  return null;
}

export function updateElectricArcs(
  system: ElectricArcSystem,
  nodes: NeuralNode[],
  deltaTime: number,
  isActive: boolean = false
): void {
  const maxArcs = isActive ? MAX_ARCS_ACTIVE : MAX_ARCS_IDLE;
  const spawnRate = isActive ? SPAWN_RATE_ACTIVE : SPAWN_RATE_IDLE;

  system.spawnTimer += deltaTime;

  if (system.spawnTimer >= spawnRate) {
    system.spawnTimer = 0;

    const slot = system.arcs.findIndex((a, i) => !a.active && i < maxArcs);
    if (slot !== -1) {
      const pair = findRandomNearbyPair(nodes);
      if (pair) {
        const arc = system.arcs[slot];
        arc.sourceId = pair.source;
        arc.targetId = pair.target;
        arc.life = 0;
        arc.maxLife = ARC_LIFETIME * (0.5 + Math.random() * 0.5);
        arc.active = true;
        arc.offsets = generateArcOffsets();

        nodes[pair.source].activity = Math.min(1.0, nodes[pair.source].activity + 0.5);
        nodes[pair.target].activity = Math.min(1.0, nodes[pair.target].activity + 0.5);
      }
    }
  }

  const posAttr = system.positions;
  const alphaAttr = system.alphas;
  let vertexIdx = 0;

  for (const arc of system.arcs) {
    if (!arc.active) {
      for (let s = 0; s < ARC_SEGMENTS * 2; s++) {
        posAttr[vertexIdx * 3] = 0;
        posAttr[vertexIdx * 3 + 1] = 0;
        posAttr[vertexIdx * 3 + 2] = 0;
        alphaAttr[vertexIdx] = 0;
        vertexIdx++;
      }
      continue;
    }

    arc.life += deltaTime;
    if (arc.life >= arc.maxLife) {
      arc.active = false;
      for (let s = 0; s < ARC_SEGMENTS * 2; s++) {
        posAttr[vertexIdx * 3] = 0;
        posAttr[vertexIdx * 3 + 1] = 0;
        posAttr[vertexIdx * 3 + 2] = 0;
        alphaAttr[vertexIdx] = 0;
        vertexIdx++;
      }
      continue;
    }

    const t = arc.life / arc.maxLife;
    const fadeIn = Math.min(1.0, t * 5.0);
    const fadeOut = 1.0 - Math.max(0.0, (t - 0.5) * 2.0);
    const globalAlpha = fadeIn * fadeOut;

    const src = nodes[arc.sourceId].position;
    const tgt = nodes[arc.targetId].position;

    const points: THREE.Vector3[] = [];
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      const frac = i / (ARC_SEGMENTS - 1);
      const x = src.x + (tgt.x - src.x) * frac + arc.offsets[i * 3] * (1.0 - Math.abs(frac - 0.5) * 2.0);
      const y = src.y + (tgt.y - src.y) * frac + arc.offsets[i * 3 + 1] * (1.0 - Math.abs(frac - 0.5) * 2.0);
      const z = src.z + (tgt.z - src.z) * frac + arc.offsets[i * 3 + 2] * (1.0 - Math.abs(frac - 0.5) * 2.0);
      points.push(new THREE.Vector3(x, y, z));
    }

    for (let s = 0; s < ARC_SEGMENTS - 1; s++) {
      const p0 = points[s];
      const p1 = points[s + 1];

      posAttr[vertexIdx * 3] = p0.x;
      posAttr[vertexIdx * 3 + 1] = p0.y;
      posAttr[vertexIdx * 3 + 2] = p0.z;
      alphaAttr[vertexIdx] = globalAlpha * (0.6 + Math.random() * 0.4);
      vertexIdx++;

      posAttr[vertexIdx * 3] = p1.x;
      posAttr[vertexIdx * 3 + 1] = p1.y;
      posAttr[vertexIdx * 3 + 2] = p1.z;
      alphaAttr[vertexIdx] = globalAlpha * (0.6 + Math.random() * 0.4);
      vertexIdx++;
    }
  }

  // CPU buffers above ARE the geometry attributes — only flag for upload
  system.lineSegments.geometry.getAttribute('position')!.needsUpdate = true;
  system.lineSegments.geometry.getAttribute('aAlpha')!.needsUpdate = true;
}
