<script lang="ts">
	/**
	 * First-person helmet reading: vignette + a faint diagonal reflection
	 * streak + scan-lines. Sits above everything except modals, and never
	 * takes pointer events.
	 */
</script>

<div class="lens" aria-hidden="true">
	<div class="vignette"></div>
	<div class="streak"></div>
	<div class="scan"></div>
</div>

<style>
	.lens {
		position: fixed;
		inset: 0;
		z-index: 60;
		pointer-events: none;
		overflow: hidden;
	}

	.vignette {
		position: absolute;
		inset: 0;
		background: radial-gradient(
			ellipse at center,
			rgba(5, 11, 26, 0) 40%,
			rgba(5, 11, 26, 0.45) 78%,
			rgba(5, 11, 26, 0.8) 100%
		);
	}

	/* Faint diagonal reflection across the visor glass */
	.streak {
		position: absolute;
		top: -40%;
		left: 8%;
		width: 34%;
		height: 180%;
		transform: rotate(18deg);
		background: linear-gradient(
			to right,
			rgba(255, 255, 255, 0) 0%,
			rgba(255, 255, 255, 0.05) 45%,
			rgba(125, 249, 255, 0.05) 55%,
			rgba(255, 255, 255, 0) 100%
		);
		filter: blur(14px);
	}

	.scan {
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			to bottom,
			rgba(125, 249, 255, 0.035) 0 1px,
			transparent 1px 3px
		);
		mix-blend-mode: screen;
	}
</style>
