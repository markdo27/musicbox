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

  // Undo history (max 20 snapshots)
  const undoStack = [];
  const UNDO_MAX = 20;

  function _deepCloneState() {
    return {
      bpm: state.bpm,
      swing: state.swing,
      stepCount: state.stepCount,
      tracks: state.tracks.map(t => ({
        ...t,
        steps: t.steps.map(s => ({ ...s }))
      }))
    };
  }

  function saveUndo() {
    undoStack.push(_deepCloneState());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  function undo() {
    if (undoStack.length === 0) return false;
    const snapshot = undoStack.pop();
    state.bpm = snapshot.bpm;
    state.swing = snapshot.swing;
    state.stepCount = snapshot.stepCount;
    state.tracks = snapshot.tracks;
    if (onStateChange) onStateChange({ ...state });
    return true;
  }

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

      // Step flags
      const accent = stepData.accent || false;
      const slide  = stepData.slide  || false;
      const audioMode = track.audioMode || 'both';

      // MIDI: accent boosts velocity to ≥ 100 (triggers TD-3 accent LED)
      const midiVel = accent ? Math.max(vel, 100) : vel;

      const noteOnDelay    = Math.max(0, (time - audioCtx.currentTime) * 1000);
      const noteDurationMs  = _secondsPerStep() * stepData.gate * 1000;
      const noteDurationSec = _secondsPerStep() * stepData.gate;

      const ch   = track.midiChannel || 1;
      const note = stepData.note;

      setTimeout(() => {
        if (!state.isPlaying) return;

        // ── MIDI output ─────────────────────────────────────────
        if (audioMode !== 'internal') {
          // Slide: send note-on BEFORE note-off of previous note (triggers HW slide)
          // (Note-off is scheduled AFTER this note-on by design — see below)
          MidiManager.noteOn(ch, note, midiVel);
        }

        // ── Internal audio ──────────────────────────────────────
        if (audioMode !== 'midi' && window.AudioEngine) {
          AudioEngine.triggerNote(trackIdx, ch, note, vel, noteDurationSec, accent, slide);
        }

      }, noteOnDelay);

      setTimeout(() => {
        if (!state.isPlaying) return;
        // For slide steps: don't send MIDI note-off (hardware keeps sliding)
        // The next note-on will re-trigger or continue the slide
        if (audioMode !== 'internal' && !slide) {
          MidiManager.noteOff(ch, note);
        }
        // Audio engine self-manages note-off for drums + acid; melodic handled inside triggerNote
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
        track.steps.push({ active: false, note: 60, velocity: 100, gate: 0.5, probability: 100, accent: false, slide: false });
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
      name:         def.name         || 'Track',
      midiChannel:  def.midiChannel  || 1,
      muted:        def.muted        || false,
      soloed:       def.soloed       || false,
      volume:       def.volume !== undefined ? def.volume : 100,
      audioMode:    def.audioMode    || 'both',     // 'internal' | 'midi' | 'both'
      midiOutputId: def.midiOutputId || null,        // null = use selected output
      steps: (def.steps || []).map(s => ({
        active:      s.active      || false,
        note:        s.note        ?? 60,
        velocity:    s.velocity    ?? 100,
        gate:        s.gate        ?? 0.5,
        probability: s.probability ?? 100,
        accent:      s.accent      || false,
        slide:       s.slide       || false,
      })),
    }));
    // Pad to stepCount
    state.tracks.forEach(track => {
      while (track.steps.length < state.stepCount) {
        track.steps.push({ active: false, note: 60, velocity: 100, gate: 0.5, probability: 100, accent: false, slide: false });
      }
    });
    if (onStateChange) onStateChange({ ...state });
  }

  function setTrackProperty(trackIdx, prop, value) {
    if (!state.tracks[trackIdx]) return;
    state.tracks[trackIdx][prop] = value;
  }

  function toggleStep(trackIdx, stepIdx) {
    saveUndo();
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
      s.accent = false; s.slide = false;
    });
  }

  function clearAllTracks() {
    saveUndo();
    state.tracks.forEach((_, i) => clearTrack(i));
    if (onStateChange) onStateChange({ ...state });
  }

  // ─── Scale & Root note definitions for Smart Randomizer ──────
  const SCALES = {
    minorPentatonic: [0, 3, 5, 7, 10],
    naturalMinor: [0, 2, 3, 5, 7, 8, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    major: [0, 2, 4, 5, 7, 9, 11]
  };
  const ROOT_NOTES = [48, 50, 52, 53, 55, 57]; // C2, D2, E2, F2, G2, A2

  function getRandomNoteFromScale(root, scale, octaveOffset) {
    const scaleNote = scale[Math.floor(Math.random() * scale.length)];
    return root + octaveOffset * 12 + scaleNote;
  }

  function randomizeTrack(trackIdx) {
    const track = state.tracks[trackIdx];
    if (!track) return;
    
    // Clear track first
    track.steps.forEach(s => {
      s.active = false;
      s.probability = 100;
      s.velocity = 100;
      s.gate = 0.5;
    });

    const name = track.name.toLowerCase();
    const isKick = name.includes('kick') || trackIdx === 0;
    const isSnare = name.includes('snare') || name.includes('clap') || trackIdx === 1;
    const isHat = name.includes('hat') || name.includes('hh') || trackIdx === 2 || trackIdx === 3;
    const isBass = name.includes('bass') || trackIdx === 4;
    const isLead = name.includes('lead') || name.includes('synth') || name.includes('hook') || trackIdx === 5;
    const isPad = name.includes('pad') || name.includes('chord') || trackIdx === 6;

    const scale = SCALES.minorPentatonic;
    const root = 60; // middle C

    if (isKick) {
      // 4-on-the-floor kick
      [0, 4, 8, 12].forEach(stepIdx => {
        track.steps[stepIdx].active = true;
        track.steps[stepIdx].note = 36;
        track.steps[stepIdx].velocity = 110 + Math.floor(Math.random() * 15);
        track.steps[stepIdx].gate = 0.25;
      });
      if (Math.random() < 0.4) {
        track.steps[14].active = true;
        track.steps[14].note = 36;
        track.steps[14].velocity = 70;
        track.steps[14].gate = 0.1;
      }
    } else if (isSnare) {
      [4, 12].forEach(stepIdx => {
        track.steps[stepIdx].active = true;
        track.steps[stepIdx].note = 38;
        track.steps[stepIdx].velocity = 100 + Math.floor(Math.random() * 20);
        track.steps[stepIdx].gate = 0.25;
      });
    } else if (isHat) {
      const isOffbeat = Math.random() < 0.5;
      if (isOffbeat) {
        [2, 6, 10, 14].forEach(stepIdx => {
          track.steps[stepIdx].active = true;
          track.steps[stepIdx].note = 46;
          track.steps[stepIdx].velocity = 80 + Math.floor(Math.random() * 15);
          track.steps[stepIdx].gate = 0.35;
        });
      } else {
        [0, 2, 4, 6, 8, 10, 12, 14].forEach(stepIdx => {
          track.steps[stepIdx].active = true;
          track.steps[stepIdx].note = 42;
          track.steps[stepIdx].velocity = 60 + Math.floor(Math.random() * 30);
          track.steps[stepIdx].gate = 0.1;
        });
      }
    } else if (isBass) {
      const bassRhythm = [2, 3, 6, 7, 10, 11, 14, 15];
      const bassNotes = [root - 24, root - 24 + 3, root - 24 + 7];
      bassRhythm.forEach(stepIdx => {
        if (Math.random() < 0.75) {
          track.steps[stepIdx].active = true;
          track.steps[stepIdx].note = bassNotes[Math.floor(Math.random() * bassNotes.length)];
          track.steps[stepIdx].velocity = 90 + Math.floor(Math.random() * 20);
          track.steps[stepIdx].gate = 0.35;
        }
      });
    } else if (isLead) {
      const activeSteps = [0, 2, 3, 5, 8, 10, 11, 13].filter(() => Math.random() < 0.6);
      activeSteps.forEach(stepIdx => {
        track.steps[stepIdx].active = true;
        track.steps[stepIdx].note = getRandomNoteFromScale(root, scale, 1);
        track.steps[stepIdx].velocity = 80 + Math.floor(Math.random() * 25);
        track.steps[stepIdx].gate = 0.25;
      });
    } else if (isPad) {
      [0, 8].forEach((stepIdx, idx) => {
        track.steps[stepIdx].active = true;
        track.steps[stepIdx].note = root - 12 + scale[idx * 2 % scale.length];
        track.steps[stepIdx].velocity = 70;
        track.steps[stepIdx].gate = 0.85;
      });
    } else {
      track.steps.forEach((step, stepIdx) => {
        if (Math.random() < 0.2) {
          step.active = true;
          step.note = 36 + Math.floor(Math.random() * 12);
          step.velocity = 60 + Math.floor(Math.random() * 20);
          step.gate = 0.1;
          step.probability = 70;
        }
      });
    }
  }

  // ─── Techno + Acid randomizer ─────────────────────────────
  // Genre-aware: respects scale, preserves kick, adds accent/slide
  function randomizeAll() {
    saveUndo();

    // Pick genre
    const genre = Math.random() < 0.5 ? 'techno' : 'acid';

    // ── Scale definitions ──────────────────────────────────────
    // E Phrygian intervals from root E2(40): E F G A B C D
    const TECHNO_ROOT  = 40; // E2
    const TECHNO_SCALE = [0, 1, 3, 5, 7, 8, 10]; // Phrygian
    // A minor intervals from root A2(45): A B C D E F G
    const ACID_ROOT    = 45; // A2
    const ACID_SCALE   = [0, 2, 3, 5, 7, 8, 10]; // Natural minor

    const root = genre === 'techno' ? TECHNO_ROOT : ACID_ROOT;
    const scale = genre === 'techno' ? TECHNO_SCALE : ACID_SCALE;

    // Helper: pick a note from the genre scale in a given octave offset
    function scaleNote(octaveOffset = 0) {
      const interval = scale[Math.floor(Math.random() * scale.length)];
      return root + interval + octaveOffset * 12;
    }

    // BPM / Swing
    if (genre === 'techno') {
      setBpm(133 + Math.floor(Math.random() * 8));
      setSwing(0);
    } else {
      setBpm(138 + Math.floor(Math.random() * 8));
      setSwing(0);
    }

    // Set instrument types
    const instruments = genre === 'techno'
      ? ['drum', 'drum', 'drum', 'drum', 'bass', 'lead', 'pad', 'drum']
      : ['drum', 'drum', 'drum', 'drum', 'acid', 'acid', 'lead', 'pad'];
    if (window.AudioEngine) {
      instruments.forEach((type, i) => AudioEngine.setTrackInstrument(i, type));
      if (window.UI && UI.renderInstruments) UI.renderInstruments();
    }

    // Clear all tracks
    state.tracks.forEach((_, i) => clearTrack(i));

    state.tracks.forEach((track, i) => {
      const steps = track.steps;

      // ── Track 0: Kick — always 4-on-floor ──────────────────
      if (i === 0) {
        [0, 4, 8, 12].forEach(s => {
          steps[s].active   = true;
          steps[s].note     = 36;
          steps[s].velocity = 115 + Math.floor(Math.random() * 10);
          steps[s].gate     = 0.25;
        });
      }

      // ── Track 1: Snare — beats 2 & 4 ──────────────────────
      else if (i === 1) {
        [4, 12].forEach(s => {
          steps[s].active   = true;
          steps[s].note     = 38;
          steps[s].velocity = 100 + Math.floor(Math.random() * 15);
          steps[s].gate     = 0.25;
        });
      }

      // ── Track 2: Clap / HH Closed ─────────────────────────
      else if (i === 2) {
        if (genre === 'techno') {
          // 8th note hats with velocity groove
          [0, 2, 4, 6, 8, 10, 12, 14].forEach((s, idx) => {
            steps[s].active   = true;
            steps[s].note     = 42;
            steps[s].velocity = idx % 2 === 0 ? 68 + Math.floor(Math.random() * 10) : 48 + Math.floor(Math.random() * 10);
            steps[s].gate     = 0.08;
          });
        } else {
          // Full 16th hats for acid
          steps.forEach((s, idx) => {
            s.active   = true;
            s.note     = 42;
            s.velocity = idx % 2 === 0 ? 68 + Math.floor(Math.random() * 8) : 44 + Math.floor(Math.random() * 8);
            s.gate     = 0.06;
          });
        }
      }

      // ── Track 3: HH Open ──────────────────────────────────
      else if (i === 3) {
        if (genre === 'techno') {
          // Sparse open hat — bar end or offbeat
          const openSteps = Math.random() < 0.5 ? [14] : [6, 14];
          openSteps.forEach(s => {
            steps[s].active   = true;
            steps[s].note     = 46;
            steps[s].velocity = 75 + Math.floor(Math.random() * 15);
            steps[s].gate     = 0.3;
          });
        } else {
          // Off-beat open hats for acid
          [7, 15].forEach(s => {
            steps[s].active   = true;
            steps[s].note     = 46;
            steps[s].velocity = 72 + Math.floor(Math.random() * 12);
            steps[s].gate     = 0.3;
          });
        }
      }

      // ── Track 4: Bass / 303 #1 ────────────────────────────
      else if (i === 4) {
        if (genre === 'techno') {
          // Syncopated bass in E Phrygian — 3-5 notes per bar
          const bassPool = [0, 2, 3, 5, 6, 8, 9, 10, 11, 13, 14];
          const count = 3 + Math.floor(Math.random() * 3);
          const picked = bassPool.sort(() => Math.random() - 0.5).slice(0, count).sort((a,b) => a-b);
          // Ensure step 0 is always present (root on downbeat)
          if (!picked.includes(0)) picked.unshift(0);
          picked.forEach(s => {
            steps[s].active   = true;
            steps[s].note     = root + scale[Math.floor(Math.random() * scale.length)];
            steps[s].velocity = 95 + Math.floor(Math.random() * 20);
            steps[s].gate     = 0.35 + Math.random() * 0.2;
          });
        } else {
          // Dense 303 acid pattern in A minor
          // Generate a classic-feeling acid rhythm (7-11 steps out of 16)
          const activeCount = 7 + Math.floor(Math.random() * 5);
          const pool = Array.from({length: 16}, (_, k) => k);
          const picked = pool.sort(() => Math.random() - 0.5).slice(0, activeCount).sort((a,b) => a-b);
          if (!picked.includes(0)) picked[0] = 0;

          // Track which steps are active for slide detection
          picked.forEach(s => steps[s].active = true);

          picked.forEach(s => {
            steps[s].note     = root + scale[Math.floor(Math.random() * scale.length)];
            steps[s].velocity = 85 + Math.floor(Math.random() * 25);
            steps[s].gate     = 0.3 + Math.random() * 0.2;
            // Accent on downbeats (0, 4, 8, 12)
            steps[s].accent   = [0, 4, 8, 12].includes(s);
            // Slide if next step is also active (consecutive pair)
            steps[s].slide    = (s < 15) && steps[s + 1].active;
          });
        }
      }

      // ── Track 5: Lead / 303 #2 ────────────────────────────
      else if (i === 5) {
        if (genre === 'techno') {
          // Sparse lead stabs — 2-3 notes only
          const leadPool = [2, 5, 8, 10, 13];
          const count = 1 + Math.floor(Math.random() * 3);
          leadPool.sort(() => Math.random() - 0.5).slice(0, count).forEach(s => {
            steps[s].active   = true;
            steps[s].note     = scaleNote(1); // upper octave
            steps[s].velocity = 80 + Math.floor(Math.random() * 20);
            steps[s].gate     = 0.3;
            steps[s].probability = 80;
          });
        } else {
          // 303 counter-line — sparse offbeat, no consecutive steps
          const offbeats = [2, 5, 7, 10, 12, 15];
          const count = 3 + Math.floor(Math.random() * 3);
          offbeats.sort(() => Math.random() - 0.5).slice(0, count).forEach(s => {
            steps[s].active   = true;
            steps[s].note     = root + scale[Math.floor(Math.random() * scale.length)];
            steps[s].velocity = 80 + Math.floor(Math.random() * 20);
            steps[s].gate     = 0.3;
            steps[s].accent   = [0, 4, 8, 12].includes(s);
            steps[s].slide    = false; // no slide on counter-line
          });
        }
      }

      // ── Track 6: Pad ──────────────────────────────────────
      else if (i === 6) {
        const padSteps = Math.random() < 0.5 ? [0] : [0, 8];
        padSteps.forEach(s => {
          steps[s].active   = true;
          steps[s].note     = scaleNote(1);
          steps[s].velocity = 65;
          steps[s].gate     = 0.9;
        });
      }

      // ── Track 7: Perc / FX ────────────────────────────────
      else if (i === 7) {
        if (genre === 'techno') {
          // Sparse metallic percussion
          const percPool = [1, 3, 5, 7, 9, 11, 13, 15];
          const count = 2 + Math.floor(Math.random() * 3);
          percPool.sort(() => Math.random() - 0.5).slice(0, count).forEach(s => {
            steps[s].active      = true;
            steps[s].note        = 37 + Math.floor(Math.random() * 3);
            steps[s].velocity    = 55 + Math.floor(Math.random() * 20);
            steps[s].gate        = 0.1;
            steps[s].probability = 65;
          });
        } else {
          // Pad for acid — sustained
          steps[0].active   = true;
          steps[0].note     = scaleNote(1);
          steps[0].velocity = 60;
          steps[0].gate     = 0.95;
        }
      }
    });

    if (onStateChange) onStateChange({ ...state });
  }

  // ─── Legacy single-track randomizer (unchanged) ───────────────
  // (kept for backwards compatibility with per-track randomize buttons)
  // Note: this old function is intentionally left below to avoid breaking
  // any UI that calls randomizeTrack(). It will be removed in a future pass.

  // Placeholder — the old randomizeAll starts here (replaced above)
  // Ignore the dead code below until it is cleaned up:
  if (false) {
    const root = 60;

    // Pick a random genre
    const genres = ['techno', 'house', 'dnb', 'lofi'];
    const genre = genres[Math.floor(Math.random() * genres.length)];

    // Set BPM and Swing according to genre
    let bpm, swing;
    if (genre === 'techno') {
      bpm = 130 + Math.floor(Math.random() * 8);
      swing = Math.random() < 0.3 ? Math.floor(Math.random() * 10) : 0;
    } else if (genre === 'house') {
      bpm = 122 + Math.floor(Math.random() * 6);
      swing = 20 + Math.floor(Math.random() * 20);
    } else if (genre === 'dnb') {
      bpm = 170 + Math.floor(Math.random() * 6);
      swing = Math.floor(Math.random() * 10);
    } else { // lofi
      bpm = 80 + Math.floor(Math.random() * 12);
      swing = 40 + Math.floor(Math.random() * 20);
    }

    setBpm(bpm);
    setSwing(swing);

    // Instrument assignments per genre
    const genreInstruments = {
      techno: ['bd', 'sn', 'hh', 'hh', 'bass', 'arpy', 'casio', 'industrial'],
      house: ['808bd', 'cp', 'hh', 'hh', 'bass3', 'arpy', 'casio', 'bubble'],
      dnb: ['amencutup', 'sn', 'hh', 'industrial', 'bass', 'sid', 'arpy', 'kurt'],
      lofi: ['808bd', 'sn', 'hh', 'bottle', 'bass', 'casio', 'casio', 'birds']
    };

    const insts = genreInstruments[genre];
    if (window.AudioEngine) {
      insts.forEach((inst, i) => {
        AudioEngine.setTrackInstrument(i, inst);
      });
      if (window.UI && UI.renderInstruments) {
        UI.renderInstruments();
      }
    }

    // Set Track Names for randomized tracks
    const trackNames = {
      techno: ['Kick', 'Snare', 'HH Closed', 'HH Open', 'Sub Bass', 'Lead Stab', 'Pad', 'Perc'],
      house: ['Kick', 'Clap', 'HH Closed', 'HH Open', 'Walking Bass', 'Synth Hook', 'Chord Organ', 'Bubbles'],
      dnb: ['Amen Break', 'Snare Layer', 'HiHat Sizzle', 'Metal Perc', 'Sub Bass', 'Chiptune Lead', 'Liquid Chords', 'Ambient FX'],
      lofi: ['Dusty Kick', 'Crunch Snare', 'Swing Hat', 'Foley Perc', 'Jazz Bass', 'E-Piano Lead', 'Rhodes Pad', 'Birds Ambient']
    };

    const names = trackNames[genre];
    state.tracks.forEach((track, i) => {
      track.name = names[i];
      const headerName = document.getElementById(`track-name-${i}`);
      if (headerName) headerName.textContent = names[i];
      const mixerName = document.getElementById(`mixer-name-${i}`);
      if (mixerName) mixerName.textContent = names[i];
    });

    // Clear all steps first
    clearAllTracks();

    // Now build beautiful genre patterns!
    state.tracks.forEach((track, i) => {
      const steps = track.steps;
      if (i === 0) { // Kick / Amen Break
        if (genre === 'dnb') {
          // Classic Amen Break slice pattern
          const amenPattern = [
            [0, 36, 110, 0.5],   // Kick slice
            [1, 42, 70, 0.25],   // Hihat slice
            [2, 42, 75, 0.25],   // Hihat slice
            [3, 40, 85, 0.25],   // Ghost Snare
            [4, 38, 115, 0.5],   // Snare slice
            [5, 42, 70, 0.25],   // Hihat slice
            [6, 42, 75, 0.25],   // Hihat slice
            [7, 36, 90, 0.25],   // Ghost Kick
            [8, 36, 110, 0.5],   // Kick slice
            [9, 42, 70, 0.25],   // Hihat slice
            [10, 36, 105, 0.5],  // Double Kick slice
            [11, 42, 75, 0.25],  // Hihat slice
            [12, 38, 118, 0.5],  // Snare slice
            [13, 42, 70, 0.25],  // Hihat slice
            [14, 40, 85, 0.25],  // Ghost Snare
            [15, 42, 75, 0.25]   // Hihat slice
          ];
          amenPattern.forEach(([stepIdx, note, vel, gate]) => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = note;
            steps[stepIdx].velocity = vel;
            steps[stepIdx].gate = gate;
            steps[stepIdx].probability = 100;
          });
        } else if (genre === 'lofi') {
          const lofiKicks = [0, 8];
          if (Math.random() < 0.6) lofiKicks.push(10);
          if (Math.random() < 0.4) lofiKicks.push(14);
          lofiKicks.forEach(stepIdx => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = 36;
            steps[stepIdx].velocity = 100 + Math.floor(Math.random() * 20);
            steps[stepIdx].gate = 0.25;
            steps[stepIdx].probability = 100;
          });
        } else {
          [0, 4, 8, 12].forEach(stepIdx => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = 36;
            steps[stepIdx].velocity = 115 + Math.floor(Math.random() * 12);
            steps[stepIdx].gate = 0.25;
            steps[stepIdx].probability = 100;
          });
          if (genre === 'house' && Math.random() < 0.5) {
            steps[14].active = true;
            steps[14].note = 36;
            steps[14].velocity = 70;
            steps[14].gate = 0.1;
            steps[14].probability = 60;
          }
        }
      }

      else if (i === 1) { // Snare / Clap
        if (genre !== 'dnb') {
          [4, 12].forEach(stepIdx => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = 38;
            steps[stepIdx].velocity = 105 + Math.floor(Math.random() * 15);
            steps[stepIdx].gate = 0.25;
            steps[stepIdx].probability = 100;
          });
          if (genre === 'house' && Math.random() < 0.4) {
            steps[15].active = true;
            steps[15].note = 38;
            steps[15].velocity = 60;
            steps[15].gate = 0.1;
            steps[15].probability = 50;
          }
        } else {
          [4, 12].forEach(stepIdx => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = 38;
            steps[stepIdx].velocity = 100;
            steps[stepIdx].gate = 0.25;
          });
        }
      }

      else if (i === 2) { // Hi-Hat Closed
        if (genre === 'techno') {
          steps.forEach((step, stepIdx) => {
            if (stepIdx % 2 === 0) {
              step.active = true;
              step.note = 42;
              step.velocity = 65 + (stepIdx % 4 === 2 ? 20 : 0) + Math.floor(Math.random() * 15);
              step.gate = 0.1;
              step.probability = 100;
            } else if (Math.random() < 0.25) {
              step.active = true;
              step.note = 42;
              step.velocity = 45 + Math.floor(Math.random() * 15);
              step.gate = 0.05;
              step.probability = 70;
            }
          });
        } else if (genre === 'house' || genre === 'lofi') {
          steps.forEach((step, stepIdx) => {
            if (stepIdx % 2 === 0) {
              step.active = Math.random() < 0.85;
              step.note = 42;
              step.velocity = 70 + Math.floor(Math.random() * 15);
              step.gate = 0.1;
            } else if (Math.random() < 0.4) {
              step.active = true;
              step.note = 42;
              step.velocity = 45 + Math.floor(Math.random() * 15);
              step.gate = 0.05;
              step.probability = 75;
            }
          });
        } else {
          steps.forEach((step, stepIdx) => {
            step.active = Math.random() < 0.75;
            step.note = 42;
            step.velocity = 50 + (stepIdx % 4 === 0 ? 30 : 0) + Math.floor(Math.random() * 15);
            step.gate = 0.1;
          });
        }
      }

      else if (i === 3) { // Hi-Hat Open / Foley
        if (genre === 'techno' || genre === 'house') {
          [2, 6, 10, 14].forEach(stepIdx => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = 46;
            steps[stepIdx].velocity = 80 + Math.floor(Math.random() * 15);
            steps[stepIdx].gate = genre === 'house' ? 0.5 : 0.3;
            steps[stepIdx].probability = 100;
          });
        } else if (genre === 'lofi') {
          steps.forEach((step, stepIdx) => {
            if (Math.random() < 0.2) {
              step.active = true;
              step.note = 36 + Math.floor(Math.random() * 12);
              step.velocity = 50 + Math.floor(Math.random() * 25);
              step.gate = 0.15;
              step.probability = 60;
            }
          });
        } else {
          [2, 6, 10, 14].forEach(stepIdx => {
            if (Math.random() < 0.6) {
              steps[stepIdx].active = true;
              steps[stepIdx].note = 39;
              steps[stepIdx].velocity = 60;
              steps[stepIdx].gate = 0.2;
            }
          });
        }
      }

      else if (i === 4) { // Bass
        const bassRhythm = {
          techno: [0, 2, 4, 6, 8, 10, 12, 14],
          house: [2, 3, 6, 7, 10, 11, 14, 15],
          dnb: [0, 3, 6, 8, 11, 14],
          lofi: [0, 4, 8, 12]
        };
        const rhythm = bassRhythm[genre];
        const bassNotes = [root - 24, root - 24 + scale[2 % scale.length], root - 24 + scale[4 % scale.length], root - 12];

        rhythm.forEach(stepIdx => {
          if (Math.random() < 0.85) {
            steps[stepIdx].active = true;
            steps[stepIdx].note = bassNotes[Math.floor(Math.random() * bassNotes.length)];
            steps[stepIdx].velocity = 95 + Math.floor(Math.random() * 20);
            steps[stepIdx].gate = genre === 'dnb' ? 0.75 : 0.4;
            steps[stepIdx].probability = 90;
          }
        });
      }

      else if (i === 5) { // Lead
        const motifRhythm = [];
        for (let s = 0; s < 8; s++) {
          if (s % 2 === 1 && Math.random() < 0.4) motifRhythm.push(s);
          if (s % 3 === 0 && Math.random() < 0.5) motifRhythm.push(s);
        }

        const leadNotes1 = Array.from({length: 8}, () => getRandomNoteFromScale(root, scale, 1));
        const leadNotes2 = Array.from({length: 8}, () => getRandomNoteFromScale(root, scale, 1));

        steps.forEach((step, stepIdx) => {
          const modStep = stepIdx % 8;
          if (motifRhythm.includes(modStep)) {
            const playChance = stepIdx < 8 ? 0.75 : 0.6;
            if (Math.random() < playChance) {
              step.active = true;
              step.note = stepIdx < 8 ? leadNotes1[modStep] : leadNotes2[modStep];
              step.velocity = 80 + Math.floor(Math.random() * 25);
              step.gate = [0.25, 0.5][Math.floor(Math.random() * 2)];
              step.probability = 80;
            }
          }
        });
      }

      else if (i === 6) { // Pad
        if (genre === 'lofi' || genre === 'house' || genre === 'dnb') {
          const chordNotes = [root - 12 + scale[0], root - 12 + scale[2 % scale.length], root - 12 + scale[4 % scale.length]];
          const padSteps = [0, 8];
          padSteps.forEach((stepIdx, idx) => {
            steps[stepIdx].active = true;
            steps[stepIdx].note = chordNotes[idx % chordNotes.length];
            steps[stepIdx].velocity = 70 + Math.floor(Math.random() * 15);
            steps[stepIdx].gate = 0.85;
            steps[stepIdx].probability = 100;
          });
        } else {
          [2, 10, 14].forEach(stepIdx => {
            if (Math.random() < 0.7) {
              steps[stepIdx].active = true;
              steps[stepIdx].note = root + scale[2 % scale.length];
              steps[stepIdx].velocity = 75;
              steps[stepIdx].gate = 0.25;
              steps[stepIdx].probability = 80;
            }
          });
        }
      }

      else if (i === 7) { // FX
        if (genre === 'lofi') {
          const birdStep = Math.floor(Math.random() * 16);
          steps[birdStep].active = true;
          steps[birdStep].note = 60 + Math.floor(Math.random() * 12);
          steps[birdStep].velocity = 55;
          steps[birdStep].gate = 0.75;
          steps[birdStep].probability = 50;
        } else {
          steps.forEach((step, stepIdx) => {
            if (Math.random() < 0.15) {
              step.active = true;
              step.note = 36 + Math.floor(Math.random() * 24);
              step.velocity = 50 + Math.floor(Math.random() * 20);
              step.gate = 0.1;
              step.probability = 60;
            }
          });
        }
      }
    });

    if (onStateChange) onStateChange({ ...state });
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
    t.muted = !t.muted;
    if (t.muted) {
      MidiManager.allNotesOff();
      if (window.AudioEngine) AudioEngine.allNotesOff();
    }
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
    // Stop all currently playing notes so no soloed track keeps ringing
    MidiManager.allNotesOff();
    if (window.AudioEngine) AudioEngine.allNotesOff();
  }

  // ─── Getters ──────────────────────────────────────────
  function getState() { return state; }
  function getTracks() { return state.tracks; }
  function isPlaying() { return state.isPlaying; }
  function getCurrentStep() { return state.currentStep; }
  function canUndo() { return undoStack.length > 0; }

  function barBeat() {
    const s = Math.max(0, state.currentStep);
    const bar  = Math.floor(s / 16) + 1;
    const beat = Math.floor((s % 16) / 4) + 1;
    const step = (s % 4) + 1;
    return { bar, beat, step };
  }

  // ─── Track audio mode + MIDI routing ───────────────────────
  function setTrackAudioMode(trackIdx, mode) {
    // mode: 'internal' | 'midi' | 'both'
    if (!state.tracks[trackIdx]) return;
    state.tracks[trackIdx].audioMode = mode;
  }

  function setTrackMidiOutput(trackIdx, outputId) {
    if (!state.tracks[trackIdx]) return;
    state.tracks[trackIdx].midiOutputId = outputId;
  }

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
    setTrackAudioMode, setTrackMidiOutput,
    getState, getTracks, isPlaying, getCurrentStep, barBeat,
    setStepCallback, setStateCallback,
    saveUndo, undo, canUndo,
  };

})();

window.Sequencer = Sequencer;
