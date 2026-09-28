import * as THREE from 'three';
import type { NeuralNode } from './nodes';

// ─── Configuration ───────────────────────────────────────────────────────────
const MIN_CONNECTIONS_PER_NODE = 3;
const MAX_CONNECTIONS_PER_NODE = 6;
const ACTIVITY_DECAY = 0.96;
const ACTIVITY_BOOST = 2.0;

// ─── Interfaces ──────────────────────────────────────────────────────────────
export interface NeuralConnection {
	source: number; // node id
	target: number; // node id
	activity: number; // 0-1, decays over time
	baseIntensity: number; // 0-1, fixed brightness
	age: number;
}

export interface ConnectionSystem {
	connections: NeuralConnection[];
	// Adacency list: for each node, list of connection indices
	adjacency: Map<number, number[]>;
	// GPU buffers
	linePositions: Float32Array;
	lineActivities: Float32Array;
	lineGeometry: THREE.BufferGeometry;
	lineSegments: THREE.LineSegments;
	material: THREE.ShaderMaterial;
	// Live BufferAttribute for `aActivity` — must be flagged, not the raw array
	actAttr: THREE.BufferAttribute;
}

// ─── Find nearest neighbors ─────────────────────────────────────────────────
function findNearestNeighbors(
	nodes: NeuralNode[],
	targetNode: NeuralNode,
	minK: number,
	maxK: number
): { neighborId: number; distance: number }[] {
	const distances: { neighborId: number; distance: number }[] = [];

	for (let i = 0; i < nodes.length; i++) {
		if (nodes[i].id === targetNode.id) continue;

		const dx = targetNode.basePosition.x - nodes[i].basePosition.x;
		const dy = targetNode.basePosition.y - nodes[i].basePosition.y;
		const dz = targetNode.basePosition.z - nodes[i].basePosition.z;
		const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

		distances.push({ neighborId: nodes[i].id, distance: dist });
	}

	// Sort by distance
	distances.sort((a, b) => a.distance - b.distance);

	// Return random subset between minK and maxK
	const k = minK + Math.floor(Math.random() * (maxK - minK + 1));
	const result = distances.slice(0, k);

	// Shuffle to add some randomness
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}

	return result;
}

// ─── Build persistent graph ─────────────────────────────────────────────────
export function buildGraph(nodes: NeuralNode[]): NeuralConnection[] {
	const connections: NeuralConnection[] = [];
	const edgeSet = new Set<string>(); // Track edges to avoid duplicates

	for (const node of nodes) {
		const neighbors = findNearestNeighbors(
			nodes,
			node,
			MIN_CONNECTIONS_PER_NODE,
			MAX_CONNECTIONS_PER_NODE
		);

		for (const { neighborId } of neighbors) {
			// Create unique edge key (smaller id first)
			const edgeKey = Math.min(node.id, neighborId) + '-' + Math.max(node.id, neighborId);

			if (!edgeSet.has(edgeKey)) {
				edgeSet.add(edgeKey);

				const baseIntensity = 0.05 + Math.random() * 0.08;
				connections.push({
					source: node.id,
					target: neighborId,
					activity: 0,
					baseIntensity,
					age: 0
				});
			}
		}
	}

	return connections;
}

// ─── Build adjacency list ───────────────────────────────────────────────────
function buildAdjacency(connections: NeuralConnection[]): Map<number, number[]> {
	const adjacency = new Map<number, number[]>();

	for (let i = 0; i < connections.length; i++) {
		const conn = connections[i];

		if (!adjacency.has(conn.source)) adjacency.set(conn.source, []);
		if (!adjacency.has(conn.target)) adjacency.set(conn.target, []);

		adjacency.get(conn.source)!.push(i);
		adjacency.get(conn.target)!.push(i);
	}

	return adjacency;
}

