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
	// Endpoints sit in different clusters (bridge edge, or a core↔shell edge).
	// Rendered at 0.30× alpha at rest, 1.00× while a signal rides it — see
	// `lineFragmentShader`. Static per edge, so it ships as a static attribute.
	crossCluster: boolean;
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
					age: 0,
					crossCluster: node.cluster !== nodes[neighborId].cluster
				});
			}
		}
	}

	addBridgeEdges(nodes, connections, edgeSet);

	return connections;
}

// ─── Cross-cluster bridge edges ─────────────────────────────────────────────
/**
 * Three deterministic bridge layers (design spec t_c3686ec1):
 *
 *   L1 stitch   — each cluster → its 2 nearest clusters, via gateway nodes  (~20)
 *   L2 shortcut — ≤1 long chord per cluster into the far hemisphere, each
 *                 ≥45° (hemisphere-folded) from every chord already accepted (~7)
 *   L3 spoke    — each cluster's core-facing node → the nearest core node   (~18)
 *
 * Together ~45 new edges (2.2% of ~2016) turn 19 disconnected components into
 * one, which is what lets `findNeuralPath` actually cross the globe.
 *
 * Everything here is deterministic: **no `Math.random()`** — random chords bunch,
 * and they would reshuffle on every reload. Every edge goes through the caller's
 * `edgeSet`, so a layer can never double-book a pair that already exists.
 */
const SHORTCUT_MIN_SEPARATION_DEG = 45;

