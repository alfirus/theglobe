import * as THREE from 'three';

// ─── Configuration ───────────────────────────────────────────────────────────
const CLUSTER_COUNT = 18;
const NODES_PER_CLUSTER = 35;
const CORE_NODE_COUNT = 50;
const SPHERE_RADIUS = 1.0;
const CORE_RADIUS = 0.15;
const CLUSTER_SPREAD = 0.15;
const CLUSTER_JITTER = 0.05;

export const TOTAL_NODE_COUNT = CLUSTER_COUNT * NODES_PER_CLUSTER + CORE_NODE_COUNT; // 680

// ─── Interfaces ──────────────────────────────────────────────────────────────
export interface NeuralNode {
  id: number;
  position: THREE.Vector3;       // Current position (breathing modifies this)
  basePosition: THREE.Vector3;   // Original position (never changes)
  cluster: number;               // Which cluster this node belongs to (-1 = core)
  importance: number;            // 0-1, determines size/brightness
  activity: number;              // 0-1, driven by neuralActivity.ts
  phase: number;                 // For breathing animation
  isCore: boolean;               // True for center nodes
}

export interface NodeSystem {
  nodes: NeuralNode[];
  positions: Float32Array;       // Flat position buffer for GPU
  brightnesses: Float32Array;    // Flat brightness buffer for GPU
  activities: Float32Array;      // Flat activity buffer for GPU
  phases: Float32Array;          // Flat phase buffer for GPU
  count: number;
}

// ─── Fibonacci Sphere (for cluster center positions) ─────────────────────────
function fibonacciSphere(n: number, radius: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const goldenRatio = (1 + Math.sqrt(5)) / 2;

  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / goldenRatio;
    const phi = Math.acos(1 - (2 * (i + 0.5)) / n);

    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi);

    points.push(new THREE.Vector3(x, y, z));
  }

  return points;
}

// ─── Node Generation ─────────────────────────────────────────────────────────
export function createNodeSystem(): NodeSystem {
  const nodes: NeuralNode[] = [];
  let id = 0;

  // 1. Generate cluster center positions using fibonacci sphere
  const clusterCenters = fibonacciSphere(CLUSTER_COUNT, SPHERE_RADIUS);

  // 2. Generate nodes within each cluster
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const center = clusterCenters[c];

    for (let n = 0; n < NODES_PER_CLUSTER; n++) {
      // Random position within cluster spread
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * CLUSTER_SPREAD * 2,
        (Math.random() - 0.5) * CLUSTER_SPREAD * 2,
        (Math.random() - 0.5) * CLUSTER_SPREAD * 2
      );

      // Add small jitter
      offset.x += (Math.random() - 0.5) * CLUSTER_JITTER;
      offset.y += (Math.random() - 0.5) * CLUSTER_JITTER;
      offset.z += (Math.random() - 0.5) * CLUSTER_JITTER;

      const basePos = center.clone().add(offset);

      // Project back onto sphere surface (keep it on the globe)
      basePos.normalize().multiplyScalar(SPHERE_RADIUS);

      // Add slight depth variation (0.92 to 1.08)
      const depthVar = 0.92 + Math.random() * 0.16;
      basePos.multiplyScalar(depthVar);

      const importance = 0.5 + Math.random() * 0.5;
      const phase = Math.random() * Math.PI * 2;

      nodes.push({
        id,
        position: basePos.clone(),
        basePosition: basePos.clone(),
        cluster: c,
        importance,
        activity: 0,
        phase,
        isCore: false
      });

      id++;
    }
  }

  // 3. Generate core nodes at center
  const coreCenter = new THREE.Vector3(0, 0, 0);
  for (let n = 0; n < CORE_NODE_COUNT; n++) {
    // Random position within core radius
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = Math.random() * CORE_RADIUS;

    const basePos = new THREE.Vector3(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi)
    );

    const importance = 0.7 + Math.random() * 0.3; // Core nodes are important
    const phase = Math.random() * Math.PI * 2;

    nodes.push({
      id,
      position: basePos.clone(),
      basePosition: basePos.clone(),
      cluster: -1, // Core cluster
      importance,
      activity: 0.4 + Math.random() * 0.3,
      phase,
      isCore: true
    });

    id++;
  }

  // 4. Build GPU buffers
  const count = nodes.length;
  const positions = new Float32Array(count * 3);
  const brightnesses = new Float32Array(count);
  const activities = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    positions[i * 3] = node.position.x;
    positions[i * 3 + 1] = node.position.y;
    positions[i * 3 + 2] = node.position.z;
    brightnesses[i] = node.importance;
    activities[i] = node.activity;
    phases[i] = node.phase;
  }

  return { nodes, positions, brightnesses, activities, phases, count };
}

