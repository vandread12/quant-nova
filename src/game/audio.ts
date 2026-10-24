// ============================================================================
// Procedural audio — synthesized SFX + looping battle music via Web Audio API.
// No binary assets required; everything is generated at runtime. Browser
// autoplay policies require a user gesture, so call `unlockAudio()` on the
// first interaction before music starts.
// ============================================================================

type SfxName =
  | "physical"
  | "logical"
  | "heal"
  | "buff"
  | "debuff"
  | "ultimate"
  | "enemyHit"
  | "allyHit"
  | "fuse"
  | "slot"
  | "victory"
  | "defeat";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

// --- music state ---
let musicTimer: number | null = null;
let musicGain: GainNode | null = null;
let musicStep = 0;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Resume the audio context after a user gesture (autoplay unlock). */
export function unlockAudio() {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume();
}

export function isMuted() {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  if (master && ctx) {
    master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.02);
  }
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

// ---------------------------------------------------------------------------
// Low-level tone helper: an oscillator with an ADSR-ish gain envelope.
// ---------------------------------------------------------------------------
function tone(opts: {
  freq: number;
  type?: OscillatorType;
  start?: number;
  dur: number;
  gain?: number;
  slideTo?: number;
  attack?: number;
}) {
  const c = getCtx();
  if (!c || !master) return;
  const t0 = c.currentTime + (opts.start ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.slideTo) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, opts.slideTo),
      t0 + opts.dur
    );
  }
  const peak = opts.gain ?? 0.3;
  const atk = opts.attack ?? 0.01;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.02);
}

// Short filtered-noise burst (impacts / "ruido").
function noise(opts: { dur: number; start?: number; gain?: number; freq?: number }) {
  const c = getCtx();
  if (!c || !master) return;
  const t0 = c.currentTime + (opts.start ?? 0);
  const frames = Math.floor(c.sampleRate * opts.dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames); // decaying noise
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = opts.freq ?? 1200;
  const g = c.createGain();
  g.gain.value = opts.gain ?? 0.25;
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + opts.dur);
}

// ---------------------------------------------------------------------------
// Public: play a named sound effect.
// ---------------------------------------------------------------------------
export function playSfx(name: SfxName) {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();

  switch (name) {
    case "physical":
      // percussive quantum "strike": thud + bright zap
      noise({ dur: 0.18, gain: 0.3, freq: 900 });
      tone({ freq: 220, slideTo: 90, dur: 0.18, type: "square", gain: 0.25 });
      tone({ freq: 1400, slideTo: 500, dur: 0.12, type: "sawtooth", gain: 0.12, start: 0.02 });
      break;
    case "logical":
      // ethereal rising shimmer
      tone({ freq: 520, slideTo: 1040, dur: 0.4, type: "sine", gain: 0.22 });
      tone({ freq: 780, slideTo: 1560, dur: 0.35, type: "triangle", gain: 0.12, start: 0.05 });
      break;
    case "heal":
      // gentle ascending bell arpeggio
      [0, 0.09, 0.18].forEach((s, i) =>
        tone({ freq: 523 * Math.pow(1.26, i), dur: 0.5, type: "sine", gain: 0.2, start: s })
      );
      break;
    case "buff":
      // confident ascending major triad
      [523, 659, 784].forEach((f, i) =>
        tone({ freq: f, dur: 0.45, type: "triangle", gain: 0.18, start: i * 0.06 })
      );
      break;
    case "debuff":
      // descending ominous slide
      tone({ freq: 440, slideTo: 150, dur: 0.5, type: "sawtooth", gain: 0.2 });
      tone({ freq: 330, slideTo: 110, dur: 0.5, type: "square", gain: 0.1, start: 0.03 });
      break;
    case "ultimate":
      // big sweep + chord stab
      tone({ freq: 160, slideTo: 1200, dur: 0.6, type: "sawtooth", gain: 0.22 });
      [262, 330, 392, 523].forEach((f, i) =>
        tone({ freq: f, dur: 0.7, type: "triangle", gain: 0.14, start: 0.25 + i * 0.03 })
      );
      noise({ dur: 0.5, gain: 0.18, freq: 2000, start: 0.2 });
      break;
    case "enemyHit":
      noise({ dur: 0.14, gain: 0.28, freq: 700 });
      tone({ freq: 180, slideTo: 70, dur: 0.14, type: "square", gain: 0.2 });
      break;
    case "allyHit":
      // enemy attacking an ally: low harsh hit
      noise({ dur: 0.22, gain: 0.3, freq: 400 });
      tone({ freq: 120, slideTo: 55, dur: 0.3, type: "sawtooth", gain: 0.25 });
      break;
    case "fuse":
      tone({ freq: 300, slideTo: 900, dur: 0.25, type: "triangle", gain: 0.2 });
      break;
    case "slot":
      tone({ freq: 660, dur: 0.08, type: "square", gain: 0.14 });
      break;
    case "victory":
      [523, 659, 784, 1047].forEach((f, i) =>
        tone({ freq: f, dur: 0.8, type: "triangle", gain: 0.2, start: i * 0.14 })
      );
      break;
    case "defeat":
      [392, 330, 262, 196].forEach((f, i) =>
        tone({ freq: f, dur: 0.9, type: "sine", gain: 0.2, start: i * 0.18 })
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Looping battle music — a dark pulsing bass + a tense minor arpeggio, driven
// by a step sequencer. Procedural so it loops forever without an asset.
// ---------------------------------------------------------------------------
// A minor pentatonic-ish progression that reads as "tense sci-fi battle".
const BASS = [55, 55, 73.42, 65.41]; // A1, A1, D2, C2 — one per bar
const ARP = [
  220, 261.63, 329.63, 261.63, // A3 C4 E4 C4
  293.66, 349.23, 440, 349.23, // D4 F4 A4 F4
];

function musicTick() {
  const c = getCtx();
  if (!c || !musicGain) return;

  const bar = Math.floor(musicStep / ARP.length) % BASS.length;
  const arpIdx = musicStep % ARP.length;

  // bass note at the start of each bar
  if (arpIdx === 0) {
    const g = c.createGain();
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = BASS[bar];
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.22, c.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.9);
    osc.connect(lp);
    lp.connect(g);
    g.connect(musicGain);
    osc.start();
    osc.stop(c.currentTime + 0.95);
  }

  // arpeggio pluck
  const ag = c.createGain();
  const aosc = c.createOscillator();
  aosc.type = "triangle";
  aosc.frequency.value = ARP[arpIdx];
  ag.gain.setValueAtTime(0.0001, c.currentTime);
  ag.gain.exponentialRampToValueAtTime(0.09, c.currentTime + 0.01);
  ag.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.28);
  aosc.connect(ag);
  ag.connect(musicGain);
  aosc.start();
  aosc.stop(c.currentTime + 0.3);

  musicStep = (musicStep + 1) % (ARP.length * BASS.length);
}

export function startMusic() {
  const c = getCtx();
  if (!c || musicTimer != null) return;
  if (c.state === "suspended") void c.resume();
  if (!musicGain && master) {
    musicGain = c.createGain();
    musicGain.gain.value = 0.5;
    musicGain.connect(master);
  }
  musicStep = 0;
  // 150 BPM-ish eighth notes (~200ms per step)
  musicTick();
  musicTimer = window.setInterval(musicTick, 200);
}

export function stopMusic() {
  if (musicTimer != null) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}
