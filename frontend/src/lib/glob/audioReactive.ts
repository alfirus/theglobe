/**
 * Audio-reactive analysis pipeline.
 *
 * Builds a WebAudio graph (AudioContext → AnalyserNode) and exposes smoothed
 * frequency-band values (bass / mid / high) that the globe shader consumes as
 * uniforms every frame.  Zero when no audio is playing — idle animation stays
 * undistorted.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/** FFT size for the AnalyserNode (per BLUEPRINT:264). */
const FFT_SIZE = 256;

/** Exponential-smoothing constant passed to analyser.getByteFrequencyData(). */
const SMOOTHING_CONSTANT = 0.8;

/** Fast attack rate (/s) — how quickly bands rise on transients. */
const ATTACK_RATE = 18;

/** Slow release rate (/s) — how slowly bands decay back to zero. */
const RELEASE_RATE = 4;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface AudioBands {
  bass: number; // 0–250 Hz (widened so voice fundamentals land here)
  mid: number;  // 250 Hz – 2 kHz
  high: number; // 2–8 kHz
}

/** Internal state for exponential smoothing. */
interface Smoother {
  value: number;   // current smoothed value (0-1)
  target: number;  // target value (set per frame from raw band energy)
  attackRate: number;
  releaseRate: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** One exponential-smoothed channel. */
function makeSmoother(initialValue = 0, attackRate = ATTACK_RATE, releaseRate = RELEASE_RATE): Smoother {
  return { value: initialValue, target: initialValue, attackRate, releaseRate };
}

/** Update a smoother towards its target with frame-rate-independent lerp. */
function updateSmoother(s: Smoother, dt: number) {
  const diff = s.target - s.value;
  if (diff > 0) {
    // Attack — faster rise
    s.value += diff * (1 - Math.exp(-s.attackRate * dt));
  } else {
    // Release — slower fall back to zero
    s.value += diff * (1 - Math.exp(-s.releaseRate * dt));
  }
  // Clamp to [0, 1]
  if (s.value < 0) s.value = 0;
  if (s.value > 1) s.value = 1;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create an audio-reactive analysis pipeline.
 *
 * Returns an object with:
 * - `start(sourceNode | HTMLMediaElement)` — connect a source, start analysis
 * - `stop()` — disconnect everything, zero all bands
 * - `sample(dt)` → AudioBands — read analyser, compute bands, return smoothed values
 */
export function createAudioReactive(): {
  start: (source: AudioBufferSourceNode | HTMLMediaElement) => void;
  stop: () => void;
  sample: (dt: number) => AudioBands;
} {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sourceConnected = false;

  // Cache MediaElementSourceNodes per element so createMediaElementSource is called only once (WebAudio spec: throws on second call for same element).
  const mediaSourceCache = new Map<HTMLMediaElement, MediaElementAudioSourceNode>();

  // Frequency data buffer — allocated once, reused every frame.
  const freqData = new Uint8Array(FFT_SIZE / 2); // binCount = fftSize/2

  // Smoothers per band
  const bassSmoother = makeSmoother(0, ATTACK_RATE);
  const midSmoother = makeSmoother(0, ATTACK_RATE);
  const highSmoother = makeSmoother(0, ATTACK_RATE);

  /** Compute frequency bands from the analyser's raw data. */
  function computeBands(sampleRate: number): AudioBands {
    if (!analyser) return { bass: 0, mid: 0, high: 0 };

    analyser.getByteFrequencyData(freqData);

    // Map bin indices to Hz: bin i → freq = i * sampleRate / fftSize
    const binHz = sampleRate / FFT_SIZE;

    // Band boundaries in bin index (floor)
    const bassEndBin = Math.floor(250 / binHz);       // ~0-250 Hz
    const midEndBin = Math.floor(2000 / binHz);       // ~250-2kHz
    const highEndBin = Math.min(freqData.length - 1, Math.floor(8000 / binHz)); // ~2-8kHz

    let bassEnergy = 0;
    for (let i = 0; i <= Math.max(0, bassEndBin); i++) {
      bassEnergy += freqData[i];
    }
    const bassNorm = bassEndBin >= 0 ? bassEnergy / ((bassEndBin + 1) * 255) : 0;

    let midEnergy = 0;
    for (let i = Math.max(1, bassEndBin + 1); i <= Math.min(midEndBin, freqData.length - 1); i++) {
      midEnergy += freqData[i];
    }
    const midCount = Math.max(0, Math.min(midEndBin, freqData.length - 1) - Math.max(1, bassEndBin + 1) + 1);
    const midNorm = midCount > 0 ? midEnergy / (midCount * 255) : 0;

    let highEnergy = 0;
    for (let i = Math.max(bassEndBin + 1, midEndBin + 1); i <= highEndBin; i++) {
      highEnergy += freqData[i];
    }
    const highCount = Math.max(0, highEndBin - Math.max(bassEndBin + 1, midEndBin + 1) + 1);
    const highNorm = highCount > 0 ? highEnergy / (highCount * 255) : 0;

    return { bass: bassNorm, mid: midNorm, high: highNorm };
  }

  function start(source: AudioBufferSourceNode | HTMLMediaElement): void {
    // Create context lazily on first audio source
    if (!ctx) {
      ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }

    // Resume context if suspended (autoplay policy)
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Create analyser once
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING_CONSTANT;
    }

    // Disconnect previous source if any, then connect new one → analyser → destination (speakers)
    try {
      if (source instanceof AudioBufferSourceNode) {
        // Finding 3: explicitly connect buffer-source to analyser (was missing).
        source.disconnect();
        source.connect(analyser);
      } else if (source instanceof HTMLMediaElement) {
        // Finding 4: cache MediaElementSource per element — createMediaElementSource throws on second call for same element.
        let mediaSource = mediaSourceCache.get(source);
        if (!mediaSource) {
          mediaSource = ctx.createMediaElementSource(source);
          mediaSourceCache.set(source, mediaSource);
        } else {
          // Reconnect cached source to analyser (previous graph may have been disconnected).
          try { mediaSource.disconnect(); } catch {}
        }
        mediaSource.connect(analyser);
      }

      analyser.connect(ctx.destination);
      sourceConnected = true;
    } catch {
      // Source may already be connected — ignore
    }
  }

  function stop(): void {
    if (sourceConnected && analyser) {
      try { analyser.disconnect(); } catch {}
    }
    sourceConnected = false;
    // Reset smoothers to zero so bands decay smoothly
    bassSmoother.value = 0;
    bassSmoother.target = 0;
    midSmoother.value = 0;
    midSmoother.target = 0;
    highSmoother.value = 0;
    highSmoother.target = 0;
  }

  function sample(dt: number): AudioBands {
    if (!analyser || !ctx) return { bass: 0, mid: 0, high: 0 };

    const raw = computeBands(ctx.sampleRate);

    // Set targets from raw band energy
    bassSmoother.target = raw.bass;
    midSmoother.target = raw.mid;
    highSmoother.target = raw.high;

    // When no source is connected, force target to 0 so smoothers decay
    if (!sourceConnected) {
      bassSmoother.target = 0;
      midSmoother.target = 0;
      highSmoother.target = 0;
    }

    updateSmoother(bassSmoother, dt);
    updateSmoother(midSmoother, dt);
    updateSmoother(highSmoother, dt);

    return {
      bass: bassSmoother.value,
      mid: midSmoother.value,
      high: highSmoother.value,
    };
  }

  return { start, stop, sample };
}