// ─── Build line geometry buffers ─────────────────────────────────────────────
function buildLineBuffers(
	connections: NeuralConnection[],
	nodes: NeuralNode[]
): { positions: Float32Array; activities: Float32Array } {
	const vertexCount = connections.length * 2;
	const positions = new Float32Array(vertexCount * 3);
	const activities = new Float32Array(vertexCount);

	// Build a lookup from node id to position
	const posLookup = new Float32Array(nodes.length * 3);
	for (const node of nodes) {
		posLookup[node.id * 3] = node.basePosition.x;
		posLookup[node.id * 3 + 1] = node.basePosition.y;
		posLookup[node.id * 3 + 2] = node.basePosition.z;
	}

	for (let i = 0; i < connections.length; i++) {
		const conn = connections[i];
		const si = conn.source * 3;
		const ti = conn.target * 3;

		// Start vertex
		positions[i * 6] = posLookup[si];
		positions[i * 6 + 1] = posLookup[si + 1];
		positions[i * 6 + 2] = posLookup[si + 2];

		// End vertex
		positions[i * 6 + 3] = posLookup[ti];
		positions[i * 6 + 4] = posLookup[ti + 1];
		positions[i * 6 + 5] = posLookup[ti + 2];

		// Activity for both vertices
		activities[i * 2] = conn.activity;
		activities[i * 2 + 1] = conn.activity;
	}

	return { positions, activities };
}

// ─── Update line activity buffer ─────────────────────────────────────────────
export function updateConnectionActivities(system: ConnectionSystem, deltaTime: number): void {
	const actAttr = system.actAttr; // BufferAttribute, not the Float32Array

	// Frame-rate independent decay: same falloff at 30/60/120 Hz
	const decay = Math.pow(ACTIVITY_DECAY, deltaTime * 60);

	for (let i = 0; i < system.connections.length; i++) {
		const conn = system.connections[i];

		// Decay activity
		conn.activity *= decay;
		if (conn.activity < 0.001) conn.activity = 0;

		// Update age
		conn.age += deltaTime;

		// Set activity for both vertices
		actAttr.array[i * 2] = conn.activity;
		actAttr.array[i * 2 + 1] = conn.activity;
	}

	actAttr.needsUpdate = true;
}

// ─── Get intensity for rendering ─────────────────────────────────────────────
export function getConnectionIntensity(conn: NeuralConnection): number {
	return conn.baseIntensity + conn.activity * ACTIVITY_BOOST;
}

// ─── Shaders ─────────────────────────────────────────────────────────────────
export const lineVertexShader = `
attribute float aActivity;
varying float vActivity;
varying float vFade;

void main() {
  vActivity = aActivity;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

  // Same depth cue as the nodes: dendrites on the far hemisphere dim, so the
  // connecting lines turn with real volume instead of reading as a flat mesh.
  vec3 sphereNormal = normalize(position / max(length(position), 1e-4));
  vec3 viewNormal = normalize(mat3(modelViewMatrix) * sphereNormal);
  vec3 viewDir = normalize(-mvPosition.xyz);
  vFade = 0.2 + 0.8 * smoothstep(-0.4, 0.6, dot(viewNormal, viewDir));

  gl_Position = projectionMatrix * mvPosition;
}
`;

export const lineFragmentShader = `
uniform vec3 uColor;
uniform float uTime;

varying float vActivity;
varying float vFade;

void main() {
  float intensity = 0.15 + vActivity * 1.5;
  
  vec3 color = uColor * intensity;
  color = mix(color, vec3(1.0), vActivity * 0.25);
  
  float alpha = clamp(intensity * 0.4, 0.05, 0.6) * vFade;
  
  gl_FragColor = vec4(color, alpha);
}
`;

export function createConnectionMaterial(color: THREE.Color): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		vertexShader: lineVertexShader,
		fragmentShader: lineFragmentShader,
		uniforms: {
			uColor: { value: color },
			uTime: { value: 0 }
		},
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthWrite: false
	});
}

// ─── Convenience: create everything ──────────────────────────────────────────
export function createConnections(nodes: NeuralNode[], color: THREE.Color): ConnectionSystem {
	const connections = buildGraph(nodes);
	const adjacency = buildAdjacency(connections);
	const { positions, activities } = buildLineBuffers(connections, nodes);

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute('aActivity', new THREE.BufferAttribute(activities, 1));

	// Keep the attribute handle so updates can flag it for re-upload
	const actAttr = geometry.getAttribute('aActivity') as THREE.BufferAttribute;

	const material = createConnectionMaterial(color);
	const lineSegments = new THREE.LineSegments(geometry, material);

	return {
		connections,
		adjacency,
		linePositions: positions,
		lineActivities: activities,
		lineGeometry: geometry,
		lineSegments,
		material,
		actAttr
	};
}
