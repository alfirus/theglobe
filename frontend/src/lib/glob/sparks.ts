import * as THREE from 'three';
import type { NeuralSignal } from './neuralActivity';

// ─── Configuration ───────────────────────────────────────────────────────────
const MAX_SPARKS = 8; // Limited simultaneous sparks

// ─── Interfaces ──────────────────────────────────────────────────────────────
export interface SparkSystem {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  positions: Float32Array;
  progresses: Float32Array;
  actives: Float32Array;
  time: number;
}

// ─── Shaders ─────────────────────────────────────────────────────────────────
export const sparkVertexShader = `
uniform float uTime;

attribute float aProgress;
attribute float aActive;

varying float vProgress;
varying float vActive;

void main() {
  vProgress = aProgress;
  vActive = aActive;
  
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  
  // Size pulses at midpoint of travel
  float sizeFactor = sin(aProgress * 3.14159) * 2.0 + 2.0;
  gl_PointSize = sizeFactor * aActive * (300.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const sparkFragmentShader = `
uniform vec3 uCoreColor;
uniform vec3 uHaloColor;

varying float vProgress;
varying float vActive;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float dist = length(uv);
  
  if (dist > 0.5) discard;
  
  // Very bright white core
  float core = 1.0 - smoothstep(0.0, 0.1, dist);
  core = pow(core, 0.5);
  
  // Electric halo
  float halo = 1.0 - smoothstep(0.05, 0.35, dist);
  halo = pow(halo, 1.5);
  
  // Outer glow
  float outerGlow = 1.0 - smoothstep(0.15, 0.5, dist);
  outerGlow = pow(outerGlow, 3.0) * 0.5;
  
  // Life fade — vActive is a 0→1→0 envelope over the whole path
  // (written by updateSparks), so this only handles the fade-in.
  float lifeFade = smoothstep(0.0, 0.1, vActive);
  
  vec3 color = mix(uHaloColor * 1.5, uCoreColor * 3.0, core);
  float alpha = (core * 1.5 + halo * 0.8 + outerGlow * 0.3) * lifeFade;
  
  gl_FragColor = vec4(color, alpha);
}
`;

// ─── Create spark system ────────────────────────────────────────────────────
export function createSparkSystem(
  coreColor: THREE.Color,
  haloColor: THREE.Color
): SparkSystem {
  const positions = new Float32Array(MAX_SPARKS * 3);
  const progresses = new Float32Array(MAX_SPARKS);
  const actives = new Float32Array(MAX_SPARKS);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aProgress', new THREE.BufferAttribute(progresses, 1));
  geometry.setAttribute('aActive', new THREE.BufferAttribute(actives, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: sparkVertexShader,
    fragmentShader: sparkFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uCoreColor: { value: coreColor },
      uHaloColor: { value: haloColor }
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  const points = new THREE.Points(geometry, material);

  return {
    points,
    material,
    positions,
    progresses,
    actives,
    time: 0
  };
}

// ─── Update sparks from neural signals ──────────────────────────────────────
export function updateSparks(
  system: SparkSystem,
  signals: NeuralSignal[],
  nodePositions: Float32Array,
  deltaTime: number
): void {
  system.time += deltaTime;

  const posAttr = system.positions;
  const progAttr = system.progresses;
  const activeAttr = system.actives;

  // Clear all spark positions
  for (let i = 0; i < MAX_SPARKS; i++) {
    posAttr[i * 3] = 0;
    posAttr[i * 3 + 1] = 0;
    posAttr[i * 3 + 2] = 0;
    progAttr[i] = 0;
    activeAttr[i] = 0;
  }

  // Map active signals to spark slots
  let sparkIdx = 0;
  for (let i = 0; i < signals.length && sparkIdx < MAX_SPARKS; i++) {
    const signal = signals[i];
    if (!signal.active || signal.path.length === 0) continue;

    // Get current hop in path — `from`/`to` record the direction the
    // signal actually travels, so sparks never fly backwards.
    const hop = signal.path[signal.connectionIndex];
    if (!hop) continue;

    const sourceIdx = hop.from * 3;
    const targetIdx = hop.to * 3;

    const sx = nodePositions[sourceIdx];
    const sy = nodePositions[sourceIdx + 1];
    const sz = nodePositions[sourceIdx + 2];

    const tx = nodePositions[targetIdx];
    const ty = nodePositions[targetIdx + 1];
    const tz = nodePositions[targetIdx + 2];

    // Interpolate position along connection
    const t = signal.progress;
    posAttr[sparkIdx * 3] = sx + (tx - sx) * t;
    posAttr[sparkIdx * 3 + 1] = sy + (ty - sy) * t;
    posAttr[sparkIdx * 3 + 2] = sz + (tz - sz) * t;

    // Progress along current connection
    progAttr[sparkIdx] = signal.progress;

    // Visibility envelope over the whole path: fades in as the signal
    // starts, full brightness mid-travel, fades out as it arrives.
    const pathProgress = Math.min(
      1,
      (signal.connectionIndex + signal.progress) / signal.path.length
    );
    activeAttr[sparkIdx] = Math.sin(pathProgress * Math.PI);

    sparkIdx++;
  }

  // Mark unused slots as inactive
  for (let i = sparkIdx; i < MAX_SPARKS; i++) {
    activeAttr[i] = 0;
  }

  // CPU buffers above ARE the geometry attributes — only flag for upload
  system.points.geometry.getAttribute('position')!.needsUpdate = true;
  system.points.geometry.getAttribute('aProgress')!.needsUpdate = true;
  system.points.geometry.getAttribute('aActive')!.needsUpdate = true;
}
