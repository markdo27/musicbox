/**
 * audio.js — Internal Web Audio Synthesis Engine
 * Provides drum synthesis + polyphonic synth voices so the
 * sequencer can play back without any external MIDI hardware.
 *
 * Drum channel (ch 10) → percussive synthesis by MIDI note
 * Melodic channels     → polyphonic oscillator synth
 */

const AudioEngine = (() => {

  let ctx = null;
  let masterGain = null;
  let masterCompressor = null;
  let enabled = true;
  let masterVol = 0.72;

  // Active oscillator voices for note-offs
  const activeVoices = new Map(); // key: `ch-note` → {osc, env, ...}

  // Spatial FX nodes and gains
  let reverbNode = null;
  let delayNode = null;
  let dryGain = null;
  let reverbWetGain = null;
  let delayWetGain = null;
  let reverbToneFilter = null;
  let delayToneFilter = null;

  // Spatial FX defaults
  let reverbMixVal = 0.25;
  let reverbDecayVal = 2.5; // seconds
  let delayMixVal = 0.2;
  let delayTimeVal = 0.35; // seconds
  let delayFeedbackVal = 0.45;

  // Per-track instrument settings (index = track index)
  const trackInstruments = [
    { type: 'drum',  color: '#00d4ff' },
    { type: 'drum',  color: '#00ff88' },
    { type: 'drum',  color: '#ffaa00' },
    { type: 'drum',  color: '#c084fc' },
    { type: 'acid',  color: '#ff6eb4' },  // TB-303 acid bass
    { type: 'acid',  color: '#ff7a1a' },  // TB-303 acid bass #2
    { type: 'lead',  color: '#7df3e1' },
    { type: 'pad',   color: '#a78bfa' },
  ];

  // Per-track gain nodes (real-time Web Audio volume control)
  const trackGainNodes = new Array(8).fill(null);

  // ─── Instrument type map (overridable) ──────────────────────
  const channelInstrumentMap = new Map();
  // Ch 10 = drums always
  for (let i = 1; i <= 16; i++) {
    channelInstrumentMap.set(i, i === 10 ? 'drum' : 'synth');
  }

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    if (window.SamplerEngine) {
      SamplerEngine.init();
    }

    // Master compressor (prevents clipping)
    masterCompressor = ctx.createDynamicsCompressor();
    masterCompressor.threshold.value = -18;
    masterCompressor.knee.value = 10;
    masterCompressor.ratio.value = 4;
    masterCompressor.attack.value = 0.003;
    masterCompressor.release.value = 0.25;
    masterCompressor.connect(ctx.destination);

    // Master gain
    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(masterVol, ctx.currentTime);

    // Per-track gain nodes: masterGain → trackGain[i] → master bus
    for (let i = 0; i < 8; i++) {
      const tg = ctx.createGain();
      tg.gain.value = 1.0;
      trackGainNodes[i] = tg;
      tg.connect(masterGain);
    }

    // Dry path
    dryGain = ctx.createGain();
    dryGain.gain.setValueAtTime(Math.max(0.1, 1.0 - reverbMixVal * 0.7 - delayMixVal * 0.7), ctx.currentTime);
    masterGain.connect(dryGain);
    dryGain.connect(masterCompressor);

    // Delay path (with high-cut tone filter)
    delayNode = _createPingPongDelay(ctx, delayTimeVal, delayFeedbackVal);
    delayWetGain = ctx.createGain();
    delayWetGain.gain.setValueAtTime(delayMixVal, ctx.currentTime);
    delayToneFilter = ctx.createBiquadFilter();
    delayToneFilter.type = 'highshelf';
    delayToneFilter.frequency.value = 4000;
    delayToneFilter.gain.value = -6;
    masterGain.connect(delayNode.input);
    delayNode.output.connect(delayWetGain);
    delayWetGain.connect(delayToneFilter);
    delayToneFilter.connect(masterCompressor);

    // Reverb path (with high-cut tone filter)
    reverbNode = _createReverb(ctx, reverbDecayVal);
    reverbWetGain = ctx.createGain();
    reverbWetGain.gain.setValueAtTime(reverbMixVal, ctx.currentTime);
    reverbToneFilter = ctx.createBiquadFilter();
    reverbToneFilter.type = 'highshelf';
    reverbToneFilter.frequency.value = 3000;
    reverbToneFilter.gain.value = -9;
    masterGain.connect(reverbNode.input);
    reverbNode.output.connect(reverbWetGain);
    reverbWetGain.connect(reverbToneFilter);
    reverbToneFilter.connect(masterCompressor);
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // ─── Note On ───────────────────────────────────────────────
  function noteOn(channel, note, velocity, trackIdx = -1, accent = false, slide = false) {
    if (!enabled || !ctx) return;
    resume();

    const vel = (velocity || 100) / 127;
    const instrType = _getInstrType(channel, trackIdx);

    // Resolve output bus: per-track gain if available, else master
    const outBus = (trackIdx >= 0 && trackGainNodes[trackIdx]) ? trackGainNodes[trackIdx] : masterGain;

    // External Sampler Check (Strudel database)
    if (window.SamplerEngine && SamplerEngine.getCategories().includes(instrType)) {
      SamplerEngine.playSample(ctx, outBus, instrType, note, vel, 0);
      return;
    }

    if (instrType === 'drum' || channel === 10) {
      _playDrum(note, vel, outBus);
    } else if (instrType === 'acid') {
      _playAcidBass(channel, note, vel, outBus, accent, slide);
    } else if (instrType === 'bass') {
      _playBass(channel, note, vel, outBus);
    } else if (instrType === 'pad') {
      _playPad(channel, note, vel, outBus);
    } else {
      _playSynth(channel, note, vel, outBus);
    }
  }

  // ─── Note Off ──────────────────────────────────────────────
  function noteOff(channel, note) {
    if (!enabled || !ctx) return;
    const key = `${channel}-${note}`;
    const voice = activeVoices.get(key);
    if (!voice) return;

    const now = ctx.currentTime;
    const release = voice.release || 0.05;
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setValueAtTime(voice.env.gain.value, now);
    voice.env.gain.linearRampToValueAtTime(0, now + release);

    setTimeout(() => {
      try { voice.osc?.stop(); } catch(e) {}
      try { voice.osc2?.stop(); } catch(e) {}
      try { voice.osc3?.stop(); } catch(e) {}
    }, (release + 0.1) * 1000);

    activeVoices.delete(key);
  }

  function _getInstrType(channel, trackIdx) {
    if (trackIdx >= 0 && trackInstruments[trackIdx]) return trackInstruments[trackIdx].type;
    if (channel === 10) return 'drum';
    return 'lead';
  }

  // ═══════════════════════════════════════════════════════════
  // DRUM SYNTHESIS
  // ═══════════════════════════════════════════════════════════

  // MIDI note → drum type mapping (GM standard)
  const DRUM_MAP = {
    35: 'kick', 36: 'kick',        // Acoustic Bass Drum, Bass Drum 1
    38: 'snare', 40: 'snare',      // Acoustic Snare, Electric Snare
    37: 'rim',                     // Side Stick
    39: 'clap',                    // Hand Clap
    42: 'hihat_closed',            // Closed Hi-Hat
    44: 'hihat_closed',            // Pedal Hi-Hat
    46: 'hihat_open',              // Open Hi-Hat
    49: 'crash', 57: 'crash',      // Crash Cymbal
    51: 'ride',  59: 'ride',       // Ride Cymbal
    41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom',
    70: 'clap', 75: 'clap',
  };

  function _playDrum(note, vel, outBus) {
    const type = DRUM_MAP[note] || (note % 2 === 0 ? 'kick' : 'hihat_closed');
    const bus = outBus || masterGain;
    switch (type) {
      case 'kick':         _kick(vel, bus); break;
      case 'snare':        _snare(vel, bus); break;
      case 'hihat_closed': _hihat(vel, 0.06, bus); break;
      case 'hihat_open':   _hihat(vel, 0.35, bus); break;
      case 'clap':         _clap(vel, bus); break;
      case 'rim':          _rim(vel, bus); break;
      case 'crash':        _crash(vel, bus); break;
      case 'ride':         _ride(vel, bus); break;
      case 'tom':          _tom(vel, 80 + (note - 41) * 8, bus); break;
      default:             _hihat(vel, 0.08, bus); break;
    }
  }

  // ─── TR-606 Kick Drum ──────────────────────────────────────
  // Pitch: 180Hz → 30Hz over 400ms (deep, punchy, 606-authentic)
  function _kick(vel, bus) {
    const now = ctx.currentTime;

    // Sub sine body
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.4);

    // Soft clip waveshaper (subtle saturation)
    const shaper = ctx.createWaveShaper();
    shaper.curve = _makeDistortionCurve(20);
    shaper.oversample = '2x';

    const env = ctx.createGain();
    env.gain.setValueAtTime(vel * 1.3, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    osc.connect(shaper);
    shaper.connect(env);
    env.connect(bus);

    // Click transient (3kHz bandpass noise, 12ms)
    const clickBuf = _makeNoise(0.015);
    const clickSrc = ctx.createBufferSource();
    clickSrc.buffer = clickBuf;
    const clickFilter = ctx.createBiquadFilter();
    clickFilter.type = 'bandpass';
    clickFilter.frequency.value = 3000;
    clickFilter.Q.value = 0.8;
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(vel * 0.6, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);
    clickSrc.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(bus);

    osc.start(now);
    osc.stop(now + 0.55);
    clickSrc.start(now);
  }

  // ─── TR-606 Snare ─────────────────────────────────────────
  function _snare(vel, bus) {
    const now = ctx.currentTime;

    // Tuned body: sine 220Hz → 110Hz (60% mix)
    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = 'sine';
    bodyOsc.frequency.setValueAtTime(220, now);
    bodyOsc.frequency.exponentialRampToValueAtTime(110, now + 0.07);
    const bodyEnv = ctx.createGain();
    bodyEnv.gain.setValueAtTime(vel * 0.45, now);
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    bodyOsc.connect(bodyEnv);
    bodyEnv.connect(bus);
    bodyOsc.start(now);
    bodyOsc.stop(now + 0.12);

    // Noise component: bandpass 2500Hz (40% mix), sharp transient
    const noiseBuf = _makeNoise(0.25);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2500;
    noiseFilter.Q.value = 0.8;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(vel * 0.85, now);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseEnv);
    noiseEnv.connect(bus);
    noiseSrc.start(now);
  }

  // ─── TR-606 Hi-Hat ─────────────────────────────────────────
  // 6 FM-style detuned square oscs, 606 frequency set
  function _hihat(vel, duration, bus) {
    const now = ctx.currentTime;
    // TR-606 metallic frequencies
    const freqs = [2070, 3100, 4250, 5700, 7800, 10100];
    const masterHHGain = ctx.createGain();
    masterHHGain.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    filter.connect(masterHHGain);

    freqs.forEach(f => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    });

    const decay = duration < 0.1 ? duration + 0.015 : duration;
    masterHHGain.gain.setValueAtTime(vel * 0.18, now);
    masterHHGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
  }

  // ─── TR-606 Clap (4-burst layered noise) ─────────────────────
  function _clap(vel, bus) {
    const now = ctx.currentTime;
    const offsets = [0, 0.003, 0.006, 0.010];
    offsets.forEach(offset => {
      const noiseBuf = _makeNoise(0.12);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 0.7;
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(vel * 0.75, now + offset);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.12);
      src.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(bus);
      src.start(now + offset);
    });
  }

  // ─── Rim Shot ───────────────────────────────────────────────
  function _rim(vel, bus) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1600;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  // ─── Crash Cymbal ───────────────────────────────────────────
  function _crash(vel, bus) {
    const now = ctx.currentTime;
    const freqs = [3150, 4523, 5860, 7420, 9800, 14000];
    const masterGainNode = ctx.createGain();
    masterGainNode.connect(bus);
    masterGainNode.gain.setValueAtTime(vel * 0.3, now);
    masterGainNode.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

    freqs.forEach(f => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(masterGainNode);
      osc.start(now);
      osc.stop(now + 1.3);
    });
  }

  // ─── Ride ───────────────────────────────────────────────────
  function _ride(vel, bus) {
    const now = ctx.currentTime;
    const freqs = [4000, 6200, 8800];
    const gainNode = ctx.createGain();
    gainNode.connect(bus);
    gainNode.gain.setValueAtTime(vel * 0.2, now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    freqs.forEach(f => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(gainNode);
      osc.start(now);
      osc.stop(now + 0.55);
    });
  }

  // ─── Tom ────────────────────────────────────────────────────
  function _tom(vel, freq, bus) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.8, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + 0.08);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  // ─── White Noise Buffer ─────────────────────────────────────
  function _makeNoise(duration) {
    const sampleRate = ctx.sampleRate;
    const bufLen = Math.floor(sampleRate * duration);
    const buf = ctx.createBuffer(1, bufLen, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  // ─── Soft Distortion Curve ─────────────────────────────────
  function _makeDistortionCurve(amount) {
    const samples = 256;
    const curve = new Float32Array(samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // ═══════════════════════════════════════════════════════════
  // MELODIC SYNTHESIS
  // ═══════════════════════════════════════════════════════════

  function _midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  // ───────────────────────────────────────────────────────
  // TB-303 ACID BASS ENGINE
  // ───────────────────────────────────────────────────────
  // Per-channel voice state (enables slide glide between notes)
  const acidVoices = new Map(); // key: `acid-${channel}` → voice obj

  function _playAcidBass(channel, note, vel, bus, accent, slide) {
    const now = ctx.currentTime;
    const freq = _midiToFreq(note);
    const key = `acid-${channel}`;
    const existing = acidVoices.get(key);

    // ── SLIDE: glide existing oscillator to new pitch, skip envelope retrigger
    if (slide && existing && existing.osc) {
      existing.osc.frequency.cancelScheduledValues(now);
      existing.osc.frequency.setTargetAtTime(freq, now, 0.015); // 15ms glide
      if (existing.sub) existing.sub.frequency.setTargetAtTime(freq / 2, now, 0.015);
      existing.currentNote = note;
      return; // do not retrigger envelope
    }

    // ── Kill existing voice cleanly
    if (existing) {
      try {
        existing.env.gain.setTargetAtTime(0, now, 0.008);
        setTimeout(() => {
          try { existing.osc.stop(); } catch(e) {}
          try { existing.sub.stop(); } catch(e) {}
        }, 80);
      } catch(e) {}
    }

    // ── New voice
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth'; // classic 303 sound
    osc.frequency.setValueAtTime(freq, now);

    // Sub oscillator (-1 octave, square wave)
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.setValueAtTime(freq / 2, now);

    // 18dB/oct lowpass filter — high resonance for 303 squelch
    // Resonance Q: accent → 20 (self-oscillating squelch), normal → 9
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = accent ? 20 : 9;

    // Filter envelope: fast attack, exponential decay
    // Accent: filter opens wide (4000Hz peak), normal: moderate (1600Hz)
    const baseCutoff  = 350;
    const peakCutoff  = accent ? 4000 : 1600;
    filter.frequency.setValueAtTime(baseCutoff, now);
    filter.frequency.linearRampToValueAtTime(peakCutoff, now + 0.002); // 2ms attack
    filter.frequency.setTargetAtTime(baseCutoff, now + 0.002, 0.08);   // decay

    // Amplitude envelope
    const env = ctx.createGain();
    const baseAmp   = vel;                           // vel = 0..1
    const accentBoost = accent ? 1.45 : 1.0;         // +3dB on accent
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(baseAmp * accentBoost * 0.75, now + 0.001);

    // Mix: 70% sawtooth + 30% sub
    const oscMix = ctx.createGain(); oscMix.gain.value = 0.7;
    const subMix = ctx.createGain(); subMix.gain.value = 0.3;

    osc.connect(oscMix); oscMix.connect(filter);
    sub.connect(subMix); subMix.connect(filter);
    filter.connect(env);
    env.connect(bus);

    osc.start(now);
    sub.start(now);

    acidVoices.set(key, { osc, sub, filter, env, release: 0.05, currentNote: note });
  }

  function _stopAcidBass(channel) {
    const key = `acid-${channel}`;
    const voice = acidVoices.get(key);
    if (!voice) return;
    const now = ctx?.currentTime || 0;
    try {
      voice.env.gain.setTargetAtTime(0, now, 0.01);
      setTimeout(() => {
        try { voice.osc.stop(); } catch(e) {}
        try { voice.sub.stop(); } catch(e) {}
      }, 100);
    } catch(e) {}
    acidVoices.delete(key);
  }

  // ─── Bass Synth ─────────────────────────────────────────────
  function _playBass(channel, note, vel, bus) {
    const now = ctx.currentTime;
    const freq = _midiToFreq(note);
    const key = `${channel}-${note}`;

    // Sawtooth + sub oscillator
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = freq / 2; // sub octave

    // Low-pass filter with envelope
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.linearRampToValueAtTime(2000 * vel + 400, now + 0.02);
    filter.frequency.exponentialRampToValueAtTime(600, now + 0.3);
    filter.Q.value = 6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vel * 0.7, now + 0.008);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(bus || masterGain);

    osc1.start(now);
    osc2.start(now);

    activeVoices.set(key, { osc: osc1, osc2, env, release: 0.08 });
  }

  // ─── Lead / Monosynth (Moog ladder-style) ─────────────────
  function _playSynth(channel, note, vel, bus) {
    const now = ctx.currentTime;
    const freq = _midiToFreq(note);
    const key = `${channel}-${note}`;

    // Sawtooth primary + slight detune for width
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = 0;

    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 7; // slight chorus detune

    // Ladder filter approximation: 2x cascade lowpass
    const f1 = ctx.createBiquadFilter();
    f1.type = 'lowpass';
    f1.frequency.setValueAtTime(400, now);
    f1.frequency.linearRampToValueAtTime(2200, now + 0.05);
    f1.frequency.exponentialRampToValueAtTime(1000, now + 0.4);
    f1.Q.value = 3;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'lowpass';
    f2.frequency.setValueAtTime(400, now);
    f2.frequency.linearRampToValueAtTime(2200, now + 0.05);
    f2.frequency.exponentialRampToValueAtTime(1000, now + 0.4);
    f2.Q.value = 2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vel * 0.45, now + 0.005); // 5ms attack

    const mix = ctx.createGain(); mix.gain.value = 0.5;

    osc.connect(mix); osc2.connect(mix);
    mix.connect(f1); f1.connect(f2);
    f2.connect(env); env.connect(bus || masterGain);

    osc.start(now); osc2.start(now);

    activeVoices.set(key, { osc, osc2, env, release: 0.15 });
  }

  // ─── Lead (specific track type) ─────────────────────────────
  function _playLead(channel, note, vel) {
    _playSynth(channel, note, vel);
  }

  // ─── Pad Synth ──────────────────────────────────────────────
  // FIX: Store all 5 oscillators to prevent voice leak
  function _playPad(channel, note, vel, bus) {
    const now = ctx.currentTime;
    const freq = _midiToFreq(note);
    const key = `${channel}-${note}`;

    const voices = [];
    const detunes = [-8, 0, 8, -4, 4];

    detunes.forEach(cents => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = cents;
      voices.push(osc);
    });

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(200, now);
    filter.frequency.linearRampToValueAtTime(2200, now + 0.8);
    filter.Q.value = 1.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vel * 0.25, now + 0.5); // slow attack

    voices.forEach(osc => {
      osc.connect(filter);
      osc.start(now);
    });
    filter.connect(env);
    env.connect(bus || masterGain);

    // Store ALL 5 voices to prevent oscillator leak
    activeVoices.set(key, {
      osc: voices[0], osc2: voices[1], osc3: voices[2],
      osc4: voices[3], osc5: voices[4],
      env, release: 0.6
    });
  }

  // ─── Trigger from sequencer ─────────────────────────────────
  // accent + slide are forwarded from step data
  function triggerNote(trackIdx, channel, note, velocity, gateSec, accent = false, slide = false) {
    if (!enabled) return;
    init(); // lazy init
    resume();

    const instrType = _getInstrType(channel, trackIdx);
    noteOn(channel, note, velocity, trackIdx, accent, slide);

    // Acid bass manages its own note-off (continuous until next note)
    // Drums self-decay; melodic synths need scheduled note-off
    const isSampler = window.SamplerEngine && SamplerEngine.getCategories().includes(instrType);
    if (instrType !== 'drum' && instrType !== 'acid' && !isSampler) {
      setTimeout(() => noteOff(channel, note), gateSec * 1000);
    }
  }

  // ─── Controls ───────────────────────────────────────────────
  function setEnabled(val) { enabled = val; }
  function isEnabled() { return enabled; }

  function setMasterVolume(vol) {
    masterVol = vol;
    if (masterGain) {
      masterGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.01);
    }
  }

  function setTrackInstrument(trackIdx, type) {
    if (trackInstruments[trackIdx]) {
      trackInstruments[trackIdx].type = type;
    }
  }

  function getTrackInstruments() { return trackInstruments; }

  function allNotesOff() {
    activeVoices.forEach((voice) => {
      try {
        const now = ctx?.currentTime || 0;
        voice.env.gain.cancelScheduledValues(now);
        voice.env.gain.setValueAtTime(0, now);
        voice.osc?.stop();
        voice.osc2?.stop();
        voice.osc3?.stop();
        voice.osc4?.stop();
        voice.osc5?.stop();
      } catch(e) {}
    });
    activeVoices.clear();
    // Also kill all acid voices
    acidVoices.forEach((_, ch) => _stopAcidBass(parseInt(ch.replace('acid-', ''))));
    acidVoices.clear();
  }

  function setTrackVolume(trackIdx, vol) {
    // vol: 0.0–1.0
    if (trackGainNodes[trackIdx] && ctx) {
      trackGainNodes[trackIdx].gain.setTargetAtTime(vol, ctx.currentTime, 0.015);
    }
  }

  // ─── Spatial FX Helpers ─────────────────────────────────────
  // FIX: Add combSum merge gain so all 4 comb outputs properly sum before allpass chain
  function _createReverb(ctx, decayTime) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const combSum = ctx.createGain(); // summation node for parallel combs
    combSum.gain.value = 0.25; // normalize by number of combs

    const combDelays = [0.029, 0.037, 0.041, 0.043];
    const combGains = [0.742, 0.733, 0.715, 0.697];
    const combs = combDelays.map((d, i) => {
      const delay = ctx.createDelay();
      delay.delayTime.value = d;
      const feedback = ctx.createGain();
      const fbVal = Math.min(0.95, Math.pow(combGains[i], decayTime));
      feedback.gain.value = fbVal;

      input.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      // Each comb output goes into the summation node
      delay.connect(combSum);
      return { delay, feedback };
    });

    const apDelays = [0.005, 0.0017];
    const apGains = [0.7, 0.7];
    const allpasses = apDelays.map((d, i) => {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 1 / d;
      ap.Q.value = apGains[i];
      return ap;
    });

    // Series: combSum → ap[0] → ap[1] → output
    combSum.connect(allpasses[0]);
    allpasses[0].connect(allpasses[1]);
    allpasses[1].connect(output);

    return {
      input,
      output,
      setDecay: (val) => {
        combs.forEach((c, i) => {
          const fbVal = Math.min(0.95, Math.pow(combGains[i], val));
          c.feedback.gain.setTargetAtTime(fbVal, ctx.currentTime, 0.05);
        });
      }
    };
  }

  function _createPingPongDelay(ctx, delayTime, feedbackVal) {
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    const delayL = ctx.createDelay(2.0);
    const delayR = ctx.createDelay(2.0);

    const fbL = ctx.createGain();
    const fbR = ctx.createGain();

    const input = ctx.createGain();
    const output = ctx.createGain();

    delayL.delayTime.setValueAtTime(delayTime, ctx.currentTime);
    delayR.delayTime.setValueAtTime(delayTime * 1.5, ctx.currentTime);

    fbL.gain.setValueAtTime(feedbackVal, ctx.currentTime);
    fbR.gain.setValueAtTime(feedbackVal, ctx.currentTime);

    const filterL = ctx.createBiquadFilter();
    const filterR = ctx.createBiquadFilter();
    filterL.type = 'lowpass';
    filterR.type = 'lowpass';
    filterL.frequency.value = 2200;
    filterR.frequency.value = 2200;

    input.connect(delayL);
    input.connect(delayR);

    delayL.connect(filterL);
    filterL.connect(fbL);
    fbL.connect(delayR);

    delayR.connect(filterR);
    filterR.connect(fbR);
    fbR.connect(delayL);

    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);

    merger.connect(output);

    return {
      input,
      output,
      setDelayTime: (val) => {
        delayL.delayTime.setTargetAtTime(val, ctx.currentTime, 0.1);
        delayR.delayTime.setTargetAtTime(val * 1.5, ctx.currentTime, 0.1);
      },
      setFeedback: (val) => {
        fbL.gain.setTargetAtTime(val, ctx.currentTime, 0.05);
        fbR.gain.setTargetAtTime(val, ctx.currentTime, 0.05);
      }
    };
  }

  function setReverbMix(mix) {
    reverbMixVal = mix;
    if (reverbWetGain && ctx) {
      reverbWetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.02);
      _updateDryGain();
    }
  }

  function setReverbDecay(decay) {
    reverbDecayVal = decay;
    if (reverbNode) {
      reverbNode.setDecay(decay);
    }
  }

  function setDelayMix(mix) {
    delayMixVal = mix;
    if (delayWetGain && ctx) {
      delayWetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.02);
      _updateDryGain();
    }
  }

  function setDelayTime(time) {
    delayTimeVal = time;
    if (delayNode) {
      delayNode.setDelayTime(time);
    }
  }

  function setDelayFeedback(fb) {
    delayFeedbackVal = fb;
    if (delayNode) {
      delayNode.setFeedback(fb);
    }
  }

  function _updateDryGain() {
    if (dryGain && ctx) {
      const dryVal = Math.max(0.1, 1.0 - reverbMixVal * 0.7 - delayMixVal * 0.7);
      dryGain.gain.setTargetAtTime(dryVal, ctx.currentTime, 0.02);
    }
  }

  function setReverbTone(freq) {
    // freq: 500–20000 Hz high-shelf cutoff
    if (reverbToneFilter && ctx) {
      reverbToneFilter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
    }
  }

  function setDelayTone(freq) {
    if (delayToneFilter && ctx) {
      delayToneFilter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
    }
  }

  return {
    init,
    resume,
    noteOn,
    noteOff,
    triggerNote,
    allNotesOff,
    setEnabled,
    isEnabled,
    setMasterVolume,
    setTrackInstrument,
    setTrackVolume,
    getTrackInstruments,
    setReverbMix,
    setReverbDecay,
    setReverbTone,
    setDelayMix,
    setDelayTime,
    setDelayFeedback,
    setDelayTone,
  };

})();

window.AudioEngine = AudioEngine;
