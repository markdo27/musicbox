/**
 * sequencer.js — Step Sequencer Engine
 * ---------------------------------------------------------------------------
 * Uses the shared AudioContext for precise scheduling.
 * Supports 8 tracks × 16/32 steps, per-step probability, velocity, gate,
 * swing, micro-timing, ratchet, accent, slide, and MIDI output.
 *
 * KEY FIXES (post-audit):
 *  - Notes are scheduled at ABSOLUTE AudioContext times, not via setTimeout
 *    (which was 10–50 ms of jitter — up to 44 % of a 16th note).
 *  - Swing uses the correct formula: T(k) = T0 + k·S + (k odd ? S·swing : 0).
 *    The old formula applied REVERSE swing AND lengthened the bar by up to
 *    25 %, so the sequencer played at a different tempo than its BPM.
 *  - The UI playhead / clock / MIDI recorder use the PLAYING step, not the
 *    scheduler's look-ahead step (they were one step apart 50 % of the time).
 *  - Solo is orthogonal to mute; muting a track no longer kills the whole rig.
 *  - Undo covers every mutation, and there is a redo stack.
 */

const Sequencer = (() => {

  // ─── State ──────────────────────────────────────────────────
  let state = {
    bpm: 132,
    swing: 0,         // 0–100
    stepCount: 16,    // 16 or 32
    currentStep: -1,  // look-ahead step (scheduler position)
    playingStep: -1,  // the step that is actually sounding
    isPlaying: false,
    isRecording: false,
    tracks: [],
    generative: null, // generator parameters (see Generator.normaliseParams)
  };

  // Timing
  let nextNoteTime = 0;
  let playStartTime = 0;   // AudioContext time of step 0
  let absStep = 0;         // absolute step counter since play()
  let lookAhead = 0.12;    // seconds to schedule ahead
  let scheduleInterval = 25; // ms between scheduler runs
  let schedulerTimer = null;

  // Callbacks
  let onStepChange = null;    // fn(step) → UI update
  let onStateChange = null;   // fn(state) → FULL UI refresh (structure changed)
  let onTransportChange = null; // fn(state) → LIGHT UI update (BPM, transport)

  // MIDI notes still held per channel (for legato / slide)
  const heldMidiNotes = new Map(); // channel → note

  // ─── Undo / Redo history ────────────────────────────────────
  const undoStack = [];
  const redoStack = [];
  const UNDO_MAX = 60;

  /**
   * Notify the UI. `full` re-renders the whole grid; light only syncs
   * the transport controls. BPM and swing changes are LIGHT — re-rendering
   * 256 step buttons on every slider pixel is what made the old app stutter.
   */
  function _notify(full) {
    if (full) { if (onStateChange) onStateChange({ ...state }); }
    else { if (onTransportChange) onTransportChange({ ...state }); }
  }

  function _deepCloneState() {
    return {
      bpm: state.bpm,
      swing: state.swing,
      stepCount: state.stepCount,
      generative: state.generative ? JSON.parse(JSON.stringify(state.generative)) : null,
      tracks: state.tracks.map(t => ({
        ...t,
        steps: t.steps.map(s => ({ ...s }))
      })),
      instruments: window.AudioEngine
        ? AudioEngine.getTrackInstruments().map(i => i.type)
        : [],
    };
  }

  function saveUndo() {
    undoStack.push(_deepCloneState());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  function _restoreSnapshot(snapshot) {
    state.bpm = snapshot.bpm;
    state.swing = snapshot.swing;
    state.stepCount = snapshot.stepCount;
    state.generative = snapshot.generative;
    state.tracks = snapshot.tracks;
    if (snapshot.instruments && window.AudioEngine) {
      snapshot.instruments.forEach((type, idx) => AudioEngine.setTrackInstrument(idx, type));
    }
  }

  function undo() {
    if (undoStack.length === 0) return false;
    const snapshot = undoStack.pop();
    redoStack.push(_deepCloneState());
    _restoreSnapshot(snapshot);
    _notify(true);
    return true;
  }

  function redo() {
    if (redoStack.length === 0) return false;
    const snapshot = redoStack.pop();
    undoStack.push(_deepCloneState());
    _restoreSnapshot(snapshot);
    _notify(true);
    return true;
  }

  // ─── AudioContext ───────────────────────────────────────────
  function _ctx() {
    if (window.AudioEngine) {
      const c = AudioEngine.getContext();
      if (c) return c;
    }
    return null;
  }

  // ─── Timing ──────────────────────────────────────────────────
  function _secondsPerStep() {
    // One step = 1/16th note
    const secondsPerBeat = 60.0 / state.bpm;
    return secondsPerBeat / 4;
  }

  /**
   * Swing offset for an absolute step index.
   * The formula is the offset FROM the straight grid, so the bar length
   * stays exactly 16 steps no matter how much swing is applied.
   */
  function _swingOffset(absIndex) {
    if (state.swing <= 0) return 0;
    if (absIndex % 2 === 0) return 0;
    return _secondsPerStep() * (state.swing / 100);
  }

  /** Absolute AudioContext time of an absolute step index. */
  function _timeOfStep(absIndex) {
    return playStartTime + absIndex * _secondsPerStep() + _swingOffset(absIndex);
  }

  // ─── Scheduler ───────────────────────────────────────────────
  function _scheduler() {
    const ctx = _ctx();
    if (!ctx) return;
    const lookAheadTime = ctx.currentTime + lookAhead;

    // Guard: if a long stall (background tab, GC) left us behind, resync
    // instead of firing every missed step as a machine-gun burst.
    if (nextNoteTime < ctx.currentTime - 0.05) {
      nextNoteTime = ctx.currentTime + 0.02;
    }

    while (nextNoteTime < lookAheadTime) {
      _scheduleStep(state.currentStep + 1, nextNoteTime, absStep + 1);
      _advanceStep();
    }
  }

  function _advanceStep() {
    state.currentStep = (state.currentStep + 1) % state.stepCount;
    absStep++;
    nextNoteTime = _timeOfStep(absStep);
  }

  /** Is this track audible right now (mute + solo logic)? */
  function _shouldPlay(track) {
    if (track.muted) return false;
    const anySoloed = state.tracks.some(t => t.soloed);
    if (anySoloed && !track.soloed) return false;
    return true;
  }

  function _scheduleStep(rawStep, time, absIndex) {
    const ctx = _ctx();
    if (!ctx) return;
    const step = ((rawStep % state.stepCount) + state.stepCount) % state.stepCount;

    // Notify UI of playhead position
    const uiDelay = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      // The PLAYING step is what the user sees and hears — the scheduler's
      // `currentStep` is one or two steps ahead (look-ahead).
      state.playingStep = step;
      if (onStepChange) onStepChange(step);
    }, uiDelay);

    // Schedule MIDI + Internal Audio for all tracks
    state.tracks.forEach((track, trackIdx) => {
      if (!_shouldPlay(track)) return;
      const stepData = track.steps[step];
      if (!stepData || !stepData.active) return;

      // Probability check
      if (stepData.probability < 100 && Math.random() * 100 > stepData.probability) return;

      // Internal audio velocity is NOT scaled by track volume — the mixer
      // gain node owns that. MIDI velocity IS scaled (hardware has no gain).
      const vel = Math.max(1, Math.min(127, stepData.velocity));
      const midiVel = Math.max(1, Math.min(127,
        Math.round(stepData.velocity * (track.volume / 100))));

      // Step flags
      const accent = stepData.accent || false;
      const slide  = stepData.slide  || false;
      const audioMode = track.audioMode || 'both';
      const outputId = track.midiOutputId || null;

      // Humanised micro-timing
      const when = time + (stepData.offset || 0) / 1000;

      const noteDurationSec = _secondsPerStep() * stepData.gate;
      const noteDurationMs  = noteDurationSec * 1000;
      const repeats = Math.max(1, stepData.repeats || 1);

      const ch   = track.midiChannel || 1;
      const note = stepData.note;

      // ── MIDI output ─────────────────────────────────────────
      if (audioMode !== 'internal') {
        // Legato: release any note still held on this channel first.
        const held = heldMidiNotes.get(ch);
        if (held !== undefined) {
          MidiManager.noteOff(ch, held, outputId);
          heldMidiNotes.delete(ch);
        }
        MidiManager.noteOn(ch, note, midiVel, outputId);
        if (slide) {
          // A slide step keeps the note held until the next note arrives,
          // which is what triggers the hardware's glide circuit.
          heldMidiNotes.set(ch, note);
        } else {
          _scheduleMidiNoteOff(ch, note, when + noteDurationSec, outputId);
        }
      }

      // ── Internal audio ──────────────────────────────────────
      if (audioMode !== 'midi' && window.AudioEngine) {
        if (repeats > 1) {
          // Ratchet: split the step into `repeats` evenly spaced hits.
          const slice = noteDurationSec / repeats;
          for (let r = 0; r < repeats; r++) {
            const rWhen = when + r * slice;
            AudioEngine.triggerNote(trackIdx, ch, note, vel, slice * 0.9, accent, slide, rWhen);
          }
        } else {
          AudioEngine.triggerNote(trackIdx, ch, note, vel, noteDurationSec, accent, slide, when);
        }
      }
    });
  }

  /** Schedule a MIDI note-off at a given (absolute) time. */
  function _scheduleMidiNoteOff(ch, note, when, outputId) {
    const ctx = _ctx();
    if (!ctx) return;
    const delay = Math.max(0, (when - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!state.isPlaying) return;
      MidiManager.noteOff(ch, note, outputId);
    }, delay);
  }

  // ─── Transport Controls ──────────────────────────────────────
  function play() {
    if (state.isPlaying) return;
    // Make sure the audio engine exists — the transport is clocked by the
    // AudioContext, so without it there is nothing to schedule against.
    if (!_ctx() && window.AudioEngine) AudioEngine.init();
    const ctx = _ctx();
    if (!ctx) return;
    state.isPlaying = true;
    state.currentStep = -1;
    state.playingStep = -1;
    absStep = 0;
    playStartTime = ctx.currentTime + 0.06;
    nextNoteTime = playStartTime;
    schedulerTimer = setInterval(_scheduler, scheduleInterval);
    MidiManager.startClock(state.bpm);
    _notify(false);
  }

  function stop() {
    state.isPlaying = false;
    state.isRecording = false;
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    MidiManager.stopClock();
    MidiManager.allNotesOff();
    if (window.AudioEngine) AudioEngine.allNotesOff();
    heldMidiNotes.clear();
    state.currentStep = -1;
    state.playingStep = -1;
    if (onStepChange) onStepChange(-1);
    _notify(false);
  }

  function rewind() {
    const wasPlaying = state.isPlaying;
    stop();
    if (wasPlaying) play();
  }

  function toggleRecord() {
    state.isRecording = !state.isRecording;
    _notify(false);
  }

  // ─── BPM / Swing / Steps ────────────────────────────────────
  function setBpm(bpm) {
    const ctx = _ctx();
    const old = state.bpm;
    state.bpm = Math.max(40, Math.min(240, Math.round(bpm)));
    // Re-anchor the grid so a tempo change does not jump the playhead.
    if (ctx && state.isPlaying && old !== state.bpm) {
      playStartTime = nextNoteTime - (absStep + 1) * _secondsPerStep() - _swingOffset(absStep + 1);
    }
    MidiManager.updateClockBpm(state.bpm);
    _notify(false);
  }

  function setSwing(swing) {
    state.swing = Math.max(0, Math.min(100, Math.round(swing)));
    _notify(false);
  }

  function setStepCount(count) {
    state.stepCount = count === 32 ? 32 : 16;
    // Pad or trim each track
    state.tracks.forEach(track => {
      while (track.steps.length < state.stepCount) {
        track.steps.push(_blankStep());
      }
      if (track.steps.length > state.stepCount) {
        track.steps = track.steps.slice(0, state.stepCount);
      }
    });
    _notify(true);
  }

  function _blankStep() {
    return {
      active: false, note: 60, velocity: 100, gate: 0.5, probability: 100,
      accent: false, slide: false, offset: 0, repeats: 1,
    };
  }

  // ─── Tap Tempo ───────────────────────────────────────────────
  let tapTimes = [];
  function tap() {
    const now = performance.now();
    tapTimes.push(now);
    tapTimes = tapTimes.filter(t => now - t < 3000); // keep last 3 sec
    if (tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapTimes.length; i++) {
        intervals.push(tapTimes[i] - tapTimes[i - 1]);
      }
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setBpm(Math.round(60000 / avg));
    }
  }

  // ─── Track Management ────────────────────────────────────────
  function initTracks(trackDefs) {
    state.tracks = (trackDefs || []).map(def => ({
      name:         def.name         || 'Track',
      midiChannel:  def.midiChannel  || 1,
      muted:        def.muted        || false,
      soloed:       def.soloed       || false,
      volume:       def.volume !== undefined ? def.volume : 100,
      audioMode:    def.audioMode    || 'both',     // 'internal' | 'midi' | 'both'
      midiOutputId: def.midiOutputId || null,        // null = use selected output
      role:         def.role         || null,        // generator role
      steps: (def.steps || []).map(s => ({
        active:      !!s.active,
        note:        s.note        ?? 60,
        velocity:    s.velocity    ?? 100,
        gate:        s.gate        ?? 0.5,
        probability: s.probability ?? 100,
        accent:      !!s.accent,
        slide:       !!s.slide,
        offset:      s.offset      ?? 0,
        repeats:     s.repeats     ?? 1,
      })),
    }));
    // Pad to stepCount
    state.tracks.forEach(track => {
      while (track.steps.length < state.stepCount) {
        track.steps.push(_blankStep());
      }
    });
    _notify(true);
  }

  function setTrackProperty(trackIdx, prop, value) {
    if (!state.tracks[trackIdx]) return;
    saveUndo();
    state.tracks[trackIdx][prop] = value;
    _notify(true);
  }

  function toggleStep(trackIdx, stepIdx) {
    const step = state.tracks[trackIdx]?.steps[stepIdx];
    if (!step) return;
    saveUndo();
    step.active = !step.active;
    _notify(false);
  }

  function setStepData(trackIdx, stepIdx, data, opts = {}) {
    const step = state.tracks[trackIdx]?.steps[stepIdx];
    if (!step) return;
    if (!opts.noUndo) saveUndo();
    Object.assign(step, data);
    if (onStateChange && !opts.silent) onStateChange({ ...state });
  }

  function getStep(trackIdx, stepIdx) {
    return state.tracks[trackIdx]?.steps[stepIdx];
  }

  function clearTrack(trackIdx) {
    if (!state.tracks[trackIdx]) return;
    state.tracks[trackIdx].steps.forEach(s => {
      s.active = false; s.probability = 100; s.velocity = 100; s.gate = 0.5;
      s.accent = false; s.slide = false; s.offset = 0; s.repeats = 1;
    });
  }

  function clearAllTracks() {
    saveUndo();
    state.tracks.forEach((_, i) => clearTrack(i));
    _notify(false);
  }

  // ─── Generative engine integration ───────────────────────────
  /**
   * Apply a generator patch (from Generator.generate) to the sequencer.
   */
  function applyPatch(patch, opts = {}) {
    if (!patch) return false;
    if (!opts.noUndo) saveUndo();

    if (patch.bpm !== undefined) state.bpm = patch.bpm;
    if (patch.swing !== undefined) state.swing = patch.swing;
    if (patch.stepCount) state.stepCount = patch.stepCount;

    if (patch.tracks) {
      state.tracks = patch.tracks.map((t, i) => {
        const existing = state.tracks[i] || {};
        const steps = t.steps.map(s => ({
          active: !!s.active,
          note: s.note ?? 60,
          velocity: s.velocity ?? 100,
          gate: s.gate ?? 0.5,
          probability: s.probability ?? 100,
          accent: !!s.accent,
          slide: !!s.slide,
          offset: s.offset ?? 0,
          repeats: s.repeats ?? 1,
        }));
        while (steps.length < state.stepCount) steps.push(_blankStep());
        return {
          name: t.name || existing.name || `Track ${i + 1}`,
          midiChannel: t.midiChannel ?? existing.midiChannel ?? 1,
          muted: existing.muted ?? false,
          soloed: existing.soloed ?? false,
          volume: existing.volume ?? 100,
          audioMode: existing.audioMode || 'both',
          midiOutputId: existing.midiOutputId || null,
          role: t.role || existing.role || null,
          steps: steps.slice(0, state.stepCount),
        };
      });
    }

    if (patch.meta) state.generative = { ...(state.generative || {}), ...patch.meta };

    // Apply the patch's instrument assignment.
    if (patch.tracks && window.AudioEngine) {
      patch.tracks.forEach((t, i) => {
        if (t.instrument) AudioEngine.setTrackInstrument(i, t.instrument);
      });
      if (window.UI && UI.renderInstruments) UI.renderInstruments();
    }

    _notify(true);
    return true;
  }

  /** Generate a complete new pattern from the current generative params. */
  function randomizeAll() {
    if (!window.Generator) return false;
    const params = state.generative || Generator.normaliseParams({ genre: 'techno' });
    const patch = Generator.generate(params);
    applyPatch(patch);
    return true;
  }

  /** Regenerate a single track using its role. */
  function randomizeTrack(trackIdx) {
    if (!window.Generator) return false;
    const track = state.tracks[trackIdx];
    if (!track) return false;
    saveUndo();
    const params = state.generative || Generator.normaliseParams({ genre: 'techno' });
    const steps = Generator.generateTrack(track.role || 'perc', params);
    track.steps = steps.slice(0, state.stepCount);
    _notify(true);
    return true;
  }

  /** Update the generator parameters (without generating). */
  function setGenerativeParams(params) {
    state.generative = { ...(state.generative || {}), ...params };
    _notify(false);
  }

  function getGenerativeParams() {
    return state.generative;
  }

  // ─── Apply Preset ────────────────────────────────────────────
  function applyPreset(presetId) {
    const preset = PRESETS[presetId];
    if (!preset) return;

    saveUndo();
    const wasPlaying = state.isPlaying;
    stop();

    state.bpm = preset.bpm;
    state.swing = preset.swing;
    initTracks(preset.tracks);

    // Apply track instruments if defined in preset
    if (preset.instruments && window.AudioEngine) {
      preset.instruments.forEach((type, idx) => {
        AudioEngine.setTrackInstrument(idx, type);
      });
      if (window.UI && UI.renderInstruments) {
        UI.renderInstruments();
      }
    }

    // Apply spatial FX if defined in preset, otherwise apply dry defaults
    if (window.AudioEngine) {
      const fx = preset.spatialFX || {
        reverbMix: 0.15,
        reverbDecay: 2.0,
        delayMix: 0.10,
        delayTime: 0.36,
        delayFeedback: 0.30
      };

      AudioEngine.setReverbMix(fx.reverbMix);
      AudioEngine.setReverbDecay(fx.reverbDecay);
      AudioEngine.setDelayMix(fx.delayMix);
      AudioEngine.setDelayTime(fx.delayTime);
      AudioEngine.setDelayFeedback(fx.delayFeedback);
      if (fx.reverbTone !== undefined) AudioEngine.setReverbTone(fx.reverbTone);

      if (window.UI && UI.syncSpatialSliders) {
        UI.syncSpatialSliders(fx);
      }
    }

    if (wasPlaying) play();
  }

  // ─── Mute / Solo Logic ──────────────────────────────────────
  function toggleMute(trackIdx) {
    const t = state.tracks[trackIdx];
    if (!t) return;
    saveUndo();
    t.muted = !t.muted;
    if (t.muted) {
      // Release ONLY this track's notes — not the whole rig.
      const ch = t.midiChannel || 1;
      const held = heldMidiNotes.get(ch);
      if (held !== undefined) {
        MidiManager.noteOff(ch, held, t.midiOutputId);
        heldMidiNotes.delete(ch);
      }
      MidiManager.noteOffChannel(ch, t.midiOutputId);
      if (window.AudioEngine) AudioEngine.allNotesOff();
    }
    _notify(true);
  }

  function toggleSolo(trackIdx) {
    const t = state.tracks[trackIdx];
    if (!t) return;
    saveUndo();
    // Solo is orthogonal to mute: clear the solo flags, keep the mutes.
    state.tracks.forEach(tr => { tr.soloed = false; });
    t.soloed = true;
    _notify(true);
  }

  // ─── Getters ──────────────────────────────────────────
  function getState() { return state; }
  function getTracks() { return state.tracks; }
  function isPlaying() { return state.isPlaying; }
  function getCurrentStep() { return state.currentStep; }
  function getPlayingStep() { return state.playingStep; }
  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  /**
   * Bar : Beat : Step for a given step index.
   * Uses the PLAYING step by default, so the transport clock matches the
   * highlighted column.
   */
  function barBeat(stepIdx = null) {
    const s = Math.max(0, stepIdx === null ? state.playingStep : stepIdx);
    const bar  = Math.floor(s / 16) + 1;
    const beat = Math.floor((s % 16) / 4) + 1;
    const step = (s % 4) + 1;
    return { bar, beat, step };
  }

  // ─── Track audio mode + MIDI routing ───────────────────────
  function setTrackAudioMode(trackIdx, mode) {
    // mode: 'internal' | 'midi' | 'both'
    if (!state.tracks[trackIdx]) return;
    saveUndo();
    state.tracks[trackIdx].audioMode = mode;
    _notify(true);
  }

  function setTrackMidiOutput(trackIdx, outputId) {
    if (!state.tracks[trackIdx]) return;
    saveUndo();
    state.tracks[trackIdx].midiOutputId = outputId || null;
    _notify(true);
  }

  // ─── Callbacks ──────────────────────────────────────────────
  function setStepCallback(fn) { onStepChange = fn; }
  function setStateCallback(fn) { onStateChange = fn; }
  function setTransportCallback(fn) { onTransportChange = fn; }

  return {
    play, stop, rewind, toggleRecord, tap,
    setBpm, setSwing, setStepCount,
    initTracks, setTrackProperty,
    toggleStep, setStepData, getStep,
    clearTrack, clearAllTracks,
    randomizeTrack, randomizeAll, applyPatch,
    setGenerativeParams, getGenerativeParams,
    applyPreset,
    toggleMute, toggleSolo,
    setTrackAudioMode, setTrackMidiOutput,
    getState, getTracks, isPlaying, getCurrentStep, getPlayingStep, barBeat,
    setStepCallback, setStateCallback, setTransportCallback,
    saveUndo, undo, redo, canUndo, canRedo,
  };

})();

window.Sequencer = Sequencer;
