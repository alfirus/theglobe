<script lang="ts">
	/**
	 * Visor HUD chrome: the 16px inset hairline frame with ruler ticks on all
	 * four edges and cut-corner brackets. Pure decoration — every hit test is
	 * disabled so it never intercepts a click meant for the app underneath.
	 */
</script>

<div class="frame" aria-hidden="true">
	<div class="edge top"></div>
	<div class="edge right"></div>
	<div class="edge bottom"></div>
	<div class="edge left"></div>

	<span class="corner tl"></span>
	<span class="corner tr"></span>
	<span class="corner bl"></span>
	<span class="corner br"></span>
</div>

<style>
	.frame {
		position: fixed;
		inset: 16px;
		z-index: 40;
		pointer-events: none;
	}

	/* Ruler ticks: a hairline border plus short inward strokes every 24px */
	.edge {
		position: absolute;
		opacity: 0.75;
	}

	.edge.top,
	.edge.bottom {
		left: 0;
		right: 0;
		height: 7px;
		background-image: repeating-linear-gradient(
			to right,
			var(--hud-line-strong) 0 1px,
			transparent 1px 24px
		);
	}
	.edge.top {
		top: 0;
		border-bottom: 1px solid var(--hud-line);
	}
	.edge.bottom {
		bottom: 0;
		border-top: 1px solid var(--hud-line);
	}

	.edge.left,
	.edge.right {
		top: 0;
		bottom: 0;
		width: 7px;
		background-image: repeating-linear-gradient(
			to bottom,
			var(--hud-line-strong) 0 1px,
			transparent 1px 24px
		);
	}
	.edge.left {
		left: 0;
		border-right: 1px solid var(--hud-line);
	}
	.edge.right {
		right: 0;
		border-left: 1px solid var(--hud-line);
	}

	/* Cut-corner brackets — the frame reads as a reticle, not a box */
	.corner {
		position: absolute;
		width: 22px;
		height: 22px;
		border: 1px solid var(--hud-cyan);
		box-shadow: 0 0 8px rgba(125, 249, 255, 0.35);
	}
	.corner.tl {
		top: -1px;
		left: -1px;
		border-right: 0;
		border-bottom: 0;
	}
	.corner.tr {
		top: -1px;
		right: -1px;
		border-left: 0;
		border-bottom: 0;
	}
	.corner.bl {
		bottom: -1px;
		left: -1px;
		border-right: 0;
		border-top: 0;
	}
	.corner.br {
		bottom: -1px;
		right: -1px;
		border-left: 0;
		border-top: 0;
	}

	@media (max-width: 720px) {
		.frame {
			inset: 8px;
		}
	}
</style>
