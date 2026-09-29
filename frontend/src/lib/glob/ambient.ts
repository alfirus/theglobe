import * as THREE from 'three';

// ─── Configuration ───────────────────────────────────────────────────────────
const AMBIENT_COUNT = 40;
const DRIFT_RADIUS = 2.5;
const VELOCITY_SCALE = 0.02; // Extremely slow movement

// ─── Interfaces ──────────────────────────────────────────────────────────────
export interface AmbientSystem {
	points: THREE.Points;
	material: THREE.PointsMaterial;
	velocities: Float32Array;
}

// ─── Create ambient particles ───────────────────────────────────────────────
export function createAmbientParticles(color: THREE.Color): AmbientSystem {
	const positions = new Float32Array(AMBIENT_COUNT * 3);
	const velocities = new Float32Array(AMBIENT_COUNT * 3);

	for (let i = 0; i < AMBIENT_COUNT; i++) {
		// Random positions around the globe
		positions[i * 3] = (Math.random() - 0.5) * DRIFT_RADIUS * 2;
		positions[i * 3 + 1] = (Math.random() - 0.5) * DRIFT_RADIUS * 2;
		positions[i * 3 + 2] = (Math.random() - 0.5) * DRIFT_RADIUS * 2;

		// Very slow drift velocities
		velocities[i * 3] = (Math.random() - 0.5) * 0.001 * VELOCITY_SCALE;
		velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.001 * VELOCITY_SCALE;
		velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.001 * VELOCITY_SCALE;
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

	// Base opacity — high band audio will modulate this in frameStep()
	const material = new THREE.PointsMaterial({
		color: color,
		size: 0.01,
		transparent: true,
		opacity: 0.12,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		sizeAttenuation: true
	});

	const points = new THREE.Points(geometry, material);

	return { points, material, velocities };
}

// ─── Update ambient particles ───────────────────────────────────────────────
export function updateAmbient(system: AmbientSystem, deltaTime: number): void {
	const posAttr = system.points.geometry.getAttribute('position') as THREE.BufferAttribute;

	for (let i = 0; i < AMBIENT_COUNT; i++) {
		const ix = i * 3;
		const iy = i * 3 + 1;
		const iz = i * 3 + 2;

		// Update positions
		posAttr.array[ix] += system.velocities[ix] * deltaTime * 60;
		posAttr.array[iy] += system.velocities[iy] * deltaTime * 60;
		posAttr.array[iz] += system.velocities[iz] * deltaTime * 60;

		// Wrap around if too far
		for (const axis of [ix, iy, iz]) {
			if (Math.abs(posAttr.array[axis]) > DRIFT_RADIUS) {
				system.velocities[axis] *= -1;
			}
		}

		// Very rare drift change
		if (Math.random() < 0.005) {
			system.velocities[ix] += (Math.random() - 0.5) * 0.0001 * VELOCITY_SCALE;
			system.velocities[iy] += (Math.random() - 0.5) * 0.0001 * VELOCITY_SCALE;
			system.velocities[iz] += (Math.random() - 0.5) * 0.0001 * VELOCITY_SCALE;

			// Clamp velocity
			for (const axis of [ix, iy, iz]) {
				system.velocities[axis] = Math.max(-0.001, Math.min(0.001, system.velocities[axis]));
			}
		}
	}

	posAttr.needsUpdate = true;
}
