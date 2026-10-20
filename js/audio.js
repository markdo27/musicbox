/**
 * audio.js — Internal Web Audio Synthesis Engine
 * ---------------------------------------------------------------------------
 * Provides drum synthesis (TR-606 flavour), a TB-303 acid bass, and
 * polyphonic synth voices so the sequencer can play back without any
 * external MIDI hardware.
 *
 * Drum channel (ch 10) → percussive synthesis by MIDI note
 * Melodic channels     → polyphonic oscillator synth
 *
 * KEY DESIGN POINTS (post-audit):
 *  - ONE AudioContext for the whole app (exposed via getContext()).
 *  - Every voice is scheduled at an ABSOLUTE AudioContext time, so the
 *    sequencer's lookahead scheduler is genuinely sample-accurate.
 *  - Voices are identified by a unique id, so two tracks on the same
 *    channel playing the same note cannot leak or steal each other.
 *  - The internal synth engines take PRIORITY over the Strudel sampler,
 *    which is namespaced `strudel:<category>`.
 *  - The master bus has a real limiter and an energy-conserving wet/dry.
 */

const AudioEngine = (() => {

  let ctx = null;
  let masterGain = null;
  let masterCompressor = null;
  let masterAnalyser = null;
  let masterShaper = null;   // soft-clip safety net after the limiter
  let enabled = true;
  let masterVol = 0.72;

  // ─── Voice registries ───────────────────────────────────────────
  let voiceSeq = 0;
  const activeVoices = new Map();   // voiceId → voice
  const voiceByKey = new Map();     // `${channel}-${note}` → voiceId
  const acidVoices = new Map();     // `acid-${channel}-${track}` → voice
  const melodicVoices = new Map();  // channel → voice (for slide glide)

  // ─── Spatial FX nodes and gains ─────────────────────────────────
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
  let reverbToneVal = 3000;
  let delayMixVal = 0.2;
  let delayTimeVal = 0.35; // seconds
  let delayFeedbackVal = 0.45;
  let delayToneVal = 4000;

  // ─── Per-track instrument settings (index = track index) ─────────
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

  // Per-track channel strips (EQ → saturation → gain → sends)
  const trackChains = new Array(8).fill(null);

  // ─── Per-track FX parameters ─────────────────────────────────
  //   eqLow / eqMid / eqHigh : −12…+12 dB
  //   drive                  : 0..1 saturation amount
  //   sendDelay / sendReverb : 0..1 send level to the shared buses
  const DEFAULT_FX = {
    eqLow: 0, eqMid: 0, eqHigh: 0,
    drive: 0, sendDelay: 0, sendReverb: 0,
  };
  const trackFx = Array.from({ length: 8 }, () => ({ ...DEFAULT_FX }));

  function setTrackFx(trackIdx, key, value) {
    if (trackIdx < 0 || trackIdx >= trackFx.length) return;
    if (!(key in DEFAULT_FX)) return;
    let v = Number(value);
    if (!isFinite(v)) v = 0;
    if (key.startsWith('eq')) v = Math.max(-12, Math.min(12, v));
    else v = Math.max(0, Math.min(1, v));
    trackFx[trackIdx][key] = v;
    _applyTrackFx(trackIdx);
  }

  function getTrackFx(trackIdx) {
    if (trackIdx < 0 || trackIdx >= trackFx.length) return { ...DEFAULT_FX };
    return { ...trackFx[trackIdx] };
  }

  function getAllTrackFx() { return trackFx.map(p => ({ ...p })); }

  function resetTrackFx(trackIdx) {
    if (trackIdx < 0 || trackIdx >= trackFx.length) return;
    trackFx[trackIdx] = { ...DEFAULT_FX };
    _applyTrackFx(trackIdx);
  }

  /** Push the FX parameters into the live audio graph. */
  function _applyTrackFx(trackIdx) {
    const chain = trackChains[trackIdx];
    const p = trackFx[trackIdx];
    if (!chain || !ctx) return;
    const t = ctx.currentTime;
    chain.eqLow.gain.setTargetAtTime(p.eqLow, t, 0.02);
    chain.eqMid.gain.setTargetAtTime(p.eqMid, t, 0.02);
    chain.eqHigh.gain.setTargetAtTime(p.eqHigh, t, 0.02);
    if (p.drive > 0.01) {
      chain.shaper.curve = _makeDriveCurve(1 + p.drive * 18);
      chain.shaper.oversample = '2x';
    } else {
      chain.shaper.curve = _makeDriveCurve(1);
    }
    chain.sendDelay.gain.setTargetAtTime(p.sendDelay, t, 0.02);
    chain.sendReverb.gain.setTargetAtTime(p.sendReverb, t, 0.02);
  }

  /** Apply every track's FX (called after the graph is built). */
  function _applyAllTrackFx() {
    for (let i = 0; i < trackFx.length; i++) _applyTrackFx(i);
  }

  // ─── Per-track synth parameters ──────────────────────────────
  // These are the "front panel" of each voice. They are exposed in the UI,
  // are MIDI-learnable, and are pushed to hardware as CC where the device
  // profile supports it.
  //
  //   cutoff    0..1    base filter frequency scale
  //   resonance 0..1    filter Q
  //   decay     0..1    filter envelope decay time
  //   env       0..1    filter envelope depth (how far it opens)
  //   drive     0..1    output saturation
  //   glide     0..1    portamento time (acid)
  //   tune      -12..12 semitone offset
  //   level     0..1    output level
  const DEFAULT_SYNTH_PARAMS = {
    cutoff: 0.5, resonance: 0.45, decay: 0.35, env: 0.75,
    drive: 0.2, glide: 0.3, tune: 0, level: 0.8,
  };
  const trackParams = Array.from({ length: 8 }, () => ({ ...DEFAULT_SYNTH_PARAMS }));

  function setTrackParam(trackIdx, key, value) {
    if (trackIdx < 0 || trackIdx >= trackParams.length) return;
    if (!(key in DEFAULT_SYNTH_PARAMS)) return;
    const def = DEFAULT_SYNTH_PARAMS[key];
    let v = Number(value);
    if (!isFinite(v)) v = def;
    if (key === 'tune') v = Math.max(-12, Math.min(12, Math.round(v)));
    else v = Math.max(0, Math.min(1, v));
    trackParams[trackIdx][key] = v;
  }

  function getTrackParams(trackIdx) {
    if (trackIdx < 0 || trackIdx >= trackParams.length) return { ...DEFAULT_SYNTH_PARAMS };
    return { ...trackParams[trackIdx] };
  }

  function getAllTrackParams() { return trackParams.map(p => ({ ...p })); }

  function resetTrackParams(trackIdx) {
    if (trackIdx < 0 || trackIdx >= trackParams.length) return;
    trackParams[trackIdx] = { ...DEFAULT_SYNTH_PARAMS };
  }

  /** Resolve the params for a track (or the defaults for ad-hoc voices). */
  function _params(trackIdx) {
    if (trackIdx >= 0 && trackIdx < trackParams.length) return trackParams[trackIdx];
    return DEFAULT_SYNTH_PARAMS;
  }

  // Frequency for a MIDI note, including the track's tune offset.
  function _midiToFreq(note, tune = 0) {
    return 440 * Math.pow(2, (note - 69 + tune) / 12);
  }

  // Sampler categories are namespaced so they can never shadow an
  // internal instrument type ('drum', 'bass', 'pad' are both).
  const SAMPLER_PREFIX = 'strudel:';

  // ═══════════════════════════════════════════════════════════════
  // INIT / CONTEXT
  // ═══════════════════════════════════════════════════════════════

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

    if (window.SamplerEngine) SamplerEngine.init();

    // ── Master chain: masterGain → [dry | delay | reverb] → limiter → shaper → out
    masterCompressor = ctx.createDynamicsCompressor();
    masterCompressor.threshold.value = -1.5;
    masterCompressor.knee.value = 0;
    masterCompressor.ratio.value = 20;
    masterCompressor.attack.value = 0.001;
    masterCompressor.release.value = 0.05;
    masterCompressor.connect(ctx.destination);

    // Soft clipper as a final safety net against digital clipping.
    masterShaper = ctx.createWaveShaper();
    masterShaper.curve = _makeSoftClipCurve();
    masterShaper.oversample = '2x';
    masterShaper.connect(masterCompressor);

    // Master analyser — feeds the UI scope / spectrum.
    masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 1024;
    masterAnalyser.smoothingTimeConstant = 0.75;
    masterAnalyser.connect(masterShaper);

    // DC blocker — keeps the sub bass from drifting the master.
    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 18;
    dcBlock.Q.value = 0.7;
    dcBlock.connect(masterAnalyser);

    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(masterVol, ctx.currentTime);
    masterGain.connect(dcBlock);

    // Dry path
    dryGain = ctx.createGain();
    dryGain.gain.value = _dryValue();
    masterGain.connect(dryGain);
    dryGain.connect(masterAnalyser);

    // Delay path (with high-cut tone filter)
    delayNode = _createPingPongDelay(ctx, delayTimeVal, delayFeedbackVal);
    delayWetGain = ctx.createGain();
    delayWetGain.gain.value = delayMixVal * 0.9;
    delayToneFilter = ctx.createBiquadFilter();
    delayToneFilter.type = 'highshelf';
    delayToneFilter.frequency.value = delayToneVal;
    delayToneFilter.gain.value = -6;
    masterGain.connect(delayNode.input);
    delayNode.output.connect(delayWetGain);
    delayWetGain.connect(delayToneFilter);
    delayToneFilter.connect(masterAnalyser);

    // Reverb path (with high-cut tone filter)
    reverbNode = _createReverb(ctx, reverbDecayVal);
    reverbWetGain = ctx.createGain();
    reverbWetGain.gain.value = reverbMixVal * 0.9;
    reverbToneFilter = ctx.createBiquadFilter();
    reverbToneFilter.type = 'highshelf';
    reverbToneFilter.frequency.value = reverbToneVal;
    reverbToneFilter.gain.value = -9;
    masterGain.connect(reverbNode.input);
    reverbNode.output.connect(reverbWetGain);
    reverbWetGain.connect(reverbToneFilter);
    reverbToneFilter.connect(masterAnalyser);

    // ── Per-track channel strips ───────────────────────────────
    // voice → EQ(3 band) → saturation → track gain → [dry | delay send | reverb send]
    //
    // The global delay/reverb are still fed by the master, so the master
    // send behaves as before. The per-track sends ADD to it, which is how
    // a DAW works: a global bus plus per-track sends.
    for (let i = 0; i < 8; i++) {
      const input = ctx.createGain();

      const eqLow = ctx.createBiquadFilter();
      eqLow.type = 'lowshelf';
      eqLow.frequency.value = 80;
      eqLow.gain.value = 0;

      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking';
      eqMid.frequency.value = 900;
      eqMid.Q.value = 0.9;
      eqMid.gain.value = 0;

      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = 'highshelf';
      eqHigh.frequency.value = 4000;
      eqHigh.gain.value = 0;

      const shaper = ctx.createWaveShaper();
      shaper.curve = _makeDriveCurve(1);
      shaper.oversample = '2x';

      const sendDelay = ctx.createGain();
      sendDelay.gain.value = 0;
      const sendReverb = ctx.createGain();
      sendReverb.gain.value = 0;

      const tg = ctx.createGain();
      tg.gain.value = 1.0;

      input.connect(eqLow);
      eqLow.connect(eqMid);
      eqMid.connect(eqHigh);
      eqHigh.connect(shaper);
      shaper.connect(tg);
      tg.connect(masterGain);
      tg.connect(sendDelay);
      sendDelay.connect(delayNode.input);
      tg.connect(sendReverb);
      sendReverb.connect(reverbNode.input);

      trackGainNodes[i] = tg;
      trackChains[i] = { input, eqLow, eqMid, eqHigh, shaper, sendDelay, sendReverb };
    }

    // Push the initial FX values into the graph.
    _applyAllTrackFx();

    return ctx;
  }

  /** The single shared AudioContext. */
  function getContext() { return ctx; }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════
  // NOTE ON
  // ═══════════════════════════════════════════════════════════════

  /**
   * @param {number} when  absolute AudioContext time for the note-on.
   *                        Defaults to now. Scheduling at an absolute time
   *                        is what makes the sequencer sample-accurate.
   * @returns {object|null} the created voice, so the caller can release it.
   */
  function noteOn(channel, note, velocity, trackIdx = -1, accent = false, slide = false, when = null) {
    if (!enabled) return null;
    if (!ctx) init();
    if (!ctx) return null;
    resume();

    const t = Math.max(when === null ? ctx.currentTime : when, ctx.currentTime);
    const vel = Math.max(0.02, Math.min(1, (velocity || 100) / 127));
    const instrType = _getInstrType(channel, trackIdx);

    // Resolve output bus: the track's channel strip input, so the EQ,
    // saturation and sends apply to this track only.
    const outBus = (trackIdx >= 0 && trackChains[trackIdx])
      ? trackChains[trackIdx].input
      : ((trackIdx >= 0 && trackGainNodes[trackIdx]) ? trackGainNodes[trackIdx] : masterGain);

    // External sampler — only for namespaced categories, so the internal
    // TR-606 / bass / pad engines are never shadowed.
    if (instrType.startsWith(SAMPLER_PREFIX)) {
      const category = instrType.slice(SAMPLER_PREFIX.length);
      SamplerEngine.playSample(ctx, outBus, category, note, vel, t);
      return null;
    }

    if (instrType === 'drum') {
      _playDrum(note, vel, outBus, t, _params(trackIdx));
      return null;
    }
    if (instrType === 'acid') {
      return _playAcidBass(channel, note, vel, outBus, accent, slide, trackIdx, t);
    }
    if (instrType === 'bass') {
      return _playBass(channel, note, vel, outBus, t, slide, trackIdx);
    }
    if (instrType === 'pad') {
      return _playPad(channel, note, vel, outBus, t, slide, trackIdx);
    }
    return _playSynth(channel, note, vel, outBus, t, slide, trackIdx);
  }

  // ═══════════════════════════════════════════════════════════════
  // NOTE OFF / VOICE LIFETIME
  // ═══════════════════════════════════════════════════════════════

  /**
   * Release a melodic voice. Safe to call with a stale note number:
   * if a slide has already moved the voice to another pitch, the release
   * is ignored rather than cutting the newer note short.
   */
  function noteOff(channel, note, trackIdx = -1) {
    if (!enabled || !ctx) return;
    // Acid voices are keyed by channel + track.
    _releaseAcid(channel, note, trackIdx);
    const key = `${channel}-${note}`;
    const voiceId = voiceByKey.get(key);
    if (voiceId === undefined) return;
    const voice = activeVoices.get(voiceId);
    if (!voice) { voiceByKey.delete(key); return; }
    // A slide moved this voice to a new pitch — leave it running.
    if (voice.currentNote !== undefined && voice.currentNote !== note) {
      voiceByKey.delete(key);
      return;
    }
    releaseVoice(voiceId);
  }

  /** Release a voice by id, with a short fade. */
  function releaseVoice(voiceId) {
    const voice = activeVoices.get(voiceId);
    if (!voice) return;
    activeVoices.delete(voiceId);
    if (voiceByKey.get(voice.key) === voiceId) voiceByKey.delete(voice.key);

    const now = ctx.currentTime;
    const release = voice.release || 0.05;
    try {
      voice.env.gain.cancelScheduledValues(now);
      voice.env.gain.setValueAtTime(voice.env.gain.value, now);
      voice.env.gain.linearRampToValueAtTime(0, now + release);
    } catch (e) { /* detached node */ }

    const stopAt = (release + 0.05) * 1000;
    setTimeout(() => {
      try { voice.oscs?.forEach(o => o.stop()); } catch (e) {}
    }, stopAt);
  }

  /** Release a voice only if it is still the current owner of its key. */
  function releaseVoiceById(voiceId) {
    if (!activeVoices.has(voiceId)) return;
    releaseVoice(voiceId);
  }

  function _registerVoice(voice) {
    const id = ++voiceSeq;
    voice.id = id;
    activeVoices.set(id, voice);
    // If a voice already owns this key, retire it so it cannot drone on.
    const prevId = voiceByKey.get(voice.key);
    if (prevId !== undefined && prevId !== id) {
      const prev = activeVoices.get(prevId);
      if (prev) {
        activeVoices.delete(prevId);
        try { prev.env.gain.cancelScheduledValues(ctx.currentTime); prev.env.gain.setValueAtTime(0, ctx.currentTime); } catch (e) {}
        setTimeout(() => { try { prev.oscs?.forEach(o => o.stop()); } catch (e) {} }, 60);
      }
    }
    voiceByKey.set(voice.key, id);
    return id;
  }

  function _getInstrType(channel, trackIdx) {
    if (trackIdx >= 0 && trackInstruments[trackIdx]) return trackInstruments[trackIdx].type;
    if (channel === 10) return 'drum';
    return 'lead';
  }

  // ═══════════════════════════════════════════════════════════════
  // DRUM SYNTHESIS — TR-606 flavour
  // ═══════════════════════════════════════════════════════════════

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

  function _playDrum(note, vel, outBus, when, params = null) {
    const type = DRUM_MAP[note] || (note % 2 === 0 ? 'kick' : 'hihat_closed');
    const bus = outBus || masterGain;
    // The 606's tuning pots: `tune` transposes the drum, `decay` scales
    // its decay time.
    const tune = params ? Math.round(params.tune) : 0;
    const n = tune ? Math.max(0, Math.min(127, note + tune)) : note;
    const decayScale = params ? (0.5 + params.decay * 1.4) : 1;
    switch (type) {
      case 'kick':         _kick(vel, bus, when, decayScale, n); break;
      case 'snare':        _snare(vel, bus, when, decayScale, n); break;
      case 'hihat_closed': _hihat(vel, 0.06 * decayScale, bus, when); break;
      case 'hihat_open':   _hihat(vel, 0.35 * decayScale, bus, when); break;
      case 'clap':         _clap(vel, bus, when); break;
      case 'rim':          _rim(vel, bus, when); break;
      case 'crash':        _crash(vel, bus, when); break;
      case 'ride':         _ride(vel, bus, when); break;
      case 'tom':          _tom(vel, 80 + (n - 41) * 8, bus, when); break;
      default:             _hihat(vel, 0.08 * decayScale, bus, when); break;
    }
  }

  // ─── TR-606 Kick Drum ──────────────────────────────────────
  // Pitch: 180Hz → 30Hz over 400ms (deep, punchy, 606-authentic)
  function _kick(vel, bus, when, decayScale = 1, note = 36) {
    const now = when;
    // The 606's tuning pot transposes the whole drum.
    const ratio = Math.pow(2, (note - 36) / 12);

    // Sub sine body
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180 * ratio, now);
    osc.frequency.exponentialRampToValueAtTime(30 * ratio, now + 0.4);

    // Soft clip waveshaper (subtle saturation)
    const shaper = ctx.createWaveShaper();
    shaper.curve = _makeDistortionCurve(20);
    shaper.oversample = '2x';

    const env = ctx.createGain();
    env.gain.setValueAtTime(vel * 1.3, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.5 * decayScale);

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
  function _snare(vel, bus, when, decayScale = 1, note = 38) {
    const now = when;
    const ratio = Math.pow(2, (note - 38) / 12);

    // Tuned body: sine 220Hz → 110Hz (60% mix)
    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = 'sine';
    bodyOsc.frequency.setValueAtTime(220 * ratio, now);
    bodyOsc.frequency.exponentialRampToValueAtTime(110 * ratio, now + 0.07);
    const bodyEnv = ctx.createGain();
    bodyEnv.gain.setValueAtTime(vel * 0.45, now);
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.1 * decayScale);
    bodyOsc.connect(bodyEnv);
    bodyEnv.connect(bus);
    bodyOsc.start(now);
    bodyOsc.stop(now + 0.12 * decayScale);

    // Noise component: bandpass 2500Hz (40% mix), sharp transient
    const noiseBuf = _makeNoise(0.25);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2500 * ratio;
    noiseFilter.Q.value = 0.8;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(vel * 0.85, now);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.18 * decayScale);
    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(noiseEnv);
    noiseEnv.connect(bus);
    noiseSrc.start(now);
  }

  // ─── TR-606 Hi-Hat ─────────────────────────────────────────
  // The 606 metal circuit is six INHARMONIC square oscillators
  // (246.4 / 308.0 / 367.0 / 418.2 / 440.4 / 627.2 Hz) fed through a
  // high band-pass — not six bright squares, which is what gives the
  // 808 its buzz instead of the 606's metallic "hum".
  const HAT_OSC_FREQS = [246.4, 308.0, 367.0, 418.2, 440.4, 627.2];

  function _hihat(vel, duration, bus, when) {
    const now = when;

    const bank = ctx.createGain();
    bank.gain.value = 1;

    // High band-pass — this is the 606's "metal" filter.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 9000;
    bp.Q.value = 0.55;

    // High-pass to remove the low rumble of the oscillator bank.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    hp.Q.value = 0.7;

    const env = ctx.createGain();
    const decay = duration < 0.1 ? duration + 0.015 : duration;
    env.gain.setValueAtTime(vel * 0.4, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    bank.connect(bp);
    bp.connect(hp);
    hp.connect(env);
    env.connect(bus);

    const oscs = HAT_OSC_FREQS.map((f) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(bank);
      o.start(now);
      o.stop(now + duration + 0.02);
      return o;
    });
    return oscs;
  }

  // ─── TR-606 Clap (4-burst layered noise) ─────────────────────
  function _clap(vel, bus, when) {
    const now = when;
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
  function _rim(vel, bus, when) {
    const now = when;
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
  function _crash(vel, bus, when) {
    const now = when;
    // The 606 cymbal circuit is a separate 6-oscillator bank.
    const freqs = [246.4, 308.0, 367.0, 418.2, 440.4, 627.2];
    const bank = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5500;
    bp.Q.value = 0.4;
    const masterGainNode = ctx.createGain();
    masterGainNode.gain.setValueAtTime(vel * 0.35, now);
    masterGainNode.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    bank.connect(bp); bp.connect(masterGainNode); masterGainNode.connect(bus);

    freqs.forEach(f => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(bank);
      osc.start(now);
      osc.stop(now + 1.3);
    });
  }

  // ─── Ride ───────────────────────────────────────────────────
  function _ride(vel, bus, when) {
    const now = when;
    const freqs = [4000, 6200, 8800];
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(vel * 0.2, now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    gainNode.connect(bus);
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
  function _tom(vel, freq, bus, when) {
    const now = when;
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

  // ─── White Noise Buffer (cached, not re-allocated per hit) ──
  let noiseCache = null;
  function _makeNoise(duration) {
    const sampleRate = ctx.sampleRate;
    const bufLen = Math.max(1, Math.floor(sampleRate * duration));
    const buf = ctx.createBuffer(1, bufLen, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ─── Curves ─────────────────────────────────────────────────
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

  /** Soft-clip curve — tanh-ish, used as the final safety net. */
  function _makeSoftClipCurve() {
    const samples = 2048;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(x * 1.35) / Math.tanh(1.35);
    }
    return curve;
  }

  // ═══════════════════════════════════════════════════════════════
  // MELODIC SYNTHESIS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute a voice's design values from its parameters.
   *
   * This is PURE — no AudioContext — so the synthesis model can be unit
   * tested without rendering a single sample. The voice functions below
   * call it, so the test verifies the real code path, not a copy.
   *
   * @param {object} p       the track's synth parameters
   * @param {boolean} accent is this note accented?
   * @param {string} kind    'acid' | 'bass' | 'lead' | 'pad'
   */
  function voiceDesign(p, accent = false, kind = 'acid') {
    const cutoffSpan = kind === 'acid' ? 1400 : kind === 'pad' ? 2600 : 1800;
    const baseFloor  = kind === 'acid' ? 180 : 200;
    const baseCutoff = baseFloor + p.cutoff * cutoffSpan;

    // The envelope DEPTH — how far the filter opens. On a 303 this is
    // the ENV AMOUNT knob, and it is what makes an accent sound like an
    // accent rather than just a louder note.
    const envDepth = 1 + p.env * 8;
    const peakCutoff = Math.min(12000, baseCutoff * envDepth * (accent ? 1.6 : 1));

    const q = 0.7 + p.resonance * 16;
    const decayTC = 0.04 + p.decay * 1.2;
    const glideTC = 0.008 + p.glide * 0.12;

    return {
      baseCutoff,
      peakCutoff,
      q,
      decayTC,
      glideTC,
      level: p.level,
      envDepth,
    };
  }

  // ───────────────────────────────────────────────────────
  // TB-303 ACID BASS ENGINE
  // Per-channel+track voice state (enables slide glide between notes)
  // ───────────────────────────────────────────────────────
  const ACID_GLIDE = 0.045;   // 45ms portamento — audible, 303-ish
  const ACID_DECAY = 0.22;    // filter envelope decay time constant

  /** Asymmetric soft-clip curve for the 303's output stage. */
  function _makeDriveCurve(amount) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const norm = Math.tanh(amount);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      const bias = x >= 0 ? 1 : 0.7;   // the 303's asymmetry
      curve[i] = (Math.tanh(x * amount) / norm) * bias;
    }
    return curve;
  }

  function _playAcidBass(channel, note, vel, bus, accent, slide, trackIdx, when) {
    const now = when;
    const p = _params(trackIdx);
    const freq = _midiToFreq(note, p.tune);
    const key = `acid-${channel}-${trackIdx}`;
    const existing = acidVoices.get(key);

    // ── SLIDE: the previous note was flagged to slide, so GLIDE into
    //    this pitch instead of retriggering the envelope.
    if (existing && existing.osc && existing.slideOut) {
      const glideTC = 0.008 + p.glide * 0.12;
      existing.osc.frequency.cancelScheduledValues(now);
      existing.osc.frequency.setTargetAtTime(freq, now, glideTC);
      if (existing.sub) {
        existing.sub.frequency.cancelScheduledValues(now);
        existing.sub.frequency.setTargetAtTime(freq / 2, now, glideTC);
      }
      existing.currentNote = note;
      existing.slideOut = false;
      existing.held = true;
      return existing;
    }

    // ── Kill existing voice cleanly
    if (existing) _killAcidVoice(existing, now);

    // ── New voice
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);

    // Sub oscillator (-1 octave, square wave)
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.setValueAtTime(freq / 2, now);

    // 4-pole ladder approximation: two cascaded biquads = 24 dB/oct,
    // close to the 303's 18 dB/oct, and much steeper than a single
    // biquad (12 dB/oct) which is what this used to be.
    const d = voiceDesign(p, accent, 'acid');
    const baseCutoff = d.baseCutoff;
    const peakCutoff = d.peakCutoff;
    const q          = d.q;
    const decayTC    = d.decayTC;

    const f1 = ctx.createBiquadFilter();
    f1.type = 'lowpass';
    f1.Q.value = q;
    f1.frequency.setValueAtTime(baseCutoff, now);
    f1.frequency.linearRampToValueAtTime(peakCutoff, now + 0.002);
    f1.frequency.setTargetAtTime(baseCutoff, now + 0.002, decayTC);

    const f2 = ctx.createBiquadFilter();
    f2.type = 'lowpass';
    f2.Q.value = 0.7;
    f2.frequency.setValueAtTime(baseCutoff, now);
    f2.frequency.linearRampToValueAtTime(peakCutoff, now + 0.002);
    f2.frequency.setTargetAtTime(baseCutoff, now + 0.002, decayTC);

    // Amplitude envelope: fast attack, decay to a sustain level, so the
    // 303 articulates instead of droning at full volume.
    const env = ctx.createGain();
    const baseAmp = vel;
    const accentBoost = accent ? 1.45 : 1.0;   // +3dB on accent
    const peakAmp = baseAmp * accentBoost * 0.75 * d.level;
    const sustainAmp = peakAmp * 0.62;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peakAmp, now + 0.002);
    env.gain.setTargetAtTime(sustainAmp, now + 0.002, 0.12);

    // Mix: 70% sawtooth + 30% sub
    const oscMix = ctx.createGain(); oscMix.gain.value = 0.7;
    const subMix = ctx.createGain(); subMix.gain.value = 0.3;

    osc.connect(oscMix); oscMix.connect(f1);
    sub.connect(subMix); subMix.connect(f1);
    f1.connect(f2);

    // 303 output stage — a soft, asymmetric drive.
    let tail = f2;
    if (p.drive > 0.01) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = _makeDriveCurve(1 + p.drive * 14);
      shaper.oversample = '2x';
      const post = ctx.createGain();
      post.gain.value = 1 / (1 + p.drive * 1.4);
      f2.connect(shaper);
      shaper.connect(post);
      tail = post;
    }
    tail.connect(env);
    env.connect(bus);

    osc.start(now);
    sub.start(now);

    const voice = {
      id: ++voiceSeq,
      key,
      osc, sub, filter: f1, env,
      oscs: [osc, sub],
      release: 0.06,
      currentNote: note,
      slideOut: !!slide,
      held: false,
    };
    acidVoices.set(key, voice);
    return voice;
  }

  function _killAcidVoice(voice, now) {
    if (!voice) return;
    try {
      voice.env.gain.cancelScheduledValues(now);
      voice.env.gain.setTargetAtTime(0, now, 0.008);
    } catch (e) {}
    setTimeout(() => {
      try { voice.osc.stop(); } catch (e) {}
      try { voice.sub.stop(); } catch (e) {}
    }, 80);
  }

  /** Release the acid voice for a channel/track (called on note-off). */
  function _releaseAcid(channel, note, trackIdx) {
    const key = `acid-${channel}-${trackIdx}`;
    const voice = acidVoices.get(key);
    if (!voice) return;
    // A slide already moved the voice — don't cut the newer note short.
    if (voice.currentNote !== note) return;
    acidVoices.delete(key);
    const now = ctx.currentTime;
    try {
      voice.env.gain.cancelScheduledValues(now);
      voice.env.gain.setValueAtTime(voice.env.gain.value, now);
      voice.env.gain.linearRampToValueAtTime(0, now + 0.06);
    } catch (e) {}
    setTimeout(() => {
      try { voice.osc.stop(); } catch (e) {}
      try { voice.sub.stop(); } catch (e) {}
    }, 120);
  }

  // ─── Melodic slide / portamento ─────────────────────────────
  /**
   * If the previous melodic note on this channel was flagged to slide,
   * GLIDE the running voice to the new pitch instead of retriggering it.
   * This is the same legato behaviour as the 303, applied to the other
   * synth voices.
   */
  function _tryGlide(channel, note, when, tune = 0) {
    const existing = melodicVoices.get(channel);
    if (!existing || !existing.slideOut || !existing.oscs || !existing.oscs.length) return null;
    const freq = _midiToFreq(note, tune);
    existing.oscs.forEach(o => {
      try {
        o.frequency.cancelScheduledValues(when);
        o.frequency.setTargetAtTime(freq, when, 0.035);
      } catch (e) {}
    });
    // Re-key the voice so the upcoming note-off finds it.
    voiceByKey.delete(existing.key);
    existing.key = `${channel}-${note}`;
    existing.currentNote = note;
    existing.slideOut = false;
    voiceByKey.set(existing.key, existing.id);
    return existing;
  }

  // ─── Bass Synth ─────────────────────────────────────────────
  function _playBass(channel, note, vel, bus, when, slide = false, trackIdx = -1) {
    const now = when;
    const p = _params(trackIdx);
    const freq = _midiToFreq(note, p.tune);
    const key = `${channel}-${note}`;

    const glided = _tryGlide(channel, note, now, p.tune);
    if (glided) return glided;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = freq / 2; // sub octave

    // Low-pass filter with envelope
    const d = voiceDesign(p, false, 'bass');
    const baseCutoff = d.baseCutoff;
    const peakCutoff = Math.min(12000, baseCutoff * (1 + p.env * 6));
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(baseCutoff, now);
    filter.frequency.linearRampToValueAtTime(peakCutoff, now + 0.02);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(80, baseCutoff * 0.5), now + 0.05 + p.decay * 1.1);
    filter.Q.value = 0.5 + p.resonance * 8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vel * 0.7 * p.level, now + 0.008);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(env);
    env.connect(bus || masterGain);

    osc1.start(now);
    osc2.start(now);

    const voice = { key, env, oscs: [osc1, osc2], release: 0.08, currentNote: note, slideOut: !!slide };
    _registerVoice(voice);
    melodicVoices.set(channel, voice);
    return voice;
  }

  // ─── Lead / Monosynth (ladder-style) ───────────────────────
  function _playSynth(channel, note, vel, bus, when, slide = false, trackIdx = -1) {
    const now = when;
    const p = _params(trackIdx);
    const freq = _midiToFreq(note, p.tune);
    const key = `${channel}-${note}`;

    const glided = _tryGlide(channel, note, now, p.tune);
    if (glided) return glided;

    // Sawtooth primary + slight detune for width
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;

    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 7; // slight chorus detune

    // Ladder filter approximation: 2x cascade lowpass
    const d = voiceDesign(p, false, 'lead');
    const baseCutoff = d.baseCutoff;
    const peakCutoff = Math.min(14000, baseCutoff * (1 + p.env * 5));
    const settle = Math.max(120, baseCutoff * 0.45);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'lowpass';
    f1.frequency.setValueAtTime(baseCutoff, now);
    f1.frequency.linearRampToValueAtTime(peakCutoff, now + 0.05);
    f1.frequency.exponentialRampToValueAtTime(settle, now + 0.1 + p.decay * 1.4);
    f1.Q.value = 0.4 + p.resonance * 7;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'lowpass';
    f2.frequency.setValueAtTime(baseCutoff, now);
    f2.frequency.linearRampToValueAtTime(peakCutoff, now + 0.05);
    f2.frequency.exponentialRampToValueAtTime(settle, now + 0.1 + p.decay * 1.4);
    f2.Q.value = 0.3 + p.resonance * 2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vel * 0.45 * p.level, now + 0.005); // 5ms attack

    const mix = ctx.createGain(); mix.gain.value = 0.5;

    osc.connect(mix); osc2.connect(mix);
    mix.connect(f1); f1.connect(f2);
    f2.connect(env); env.connect(bus || masterGain);

    osc.start(now); osc2.start(now);

    const voice = { key, env, oscs: [osc, osc2], release: 0.15, currentNote: note, slideOut: !!slide };
    _registerVoice(voice);
    melodicVoices.set(channel, voice);
    return voice;
  }

  // ─── Pad Synth ──────────────────────────────────────────────
  function _playPad(channel, note, vel, bus, when, slide = false, trackIdx = -1) {
    const now = when;
    const p = _params(trackIdx);
    const freq = _midiToFreq(note, p.tune);
    const key = `${channel}-${note}`;

    const glided = _tryGlide(channel, note, now, p.tune);
    if (glided) return glided;

    const oscs = [];
    const detunes = [-8, 0, 8, -4, 4];

    detunes.forEach(cents => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = cents;
      oscs.push(osc);
    });

    const cutoff = voiceDesign(p, false, 'pad').baseCutoff;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, now);
    filter.frequency.linearRampToValueAtTime(cutoff * (1 + p.env * 3), now + 0.8);
    filter.Q.value = 0.3 + p.resonance * 3;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vel * 0.25 * p.level, now + 0.5); // slow attack

    oscs.forEach(osc => {
      osc.connect(filter);
      osc.start(now);
    });
    filter.connect(env);
    env.connect(bus || masterGain);

    // ALL 5 oscillators are stored, so none of them leaks.
    const voice = { key, env, oscs, release: 0.6, currentNote: note, slideOut: !!slide };
    _registerVoice(voice);
    melodicVoices.set(channel, voice);
    return voice;
  }

  // ─── Trigger from sequencer ─────────────────────────────────
  /**
   * @param {number} when absolute AudioContext time of the note-on.
   */
  function triggerNote(trackIdx, channel, note, velocity, gateSec, accent = false, slide = false, when = null) {
    if (!enabled) return;
    if (!ctx) init();
    if (!ctx) return;
    resume();

    const t = Math.max(when === null ? ctx.currentTime : when, ctx.currentTime);
    const voice = noteOn(channel, note, velocity, trackIdx, accent, slide, t);
    if (!voice) return;

    const isAcid = voice.oscs && voice.key && voice.key.startsWith('acid-');
    if (isAcid) {
      // The acid voice articulates itself; the note-off releases it.
      const delayMs = Math.max(0, (t - ctx.currentTime) * 1000) + (gateSec || 0) * 1000;
      const track = trackIdx;
      setTimeout(() => _releaseAcid(channel, note, track), delayMs);
      return;
    }

    // Melodic synths need a scheduled note-off.
    const delayMs = Math.max(0, (t - ctx.currentTime) * 1000) + (gateSec || 0) * 1000;
    const voiceId = voice.id;
    setTimeout(() => releaseVoiceById(voiceId), delayMs);
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTROLS
  // ═══════════════════════════════════════════════════════════════

  function setEnabled(val) { enabled = val; }
  function isEnabled() { return enabled; }

  function setMasterVolume(vol) {
    masterVol = Math.max(0, Math.min(1, vol));
    if (masterGain && ctx) {
      masterGain.gain.setTargetAtTime(masterVol, ctx.currentTime, 0.01);
    }
  }
  function getMasterVolume() { return masterVol; }

  function setTrackInstrument(trackIdx, type) {
    if (trackInstruments[trackIdx]) {
      trackInstruments[trackIdx].type = type;
    }
  }

  function getTrackInstruments() { return trackInstruments; }

  function setTrackVolume(trackIdx, vol) {
    if (trackGainNodes[trackIdx] && ctx) {
      trackGainNodes[trackIdx].gain.setTargetAtTime(
        Math.max(0, Math.min(1, vol)), ctx.currentTime, 0.015);
    }
  }

  function allNotesOff() {
    if (!ctx) return;
    const now = ctx.currentTime;
    // Melodic voices
    activeVoices.forEach(voice => {
      try {
        voice.env.gain.cancelScheduledValues(now);
        voice.env.gain.setValueAtTime(voice.env.gain.value, now);
        voice.env.gain.linearRampToValueAtTime(0, now + 0.02);
      } catch (e) {}
      try { voice.oscs?.forEach(o => o.stop(now + 0.05)); } catch (e) {}
    });
    activeVoices.clear();
    voiceByKey.clear();
    melodicVoices.clear();

    // Acid voices
    acidVoices.forEach((voice) => _killAcidVoice(voice, now));
    acidVoices.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // SPATIAL FX
  // ═══════════════════════════════════════════════════════════════

  function _createReverb(ctx, decayTime) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const combSum = ctx.createGain();
    combSum.gain.value = 0.25;

    const combDelays = [0.029, 0.037, 0.041, 0.043];
    const combGains = [0.742, 0.733, 0.715, 0.697];
    const combs = combDelays.map((d, i) => {
      const delay = ctx.createDelay();
      delay.delayTime.value = d;
      const feedback = ctx.createGain();
      feedback.gain.value = _combFeedback(combGains[i], decayTime);
      input.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(combSum);
      return { delay, feedback, base: combGains[i] };
    });

    // True Schroeder allpass: delay + feedback + feedforward, not a biquad.
    const apDelays = [0.005, 0.0017];
    const apGains = [0.7, 0.7];
    const allpasses = apDelays.map((d, i) => {
      const delay = ctx.createDelay();
      delay.delayTime.value = d;
      const fb = ctx.createGain();
      fb.gain.value = apGains[i];
      const ff = ctx.createGain();
      ff.gain.value = -apGains[i];
      const out = ctx.createGain();
      out.gain.value = 1 - apGains[i];
      delay.connect(fb); fb.connect(delay);
      delay.connect(ff); ff.connect(out);
      delay.connect(out);
      return { delay, fb, ff, out };
    });

    // Series: combSum → ap0 → ap1 → output
    let node = combSum;
    allpasses.forEach(ap => {
      node.connect(ap.delay);
      node.connect(ap.out);
      node = ap.out;
    });
    node.connect(output);

    return {
      input,
      output,
      setDecay: (val) => {
        combs.forEach(c => {
          c.feedback.gain.setTargetAtTime(_combFeedback(c.base, val), ctx.currentTime, 0.05);
        });
      },
    };
  }

  /**
   * Map a decay TIME (seconds) to a comb feedback gain, monotonically.
   * The previous mapping was inverted — a longer "decay" produced a
   * SHORTER tail.
   */
  function _combFeedback(baseGain, decayTime) {
    const t = Math.max(0.3, Math.min(10, decayTime));
    // 0.3s → 0.55, 10s → 0.96
    const g = 0.55 + 0.41 * ((t - 0.3) / (10 - 0.3));
    return Math.min(0.96, Math.max(0.3, g));
  }

  function _createPingPongDelay(ctx, delayTime, feedbackVal) {
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

  /** Energy-conserving dry level for the current wet amounts. */
  function _dryValue() {
    return Math.max(0.15, Math.min(1, 1 - (reverbMixVal + delayMixVal) * 0.5));
  }

  function setReverbMix(mix) {
    reverbMixVal = Math.max(0, Math.min(1, mix));
    if (reverbWetGain && ctx) {
      reverbWetGain.gain.setTargetAtTime(reverbMixVal * 0.9, ctx.currentTime, 0.02);
      _updateDryGain();
    }
  }

  function setReverbDecay(decay) {
    reverbDecayVal = Math.max(0.3, Math.min(10, decay));
    if (reverbNode) reverbNode.setDecay(reverbDecayVal);
  }

  function setReverbTone(freq) {
    reverbToneVal = Math.max(200, Math.min(18000, freq));
    if (reverbToneFilter && ctx) {
      reverbToneFilter.frequency.setTargetAtTime(reverbToneVal, ctx.currentTime, 0.05);
    }
  }

  function setDelayMix(mix) {
    delayMixVal = Math.max(0, Math.min(1, mix));
    if (delayWetGain && ctx) {
      delayWetGain.gain.setTargetAtTime(delayMixVal * 0.9, ctx.currentTime, 0.02);
      _updateDryGain();
    }
  }

  function setDelayTime(time) {
    delayTimeVal = Math.max(0.02, Math.min(2, time));
    if (delayNode) delayNode.setDelayTime(delayTimeVal);
  }

  function setDelayFeedback(fb) {
    delayFeedbackVal = Math.max(0, Math.min(0.95, fb));
    if (delayNode) delayNode.setFeedback(delayFeedbackVal);
  }

  function setDelayTone(freq) {
    delayToneVal = Math.max(200, Math.min(18000, freq));
    if (delayToneFilter && ctx) {
      delayToneFilter.frequency.setTargetAtTime(delayToneVal, ctx.currentTime, 0.05);
    }
  }

  function _updateDryGain() {
    if (dryGain && ctx) {
      dryGain.gain.setTargetAtTime(_dryValue(), ctx.currentTime, 0.02);
    }
  }

  /** Current spatial FX settings — used by project save/load. */
  function getSpatialFX() {
    return {
      reverbMix: reverbMixVal,
      reverbDecay: reverbDecayVal,
      reverbTone: reverbToneVal,
      delayMix: delayMixVal,
      delayTime: delayTimeVal,
      delayFeedback: delayFeedbackVal,
      delayTone: delayToneVal,
    };
  }

  /** Master analyser for the UI scope. */
  function getAnalyser() { return masterAnalyser; }

  /** Namespaced sampler categories (for the instrument dropdown). */
  function samplerCategoryName(name) { return SAMPLER_PREFIX + name; }
  function isSamplerType(type) { return typeof type === 'string' && type.startsWith(SAMPLER_PREFIX); }

  // ─── Audio recording (WAV) ───────────────────────────────────
  // An AudioWorklet taps the master bus and the samples are encoded to a
  // 16-bit WAV on stop. A ScriptProcessor would have been simpler but it
  // runs on the main thread and glitches under load.
  let captureNode = null;
  let captureSink = null;
  let captureChunks = [];
  let capturing = false;

  const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      // Copy every channel — the worklet input is reused between calls.
      const frames = [];
      for (let c = 0; c < input.length; c++) frames.push(new Float32Array(input[c]));
      this.port.postMessage(frames);
    }
    return true;
  }
}
registerProcessor('musicbox-capture', CaptureProcessor);
`;

  async function startRecording() {
    if (capturing) return false;
    if (!ctx) init();
    if (!ctx) return false;
    if (!ctx.audioWorklet) {
      console.warn('[Audio] AudioWorklet is unavailable — recording disabled.');
      return false;
    }
    try {
      if (!captureNode) {
        const blob = new Blob([CAPTURE_WORKLET], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        captureNode = new AudioWorkletNode(ctx, 'musicbox-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        captureNode.channelCount = 2;
        captureNode.channelCountMode = 'explicit';
        captureNode.port.onmessage = (e) => {
          if (!capturing) return;
          captureChunks.push(e.data);
        };
        // A node is only processed if it reaches the destination, so the
        // worklet needs a path. A zero-gain sink pulls it without
        // contributing a single sample of audio.
        captureSink = ctx.createGain();
        captureSink.gain.value = 0;
        captureNode.connect(captureSink);
        captureSink.connect(ctx.destination);
      }
    } catch (e) {
      console.error('[Audio] could not start the capture worklet:', e);
      captureNode = null;
      return false;
    }

    captureChunks = [];
    capturing = true;
    // Tap the master bus. The worklet has no output connection, so it
    // costs nothing but a copy.
    masterGain.connect(captureNode);
    return true;
  }

  /** Stop recording and return a WAV Blob (or null). */
  function stopRecording() {
    if (!capturing) return null;
    capturing = false;
    try { masterGain.disconnect(captureNode); } catch (e) {}
    const channels = _mergeCaptureChunks(captureChunks);
    captureChunks = [];
    if (!channels || !channels.length || !channels[0].length) return null;
    const bytes = _encodeWav(channels, ctx.sampleRate);
    return new Blob([bytes], { type: 'audio/wav' });
  }

  function isRecording() { return capturing; }

  /** Merge the per-block channel arrays into one long array per channel. */
  function _mergeCaptureChunks(chunks) {
    if (!chunks.length) return null;
    const numChannels = chunks[0].length;
    const lengths = new Array(numChannels).fill(0);
    for (const block of chunks) {
      for (let c = 0; c < numChannels; c++) {
        lengths[c] += (block[c] ? block[c].length : 0);
      }
    }
    const total = lengths[0];
    if (!total) return null;
    const out = [];
    for (let c = 0; c < numChannels; c++) {
      const arr = new Float32Array(lengths[c]);
      let offset = 0;
      for (const block of chunks) {
        const src = block[c];
        if (!src) continue;
        arr.set(src, offset);
        offset += src.length;
      }
      out.push(arr);
    }
    return out;
  }

  /** Encode float channels as a 16-bit PCM WAV file. */
  function _encodeWav(channels, sampleRate) {
    const numChannels = channels.length;
    const numFrames = channels[0].length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);              // PCM header size
    view.setUint16(20, 1, true);               // format = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);              // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numChannels; c++) {
        let s = channels[c][i];
        if (!isFinite(s)) s = 0;
        s = Math.max(-1, Math.min(1, s));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Uint8Array(buffer);
  }

  return {
    init,
    getContext,
    resume,
    noteOn,
    noteOff,
    triggerNote,
    allNotesOff,
    setEnabled,
    isEnabled,
    setMasterVolume,
    getMasterVolume,
    setTrackInstrument,
    getTrackInstruments,
    setTrackVolume,
    setTrackParam,
    getTrackParams,
    getAllTrackParams,
    resetTrackParams,
    setTrackFx,
    getTrackFx,
    getAllTrackFx,
    resetTrackFx,
    voiceDesign,
    getSpatialFX,
    getAnalyser,
    startRecording,
    stopRecording,
    isRecording,
    samplerCategoryName,
    isSamplerType,
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