/** Angular distance in degrees between two vectors. */
function angleDeg(a: THREE.Vector3, b: THREE.Vector3): number {
	const denominator = a.length() * b.length();
	const cosine = denominator === 0 ? 0 : a.dot(b) / denominator;
	return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

/**
 * Fold a direction onto one hemisphere (flip so the first non-zero component is
 * positive) so chord *lines* — not vectors — can be compared for parallelism:
 * a→b and b→a are the same wire and must measure 0°, not 180°.
 */
function foldHemisphere(v: THREE.Vector3): THREE.Vector3 {
	const u = v.clone().normalize();
	const firstNonZero = Math.abs(u.x) > 1e-9 ? u.x : Math.abs(u.y) > 1e-9 ? u.y : u.z;
	return firstNonZero < 0 ? u.multiplyScalar(-1) : u;
}

function addBridgeEdges(
	nodes: NeuralNode[],
	connections: NeuralConnection[],
	edgeSet: Set<string>
): void {
	// Dense per-cluster buckets, keyed by the cluster ids nodes.ts actually emits.
	const clusterCount = nodes.reduce((max, n) => Math.max(max, n.cluster + 1), 0);
	const clusters: NeuralNode[][] = Array.from({ length: clusterCount }, () => []);
	const coreNodes: NeuralNode[] = [];
	for (const node of nodes) {
		if (node.cluster >= 0) clusters[node.cluster].push(node);
		else coreNodes.push(node);
	}
	const clusterIds = clusters
		.map((members, index) => (members.length > 0 ? index : -1))
		.filter((index) => index >= 0);
	if (clusterIds.length === 0 || coreNodes.length === 0) return;

	// centroid[c] = normalized mean basePosition of cluster c's nodes
	const centroids = new Map<number, THREE.Vector3>();
	for (const c of clusterIds) {
		const sum = new THREE.Vector3();
		for (const node of clusters[c]) sum.add(node.basePosition);
		centroids.set(c, sum.normalize());
	}
	const centroid = (c: number) => centroids.get(c)!;

	const addEdge = (source: number, target: number): void => {
		if (source === target) return;
		const key = Math.min(source, target) + '-' + Math.max(source, target);
		if (edgeSet.has(key)) return;
		edgeSet.add(key);
		connections.push({
			source,
			target,
			activity: 0,
			// `baseIntensity` is dead in the render path (only `aActivity` reaches the
			// shader), but keeping it constant is what keeps this layer Math.random-free.
			baseIntensity: 0.05,
			age: 0,
			crossCluster: nodes[source].cluster !== nodes[target].cluster
		});
	};

	// gateway(a → b): node in cluster a facing b's centroid — the shortest chord
	// end, and it parks bridge endpoints on the cluster rim instead of one node.
	const gateway = (a: number, b: number): number => {
		let best = clusters[a][0];
		let bestAngle = Infinity;
		for (const node of clusters[a]) {
			const d = angleDeg(node.basePosition, centroid(b));
			if (d < bestAngle) {
				bestAngle = d;
				best = node;
			}
		}
		return best.id;
	};
	const connect = (a: number, b: number) => addEdge(gateway(a, b), gateway(b, a));

	// Every other cluster, nearest first, from a's centroid.
	const nearestFirst = new Map<number, number[]>();
	for (const a of clusterIds) {
		nearestFirst.set(
			a,
			clusterIds
				.filter((b) => b !== a)
				.sort((x, y) => angleDeg(centroid(a), centroid(x)) - angleDeg(centroid(a), centroid(y)))
		);
	}

	// L1 — stitch: each cluster → its 2 nearest clusters. 36 selections dedupe to
	// ~20 unique pairs; chords land at 41–55°.
	for (const a of clusterIds) {
		const nearest = nearestFirst.get(a)!;
		for (let i = 0; i < 2 && i < nearest.length; i++) connect(a, nearest[i]);
	}

	// L2 — shortcut: at most one long chord per cluster, tried from the near edge
	// of the far half (so chords land ~90–150°, not all at 177°), accepted only if
	// its hemisphere-folded direction is ≥45° from every chord already accepted —
	// that separation is what stops two long chords reading as parallel wires.
	// Expect ~7 accepted; 11 clusters get none, which is correct.
	const shortcutDirs: THREE.Vector3[] = [];
	const shortcutPairs = new Set<string>();
	for (const a of clusterIds) {
		const nearest = nearestFirst.get(a)!;
		const farHalf = nearest.slice(Math.floor(nearest.length / 2));
		for (const b of farHalf) {
			const pairKey = Math.min(a, b) + '-' + Math.max(a, b);
			if (shortcutPairs.has(pairKey)) continue;

			const direction = foldHemisphere(centroid(b).clone().sub(centroid(a)));
			const spreadOk = shortcutDirs.every(
				(taken) => angleDeg(taken, direction) >= SHORTCUT_MIN_SEPARATION_DEG
			);
			if (!spreadOk) continue;

			shortcutDirs.push(direction);
			shortcutPairs.add(pairKey);
			connect(a, b);
			break; // at most one shortcut per cluster
		}
	}

	// L3 — spoke: each cluster's core-facing node (smallest |basePosition|) to the
	// nearest core node. One spoke per cluster → an even 18-spoke hub, not a tangle.
	for (const a of clusterIds) {
		let spoke = clusters[a][0];
		let spokeLength = spoke.basePosition.length();
		for (const node of clusters[a]) {
			const length = node.basePosition.length();
			if (length < spokeLength) {
				spokeLength = length;
				spoke = node;
			}
		}
		let core = coreNodes[0];
		let coreDistance = Infinity;
		for (const node of coreNodes) {
			const distance = node.basePosition.distanceTo(spoke.basePosition);
			if (distance < coreDistance) {
				coreDistance = distance;
				core = node;
			}
		}
		addEdge(spoke.id, core.id);
	}
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
): { positions: Float32Array; activities: Float32Array; crosses: Float32Array } {
	const vertexCount = connections.length * 2;
	const positions = new Float32Array(vertexCount * 3);
	const activities = new Float32Array(vertexCount);
	const crosses = new Float32Array(vertexCount);

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

		// Static per edge (0 = intra-cluster, 1 = cross-cluster): uploaded once,
		// never flagged `needsUpdate`.
		const cross = conn.crossCluster ? 1 : 0;
		crosses[i * 2] = cross;
		crosses[i * 2 + 1] = cross;
	}

	return { positions, activities, crosses };
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
attribute float aCross;
varying float vActivity;
varying float vFade;
varying float vCross;

void main() {
  vActivity = aActivity;
  vCross = aCross;
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
uniform float uAudioMid;

varying float vActivity;
varying float vFade;
varying float vCross;

void main() {
  // Mid-band audio boosts connection brightness (the globe "speaks" through connections)
  float intensity = 0.15 + vActivity * 1.5 + uAudioMid * 2.0;
  
  vec3 color = uColor * intensity;
  color = mix(color, vec3(1.0), vActivity * 0.25);
  
  float alpha = clamp(intensity * 0.4, 0.05, 0.6) * vFade;

  // Cross-cluster chords: 0.30x alpha at rest so the resting globe looks exactly
  // as it did before the bridges existed, ramping to 1.00x the moment a signal
  // rides them (then out again with the existing ACTIVITY_DECAY). The multiplier
  // has to come AFTER the clamp — the 0.05 floor would erase the dimming.
  // Stroke width cannot change: LineSegments is hard-capped at 1px, so alpha is
  // the only "thinner" lever there is.
  float w = mix(0.30, 1.0, smoothstep(0.0, 0.35, vActivity));
  alpha *= mix(1.0, w, vCross);

  gl_FragColor = vec4(color, alpha);
}
`;

export function createConnectionMaterial(color: THREE.Color): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		vertexShader: lineVertexShader,
		fragmentShader: lineFragmentShader,
		uniforms: {
			uColor: { value: color },
			uTime: { value: 0 },
			uAudioMid: { value: 0 }
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
	const { positions, activities, crosses } = buildLineBuffers(connections, nodes);

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute('aActivity', new THREE.BufferAttribute(activities, 1));
	// Static per-edge attribute: uploaded once, never flagged `needsUpdate`
	// (unlike `aActivity`, which is rewritten every frame).
	geometry.setAttribute('aCross', new THREE.BufferAttribute(crosses, 1));

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
