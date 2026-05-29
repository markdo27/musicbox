/**
 * sequencer.js — Step Sequencer Engine
 * Uses AudioContext + precise scheduling for jitter-free timing.
 * Supports 8 tracks × 16/32 steps, per-step probability,
 * velocity, gate, swing, and MIDI output.
 */

const Sequencer = (() => {

  // ─── State ──────────────────────────────────────────────────
  let state = {
    bpm: 132,
    swing: 0,         // 0–100
    stepCount: 16,    // 16 or 32
    currentStep: -1,
    isPlaying: false,
    isRecording: false,
    tracks: [],
  };

  // Timing
  let audioCtx = null;
  let nextNoteTime = 0;
  let lookAhead = 0.1;       // seconds to schedule ahead
  let scheduleInterval = 25; // ms between scheduler runs
  let schedulerTimer = null;

  // Callbacks
  let onStepChange = null;   // fn(step) → UI update
  let onStateChange = null;  // fn(state) → full UI refresh

  // Note-off tracking
  const pendingNoteOffs = []; // [{time, channel, note, outputId}]

  // ─── Init AudioContext ───────────────────────────────────────
  function _ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  // ─── Timing ──────────────────────────────────────────────────
  function _secondsPerStep() {
    // One step = 1/16th note
    const secondsPerBeat = 60.0 / state.bpm;
    return secondsPerBeat / 4;
  }

  function _applySwing(step) {
    // Odd steps get pushed forward by swing amount
    if (step % 2 === 1 && state.swing > 0) {
      const swingOffset = (_secondsPerStep() * state.swing) / 200;
      return swingOffset;
    }
    return 0;
  }

  // ─── Scheduler ───────────────────────────────────────────────
  function _scheduler() {
    const lookAheadTime = audioCtx.currentTime + lookAhead;

    while (nextNoteTime < lookAheadTime) {
      _scheduleStep(state.currentStep + 1, nextNoteTime);
      _advanceStep();
    }

    // Process pending note-offs
    _processPendingNoteOffs();
  }

  function _advanceStep() {
    const spStep = _secondsPerStep();
    const nextStep = (state.currentStep + 1) % state.stepCount;
    const swing = _applySwing(nextStep);
    nextNoteTime += spStep + swing;
    state.currentStep = nextStep;
  }

  function _scheduleStep(rawStep, time) {
    const step = ((rawStep % state.stepCount) + state.stepCount) % state.stepCount;

    // Notify UI of playhead position
    const uiDelay = Math.max(0, (time - audioCtx.currentTime) * 1000);
    setTimeout(() => {
      if (onStepChange) onStepChange(step);
    }, uiDelay);

    // Schedule MIDI + Internal Audio for all tracks
    state.tracks.forEach((track, trackIdx) => {
      if (track.muted) return;
      const stepData = track.steps[step];
      if (!stepData || !stepData.active) return;

      // Probability check
      if (stepData.probability < 100 && Math.random() * 100 > stepData.probability) return;

      // Velocity scale by track volume
      const scaledVel = Math.round(stepData.velocity * (track.volume / 100));
      const vel = Math.max(1, Math.min(127, scaledVel));

      // Schedule note-on via setTimeout (MIDI doesn't use AudioContext timing)
      const noteOnDelay = Math.max(0, (time - audioCtx.currentTime) * 1000);
      const noteDurationMs = _secondsPerStep() * stepData.gate * 1000;
      const noteDurationSec = _secondsPerStep() * stepData.gate;

      const ch = track.midiChannel || 1;
      const note = stepData.note;

      setTimeout(() => {
        if (!state.isPlaying) return;
        // MIDI output
        MidiManager.noteOn(ch, note, vel);
        // Internal audio output
        if (window.AudioEngine) {
          AudioEngine.triggerNote(trackIdx, ch, note, vel, noteDurationSec);
        }
      }, noteOnDelay);

      setTimeout(() => {
        MidiManager.noteOff(ch, note);
        // Audio engine self-manages note-off for drums; melodic handled inside triggerNote
      }, noteOnDelay + noteDurationMs);
    });
  }

  // ─── Pending note-off cleanup ────────────────────────────────
  function _processPendingNoteOffs() {
    const now = audioCtx.currentTime;
    const remaining = [];
    pendingNoteOffs.forEach(item => {
      if (now >= item.time) {
        MidiManager.noteOff(item.channel, item.note);
      } else {
        remaining.push(item);
      }
    });
    pendingNoteOffs.length = 0;
    pendingNoteOffs.push(...remaining);
  }

  // ─── Transport Controls ──────────────────────────────────────
  function play() {
    if (state.isPlaying) return;
    _ensureAudioCtx();
    state.isPlaying = true;
    state.currentStep = -1;
    nextNoteTime = audioCtx.currentTime;
    schedulerTimer = setInterval(_scheduler, scheduleInterval);
    MidiManager.startClock(state.bpm);
    if (onStateChange) onStateChange({ ...state });
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
    pendingNoteOffs.length = 0;
    state.currentStep = -1;
    if (onStepChange) onStepChange(-1);
    if (onStateChange) onStateChange({ ...state });
  }

  function rewind() {
    const wasPlaying = state.isPlaying;
    stop();
    if (wasPlaying) play();
  }

  function toggleRecord() {
    state.isRecording = !state.isRecording;
    if (onStateChange) onStateChange({ ...state });
  }

  // ─── BPM / Swing / Steps ────────────────────────────────────
  function setBpm(bpm) {
    state.bpm = Math.max(40, Math.min(240, bpm));
    MidiManager.updateClockBpm(state.bpm);
  }

  function setSwing(swing) {
    state.swing = Math.max(0, Math.min(100, swing));
  }

  function setStepCount(count) {
    state.stepCount = count === 32 ? 32 : 16;
    // Pad or trim each track
    state.tracks.forEach(track => {
      while (track.steps.length < state.stepCount) {
        track.steps.push({ active: false, note: 60, velocity: 100, gate: 0.5, probability: 100 });
      }
      track.steps = track.steps.slice(0, state.stepCount);
    });
    if (onStateChange) onStateChange({ ...state });
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
    state.tracks = trackDefs.map(def => ({
      name: def.name || 'Track',
      midiChannel: def.midiChannel || 1,
      muted: def.muted || false,
      soloed: def.soloed || false,
      volume: def.volume !== undefined ? def.volume : 100,
      steps: (def.steps || []).map(s => ({ ...s })),
    }));
    // Pad to stepCount
    state.tracks.forEach(track => {
      while (track.steps.length < state.stepCount) {
        track.steps.push({ active: false, note: 60, velocity: 100, gate: 0.5, probability: 100 });
      }
    });
    if (onStateChange) onStateChange({ ...state });
  }

  function setTrackProperty(trackIdx, prop, value) {
    if (!state.tracks[trackIdx]) return;
    state.tracks[trackIdx][prop] = value;
  }

  function toggleStep(trackIdx, stepIdx) {
    const step = state.tracks[trackIdx]?.steps[stepIdx];
    if (!step) return;
    step.active = !step.active;
  }

  function setStepData(trackIdx, stepIdx, data) {
    const step = state.tracks[trackIdx]?.steps[stepIdx];
    if (!step) return;
    Object.assign(step, data);
  }

  function getStep(trackIdx, stepIdx) {
    return state.tracks[trackIdx]?.steps[stepIdx];
  }

  function clearTrack(trackIdx) {
    if (!state.tracks[trackIdx]) return;
    state.tracks[trackIdx].steps.forEach(s => {
      s.active = false; s.probability = 100; s.velocity = 100; s.gate = 0.5;
    });
  }

  function clearAllTracks() {
    state.tracks.forEach((_, i) => clearTrack(i));
    if (onStateChange) onStateChange({ ...state });
  }

  function randomizeTrack(trackIdx, preset = null) {
    const track = state.tracks[trackIdx];
    if (!track) return;
    const density = 0.35 + Math.random() * 0.3;
    track.steps.forEach((step, i) => {
      step.active = Math.random() < density;
      if (step.active) {
        step.velocity = 70 + Math.floor(Math.random() * 57);
        step.probability = 60 + Math.floor(Math.random() * 40);
        step.gate = [0.25, 0.5, 0.75][Math.floor(Math.random() * 3)];
      }
    });
  }

  function randomizeAll() {
    state.tracks.forEach((_, i) => randomizeTrack(i));
    if (onStateChange) onStateChange({ ...state });
  }

  // ─── Apply Preset ────────────────────────────────────────────
  function applyPreset(presetId) {
    const preset = PRESETS[presetId];
    if (!preset) return;

    const wasPlaying = state.isPlaying;
    stop();

    state.bpm = preset.bpm;
    state.swing = preset.swing;
    initTracks(preset.tracks);

    if (wasPlaying) play();
  }

  // ─── Mute / Solo Logic ───────────────────────────────────────
  function toggleMute(trackIdx) {
    const t = state.tracks[trackIdx];
    if (!t) return;
    t.muted = !t.muted;
    if (t.muted) MidiManager.allNotesOff();
  }

  function toggleSolo(trackIdx) {
    const t = state.tracks[trackIdx];
    if (!t) return;
    const wasSoloed = t.soloed;
    // Clear all solos
    state.tracks.forEach(tr => { tr.soloed = false; tr.muted = false; });
    if (!wasSoloed) {
      t.soloed = true;
      state.tracks.forEach((tr, i) => { if (i !== trackIdx) tr.muted = true; });
    }
  }

  // ─── Getters ────────────────────────────────────────────────
  function getState() { return state; }
  function getTracks() { return state.tracks; }
  function isPlaying() { return state.isPlaying; }
  function getCurrentStep() { return state.currentStep; }

  // ─── Callbacks ──────────────────────────────────────────────
  function setStepCallback(fn) { onStepChange = fn; }
  function setStateCallback(fn) { onStateChange = fn; }

  return {
    play, stop, rewind, toggleRecord, tap,
    setBpm, setSwing, setStepCount,
    initTracks, setTrackProperty,
    toggleStep, setStepData, getStep,
    clearTrack, clearAllTracks,
    randomizeTrack, randomizeAll,
    applyPreset,
    toggleMute, toggleSolo,
    getState, getTracks, isPlaying, getCurrentStep,
    setStepCallback, setStateCallback,
  };

})();

window.Sequencer = Sequencer;
