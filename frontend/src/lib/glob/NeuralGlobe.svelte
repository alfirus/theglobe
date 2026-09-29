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
  import { createAudioReactive, type AudioBands } from './audioReactive';

  let { isSpeaking = false, isThinking = false, audioElement }: { isSpeaking?: boolean; isThinking?: boolean; audioElement?: HTMLMediaElement } = $props();

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

  // Color palette (idle state)
  const COLORS = {
    node: new THREE.Color(0x4488ff),        // Electric blue
    connection: new THREE.Color(0x4499ee),   // Bright blue
    sparkCore: new THREE.Color(0xffffff),    // White
    sparkHalo: new THREE.Color(0x88ccff),    // Light blue
    ambient: new THREE.Color(0x335588),      // Very dim blue
    background: 0x000000                    // Pure black
  };

  // Hoisted targets so animate() allocates nothing per frame
  const SPEAKING_COLOR = new THREE.Color(0xddaa44); // Warm amber while speaking
  const ARC_COLOR = new THREE.Color(0x88ccff);

  // Audio-reactive pipeline (created in init, used in frameStep)
  let audioReactive: ReturnType<typeof createAudioReactive> | null = null;

  // React to isSpeaking + audioElement props: start/stop the WebAudio graph.
  $effect(() => {
    const _ = isSpeaking; // track dependency
    if (!audioReactive) return;
    if (isSpeaking && audioElement) {
      audioReactive.start(audioElement);
    } else if (!isSpeaking) {
      audioReactive.stop();
    }
  });

  onMount(() => {
    init();
    if (!document.hidden) animate();
  });

  onDestroy(() => {
    teardown();
  });

  // Full GPU teardown — geometries, materials, composer, context (M1)
  function teardown() {
    disposed = true;

    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = 0;
    }

    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);

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
    scene.background = new THREE.Color(COLORS.background);

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
      0.15,  // strength — very subtle
      0.1,   // radius — tight
      0.7    // threshold — only brightest elements
    );
    composer.addPass(bloomPass);

    // Globe group
    globeGroup = new THREE.Group();
    scene.add(globeGroup);

    // === NEW ARCHITECTURE ===

    // 1. Create nodes with clustering (includes core nodes)
    // clone() so the material owns uColor — otherwise lerping it towards
    // COLORS.node would be a no-op self-copy and never return to blue.
    const nodeResult = createNodes(COLORS.node.clone());
    nodeSystem = nodeResult.system;
    nodePoints = nodeResult.points;
    nodeMaterial = nodeResult.material;
    globeGroup.add(nodePoints);

    // 2. Build persistent connection graph
    connectionSystem = createConnections(nodeSystem.nodes, COLORS.connection);
    globeGroup.add(connectionSystem.lineSegments);

    // 3. Create spark system (signals follow graph paths)
    sparkSystem = createSparkSystem(COLORS.sparkCore, COLORS.sparkHalo);
    globeGroup.add(sparkSystem.points);

    // 4. Create neural simulation (drives everything)
    simulation = createSimulation();

    // 5. Create ambient particles (very sparse)
    ambientSystem = createAmbientParticles(COLORS.ambient);
    globeGroup.add(ambientSystem.points);

    // 6. Create electric arcs between neurons
    electricArcSystem = createElectricArcSystem(ARC_COLOR);
    globeGroup.add(electricArcSystem.lineSegments);

    // Clock
    clock = new THREE.Clock();

    // Audio-reactive pipeline (created once, started/stopped via isSpeaking prop)
    audioReactive = createAudioReactive();

    // Listeners
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
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
    // Clamp so a stalled tab can't produce a giant simulation step
    const deltaTime = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.getElapsedTime();

    // === NEURAL SIMULATION (drives everything) ===

    // 1. Update simulation timer — triggers events
    updateSimulationTimer(simulation, nodeSystem.nodes, connectionSystem, deltaTime);

    // 2. Update signals — move along paths, activate nodes/connections
    updateSignals(simulation, nodeSystem.nodes, connectionSystem, deltaTime);

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

    // Update node shader time
    nodeMaterial.uniforms.uTime.value = elapsed;

    // Speaking/thinking state: shift node color to warm amber
    const targetColor = isSpeaking ? SPEAKING_COLOR : COLORS.node;
    nodeMaterial.uniforms.uColor.value.lerp(targetColor, 0.05);

    // Thinking/streaming state: increase bloom intensity for pulse effect
    if (isThinking && !isSpeaking) {
      const pulse = Math.sin(elapsed * 4) * 0.1 + 0.2;
      bloomPass.strength = pulse;
    } else {
      bloomPass.strength = 0.15; // Default subtle bloom
    }

    // Thinking state: boost node activity via uniform
    const boost = nodeMaterial.uniforms.uActivityBoost;
    if (isThinking || isSpeaking) {
      boost.value = Math.min(boost.value + deltaTime * 2, 1.0);
    } else {
      boost.value = Math.max(boost.value - deltaTime * 3, 0.0);
    }

    // Update connection shader
    connectionSystem.material.uniforms.uTime.value = elapsed;

    // === AUDIO-REACTIVE UNIFORMS (P1-3) ===
    if (audioReactive) {
      const bands = audioReactive.sample(deltaTime);

      // Node material: bass drives point size (already in shader via uAudioBass)
      nodeMaterial.uniforms.uAudioBass.value = bands.bass;
      // Finding 5: mid-band warmth is now set on the node fragment shader.
      nodeMaterial.uniforms.uAudioMid.value = bands.mid;

      // Connection material: mid-band boosts brightness
      connectionSystem.material.uniforms.uAudioMid.value = bands.mid;

      // Ambient particles: opacity scales with high band (blueprint "particles = high → count")
      ambientSystem.material.opacity = 0.12 + bands.high * 0.35;

      // Bloom strength: base + mid-level contribution (blueprint: glow = mid * 2)
      const audioLevel = (bands.bass + bands.mid + bands.high) / 3;
      if (!isThinking || isSpeaking) {
        bloomPass.strength = 0.15 + audioLevel * 0.4;
      }

      // Globe scale: bass drives bigger motion than sibilance (blueprint: scale = 1.0 + amplitude * 0.15)
      globeGroup.scale.setScalar(1 + bands.bass * 0.15);

      // Dev/QA readback: the values actually applied to the uniforms this frame,
      // so "driven by the analyser" is measured rather than inferred (DEV only).
      if (import.meta.env.DEV) {
        const w = window as Window & {
          __globUniforms?: Record<string, number | undefined>;
        };
        const u = (w.__globUniforms ||= {});
        u.bass = nodeMaterial.uniforms.uAudioBass.value;
        u.mid = nodeMaterial.uniforms.uAudioMid.value;
        u.connMid = connectionSystem.material.uniforms.uAudioMid.value;
        u.ambientOpacity = ambientSystem.material.opacity;
        u.bloom = bloomPass.strength;
        u.scale = globeGroup.scale.x;
        u.frames = (u.frames || 0) + 1;
      }
    }

    // Update sparks from signals
    updateSparks(sparkSystem, simulation.signals, nodeSystem.positions, deltaTime);
    sparkSystem.material.uniforms.uTime.value = elapsed;

    // Update ambient particles
    updateAmbient(ambientSystem, deltaTime);

    // Update electric arcs
    const isActive = isSpeaking || isThinking;
    updateElectricArcs(electricArcSystem, nodeSystem.nodes, deltaTime, isActive);

    // Slow rotation of entire globe
    globeGroup.rotation.y += 0.1 * deltaTime;

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
  }
</style>