// ─── Update (breathing animation — minimal) ──────────────────────────────────
export function updateNodes(system: NodeSystem, time: number): void {
  const posAttr = system.positions;
  const actAttr = system.activities;

  for (let i = 0; i < system.count; i++) {
    const node = system.nodes[i];

    // Minimal breathing — NOT position perturbation
    const breathing = Math.sin(time * 0.8 + node.phase) * 0.003;
    node.position.copy(node.basePosition).multiplyScalar(1 + breathing);

    // Update GPU buffers
    posAttr[i * 3] = node.position.x;
    posAttr[i * 3 + 1] = node.position.y;
    posAttr[i * 3 + 2] = node.position.z;

    // Activity drives brightness
    actAttr[i] = node.activity;
  }
}

// ─── Geometry Creation ───────────────────────────────────────────────────────
export function createNodeGeometry(system: NodeSystem): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(system.positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(system.phases, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(system.brightnesses, 1));
  geometry.setAttribute('aActivity', new THREE.BufferAttribute(system.activities, 1));

  return geometry;
}

// ─── Shaders ─────────────────────────────────────────────────────────────────
export const nodeVertexShader = `
uniform float uTime;
uniform float uBrightness;
uniform float uActivityBoost;
uniform float uAudioBass;

attribute float aPhase;
attribute float aBrightness;
attribute float aActivity;

varying float vBrightness;
varying float vPhase;
varying float vActivity;

void main() {
  vPhase = aPhase;
  vActivity = aActivity;
  
  // Breathing is minimal — driven by position buffer, not shader.
  // aPhase is stored in radians, so no second 2π conversion here.
  float breathe = sin(uTime * 0.8 + aPhase) * 0.15 + 0.85;
  
  float activityBoost = (0.5 + aActivity * 2.0) * (1.0 + uActivityBoost);
  vBrightness = aBrightness * breathe * uBrightness * activityBoost;
  
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  
  // Bass drives point size — bigger motion for low frequencies
  float sizeBase = 1.8 + aActivity * 2.0 + uAudioBass * 1.5;
  gl_PointSize = (sizeBase) * (280.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const nodeFragmentShader = `\
uniform vec3 uColor;
uniform float uTime;
uniform float uAudioMid;

varying float vBrightness;
varying float vPhase;
varying float vActivity;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float dist = length(uv);
  
  if (dist > 0.5) discard;
  
  float core = smoothstep(0.08, 0.0, dist);
  float halo = smoothstep(0.18, 0.05, dist);
  float intensity = core + halo * 0.08;
  
  // White-hot core for active nodes, colored for resting
  vec3 coreColor = vec3(1.0, 1.0, 1.0);
  vec3 edgeColor = uColor * 1.2;
  vec3 color = mix(edgeColor, coreColor, core);
  
  // Per-node color variation (vPhase is in radians, like CPU breathing)
  float colorShift = sin(uTime * 0.5 + vPhase) * 0.1;
  color.r += colorShift;
  color.b -= colorShift * 0.5;
  
  // Activity makes nodes brighter and more white
  color = mix(color, vec3(1.0), vActivity * 0.4);
  
  // Finding 5: mid-band audio adds warmth (amber tint) to the fragment —
  // this is the "warmth" effect claimed in the handoff summary.
  float warmth = uAudioMid * 0.3;
  color.r += warmth * 0.6;
  color.g += warmth * 0.4;
  
  gl_FragColor = vec4(color * intensity * vBrightness, intensity);
}
`;

export function createNodeMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: nodeVertexShader,
    fragmentShader: nodeFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uBrightness: { value: 0.9 },
      uColor: { value: color },
      uActivityBoost: { value: 0 },
      uAudioBass: { value: 0 },
      uAudioMid: { value: 0 }
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
}

// ─── Convenience: create everything ──────────────────────────────────────────
export function createNodes(color: THREE.Color): {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  system: NodeSystem;
} {
  const system = createNodeSystem();
  const geometry = createNodeGeometry(system);
  const material = createNodeMaterial(color);
  const points = new THREE.Points(geometry, material);

  return { points, material, system };
}
