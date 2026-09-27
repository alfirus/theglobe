<script module lang="ts">
	/** The globe animates differently in each app state (owner requirement). */
	export type GlobeState = 'idle' | 'thinking' | 'speaking';
</script>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import * as THREE from 'three';
	import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
	import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
	import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

	// New architecture imports
	import { createNodes, updateNodes, type NodeSystem } from './nodes';
	import { createConnections, updateConnectionActivities, type ConnectionSystem } from './connections';
	import {
		createSimulation,
		updateSignals,
		updateNodeActivities,
		updateSimulationTimer,
		pulseCoreNodes,
		type NeuralSimulation
	} from './neuralActivity';
	import { createSparkSystem, updateSparks, type SparkSystem } from './sparks';
	import { createAmbientParticles, updateAmbient, type AmbientSystem } from './ambient';
	import { createElectricArcSystem, updateElectricArcs, type ElectricArcSystem } from './electricArcs';

	let {
		mode = 'idle',
		onTelemetry = () => {}
	}: {
		mode?: GlobeState;
		onTelemetry?: (t: {
			nodes: number;
			edges: number;
			bloom: number;
			fps: number;
			jitter: number;
		}) => void;
	} = $props();

	let container: HTMLDivElement;
	let animationId: number;

	// Three.js globals
	let renderer: THREE.WebGLRenderer;
	let scene: THREE.Scene;
	let camera: THREE.PerspectiveCamera;
	let composer: EffectComposer;
	// Declared at component scope: animate() must see it (it was local to init())
	let bloomPass: UnrealBloomPass;
	let clock: THREE.Clock;
	let disposed = false;
	let frameErrorReported = false;

	// Systems
	let nodeSystem: NodeSystem;
	let nodePoints: THREE.Points;
	let nodeMaterial: THREE.ShaderMaterial;
	let connectionSystem: ConnectionSystem;
	let sparkSystem: SparkSystem;
	let ambientSystem: AmbientSystem;
	let electricArcSystem: ElectricArcSystem;
	let simulation: NeuralSimulation;

	// Globe group for unified rotation
	let globeGroup: THREE.Group;

	/**
	 * Per-state render config. Every value is smoothed frame-to-frame, so the
	 * globe transitions between IDLE → THINKING → RESPONDING instead of
	 * hard-swapping (owner: "animated while idle, thinking and respond").
	 *
	 * rotation — rad/s: idle is the spec's ~0.05 rad/s base spin; thinking
	 * accelerates so the effort is visible; responding settles in between.
	 */
	const STATE_CFG: Record<
		GlobeState,
		{
			rotation: number;
			bloom: number;
			bloomOsc: number;
			boost: number;
			spawn: number;
			speed: number;
			inward: number;
			outward: number;
			color: THREE.Color;
		}
	> = {
		idle: {
			rotation: 0.05,
			bloom: 0.15,
			bloomOsc: 0,
			boost: 0,
			spawn: 1,
			speed: 1,
			inward: 0,
			outward: 0,
			color: new THREE.Color(0x5ecdf2)
		},
		thinking: {
			rotation: 0.12,
			bloom: 0.42,
			bloomOsc: 0.14,
			boost: 1,
			spawn: 2.6,
			speed: 1.9,
			inward: 1,
			outward: 0,
			color: new THREE.Color(0x9ff4ff)
		},
		speaking: {
			rotation: 0.08,
			bloom: 0.3,
			bloomOsc: 0.06,
			boost: 0.7,
			spawn: 1.7,
			speed: 1.4,
			inward: 0,
			outward: 1,
			color: new THREE.Color(0xffc14d)
		}
	};

	// Smoothed state values (module scope so the frame loop allocates nothing)
	let smRotation = 0.05;
	let smBloom = 0.15;
	let smBoost = 0;
	let smInward = 0;
	let smOutward = 0;
	const smColor = new THREE.Color(0x5ecdf2);

	// Drag-to-rotate (cheap interactivity the spec explicitly welcomes)
	let dragging = false;
	let lastPointer = { x: 0, y: 0 };
	let inertiaX = 0;
	let inertiaY = 0;

	// Frame statistics for the telemetry rail
	let dtEma = 1 / 60;
	let jitterEma = 0;
	let telemetryTimer = 0;

	// Hoisted targets so animate() allocates nothing per frame
	const ARC_COLOR = new THREE.Color(0x88ccff);

	onMount(() => {
		init();
		if (!document.hidden) animate();
	});

	onDestroy(() => {
		teardown();
	});

	/** Frame-rate independent smoothing: exponential approach with time constant `tau`. */
	function approach(current: number, target: number, dt: number, tau: number): number {
		return current + (target - current) * (1 - Math.exp(-dt / tau));
	}

	// Full GPU teardown — geometries, materials, composer, context (M1)
	function teardown() {
		disposed = true;

		if (animationId) {
			cancelAnimationFrame(animationId);
			animationId = 0;
		}

		window.removeEventListener('resize', onResize);
		document.removeEventListener('visibilitychange', onVisibilityChange);
		if (container) {
			container.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp);
		}

		if (scene) {
			scene.traverse((obj) => {
				const mesh = obj as THREE.Mesh;
				if (mesh.geometry) mesh.geometry.dispose();

				const mat = mesh.material;
				if (Array.isArray(mat)) {
					mat.forEach((m) => m.dispose());
				} else if (mat) {
					mat.dispose();
				}
			});
			scene.clear();
		}

		if (composer) composer.dispose();

		if (renderer) {
			renderer.dispose();
			renderer.forceContextLoss();
			renderer.domElement.remove();
		}
	}

	// Pause the render loop while the tab is hidden (L12)
	function onVisibilityChange() {
		if (disposed || !renderer || !clock) return;

		if (document.hidden) {
			if (animationId) {
				cancelAnimationFrame(animationId);
				animationId = 0;
			}
		} else if (!animationId) {
			clock.getDelta(); // discard time spent hidden so the first frame is small
			animate();
		}
	}

	function init() {
		// Scene
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0x050b1a);

		// Camera
		camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
		camera.position.z = 3;

		// Renderer
		renderer = new THREE.WebGLRenderer({
			antialias: true,
			alpha: false
		});
		renderer.setSize(window.innerWidth, window.innerHeight);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap for hiDPI + bloom
		renderer.toneMapping = THREE.ReinhardToneMapping;
		renderer.toneMappingExposure = 1.2;
		container.appendChild(renderer.domElement);

		// Post-processing
		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		bloomPass = new UnrealBloomPass(
			new THREE.Vector2(window.innerWidth, window.innerHeight),
			0.15, // strength — very subtle at idle
			0.1, // radius — tight
			0.7 // threshold — only brightest elements
		);
		composer.addPass(bloomPass);

		// Globe group
		globeGroup = new THREE.Group();
		scene.add(globeGroup);

		// === NEW ARCHITECTURE ===

		// 1. Create nodes with clustering (includes core nodes)
		// clone() so the material owns uColor — otherwise lerping it towards
		// a fixed colour would be a no-op self-copy and never change.
		const nodeResult = createNodes(STATE_CFG.idle.color.clone());
		nodeSystem = nodeResult.system;
		nodePoints = nodeResult.points;
		nodeMaterial = nodeResult.material;
		globeGroup.add(nodePoints);

		// 2. Build persistent connection graph
		connectionSystem = createConnections(nodeSystem.nodes, new THREE.Color(0x4fb8d8));
		globeGroup.add(connectionSystem.lineSegments);

		// 3. Create spark system (signals follow graph paths)
		sparkSystem = createSparkSystem(new THREE.Color(0xffffff), new THREE.Color(0x9ff4ff));
		globeGroup.add(sparkSystem.points);

		// 4. Create neural simulation (drives everything)
		simulation = createSimulation();

		// 5. Create ambient particles (very sparse)
		ambientSystem = createAmbientParticles(new THREE.Color(0x2c5f74));
		globeGroup.add(ambientSystem.points);

		// 6. Create electric arcs between neurons
		electricArcSystem = createElectricArcSystem(ARC_COLOR);
		globeGroup.add(electricArcSystem.lineSegments);

		// Clock
		clock = new THREE.Clock();

		// Listeners
		window.addEventListener('resize', onResize);
		document.addEventListener('visibilitychange', onVisibilityChange);
		container.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
	}

	// ── Drag-to-rotate ────────────────────────────────────────────────────────
	function onPointerDown(e: PointerEvent) {
		dragging = true;
		lastPointer = { x: e.clientX, y: e.clientY };
		inertiaX = 0;
		inertiaY = 0;
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging || !globeGroup) return;
		const dx = e.clientX - lastPointer.x;
		const dy = e.clientY - lastPointer.y;
		lastPointer = { x: e.clientX, y: e.clientY };

		inertiaX = dx * 0.006;
		inertiaY = dy * 0.004;
		globeGroup.rotation.y += inertiaX;
		globeGroup.rotation.x = THREE.MathUtils.clamp(
			globeGroup.rotation.x + inertiaY,
			-0.9,
			0.9
		);
	}

	function onPointerUp() {
		dragging = false;
	}

	function onResize() {
		const w = window.innerWidth;
		const h = window.innerHeight;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h);
		composer.setSize(w, h);
	}

	function animate() {
		animationId = requestAnimationFrame(animate);
		if (disposed || document.hidden) return;

		try {
			frameStep();
			frameErrorReported = false;
		} catch (err) {
			// One bad frame must never kill the render loop — report once
			if (!frameErrorReported) {
				frameErrorReported = true;
				console.error('[NeuralGlobe] frame step failed:', err);
			}
		}
	}

	function frameStep() {
		// Raw frame time feeds the jitter/fps readouts; the simulation step is
		// still clamped so a stalled tab can't produce a giant jump.
		const rawDelta = clock.getDelta();
		const deltaTime = Math.min(rawDelta, 0.1);
		const elapsed = clock.getElapsedTime();

		// ── Frame statistics (real, pushed to the telemetry rail) ────────────
		if (rawDelta > 0) {
			dtEma = dtEma + (rawDelta - dtEma) * 0.08;
			const deviation = Math.abs(rawDelta - dtEma);
			jitterEma = jitterEma + (deviation - jitterEma) * 0.08;
		}
		telemetryTimer += rawDelta;
		if (telemetryTimer >= 1) {
			telemetryTimer = 0;
			onTelemetry({
				nodes: nodeSystem.count,
				edges: connectionSystem.connections.length,
				bloom: Number(bloomPass.strength.toFixed(2)),
				fps: 1 / Math.max(dtEma, 1e-4),
				jitter: jitterEma * 1000
			});
		}

		// ── STATE CONFIG (smoothed — no hard swaps between states) ───────────
		const cfg = STATE_CFG[mode] ?? STATE_CFG.idle;
		smRotation = approach(smRotation, cfg.rotation, deltaTime, 0.7);
		smBloom = approach(smBloom, cfg.bloom, deltaTime, 0.6);
		smBoost = approach(smBoost, cfg.boost, deltaTime, 0.6);
		smInward = approach(smInward, cfg.inward, deltaTime, 0.8);
		smOutward = approach(smOutward, cfg.outward, deltaTime, 0.8);
		smColor.lerp(cfg.color, 1 - Math.exp(-deltaTime / 0.9));

		// === NEURAL SIMULATION (drives everything) ===

		// 1. Update simulation timer — triggers events, at the state's rate
		updateSimulationTimer(simulation, nodeSystem.nodes, connectionSystem, deltaTime, cfg.spawn);

		// 2. Update signals — move along paths, activate nodes/connections
		updateSignals(simulation, nodeSystem.nodes, connectionSystem, deltaTime, cfg.speed);

		// 3. Update node activities — decay, core pulse
		updateNodeActivities(nodeSystem.nodes, deltaTime);
		pulseCoreNodes(nodeSystem.nodes, elapsed, deltaTime);

		// 4. Update connection activities — decay
		updateConnectionActivities(connectionSystem, deltaTime);

		// === RENDER (reads activity values) ===

		// Update node positions and activities from simulation
		updateNodes(nodeSystem, elapsed);
		// These CPU buffers ARE the geometry attributes — only flag the upload
		(nodePoints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
		(nodePoints.geometry.getAttribute('aActivity') as THREE.BufferAttribute).needsUpdate = true;

		// Node shader: time, state colour, activity boost and the two ripples
		nodeMaterial.uniforms.uTime.value = elapsed;
		nodeMaterial.uniforms.uColor.value.copy(smColor);
		nodeMaterial.uniforms.uActivityBoost.value = smBoost;
		nodeMaterial.uniforms.uInward.value = smInward;
		nodeMaterial.uniforms.uOutward.value = smOutward;

		// Bloom follows the state, with a slow breath while thinking
		bloomPass.strength = smBloom + Math.sin(elapsed * 4) * cfg.bloomOsc;

		// Update connection shader
		connectionSystem.material.uniforms.uTime.value = elapsed;

		// Update sparks from signals
		updateSparks(sparkSystem, simulation.signals, nodeSystem.positions, deltaTime);
		sparkSystem.material.uniforms.uTime.value = elapsed;

		// Update ambient particles
		updateAmbient(ambientSystem, deltaTime);

		// Update electric arcs
		const isActive = mode !== 'idle';
		updateElectricArcs(electricArcSystem, nodeSystem.nodes, deltaTime, isActive);

		// ── 3D rotation: continuous, state-scaled, plus drag inertia ─────────
		globeGroup.rotation.y += smRotation * deltaTime;
		if (!dragging) {
			globeGroup.rotation.y += inertiaX;
			globeGroup.rotation.x = THREE.MathUtils.clamp(
				globeGroup.rotation.x + inertiaY,
				-0.9,
				0.9
			);
			inertiaX *= 0.93;
			inertiaY *= 0.93;
			if (Math.abs(inertiaX) < 1e-5) inertiaX = 0;
			if (Math.abs(inertiaY) < 1e-5) inertiaY = 0;
		}

		// Render with post-processing
		composer.render();
	}
</script>

<div bind:this={container} class="globe-container"></div>

<style>
	.globe-container {
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		margin: 0;
		padding: 0;
		overflow: hidden;
		cursor: grab;
		z-index: 1;
	}
	.globe-container:active {
		cursor: grabbing;
	}
</style>
