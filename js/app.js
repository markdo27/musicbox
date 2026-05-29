/**
 * app.js — Main Application Entry Point
 * Wires together MIDI, Sequencer, UI, and Storage modules.
 * Handles all top-level event listeners and initialization.
 */

(async function init() {

  // ─── Default tracks (8 empty tracks) ─────────────────────────
  const DEFAULT_TRACKS = [
    { name: 'Kick',    midiChannel: 10, muted: false, volume: 100 },
    { name: 'Snare',   midiChannel: 10, muted: false, volume: 100 },
    { name: 'HH',      midiChannel: 10, muted: false, volume: 100 },
    { name: 'Perc',    midiChannel: 10, muted: false, volume: 100 },
    { name: 'Bass',    midiChannel: 1,  muted: false, volume: 100 },
    { name: 'Lead',    midiChannel: 2,  muted: false, volume: 100 },
    { name: 'Chord',   midiChannel: 3,  muted: false, volume: 100 },
    { name: 'FX',      midiChannel: 4,  muted: false, volume: 100 },
  ].map(t => ({
    ...t,
    steps: Array.from({ length: 16 }, () => ({
      active: false, note: 60, velocity: 100, gate: 0.5, probability: 100,
    })),
  }));

  // ─── Initialize modules ───────────────────────────────────────

  // Sequencer: register callbacks
  Sequencer.setStepCallback((step) => {
    UI.updatePlayhead(step);
    // Flash track activity LEDs for active steps
    if (step >= 0) {
      Sequencer.getTracks().forEach((track, i) => {
        const stepData = track.steps[step];
        if (stepData?.active && !track.muted) {
          UI.flashTrackActivity(i);
          if (stepData.note !== undefined) UI.flashKey(stepData.note);
        }
      });
    }
  });

  Sequencer.setStateCallback((state) => {
    UI.renderSequencer(state);
    // Sync BPM display
    document.getElementById('bpm-value').value = state.bpm;
  });

  // MIDI: register monitor element
  MidiManager.setLogElement(document.getElementById('monitor-log'));

  // MIDI device change callback → refresh device panel
  MidiManager.setDeviceChangeCallback((devices) => {
    UI.renderDevices(devices);
  });

  // MIDI incoming message → record if active
  MidiManager.setMessageCallback((msg) => {
    if (msg.type === 'noteon' && Sequencer.getState().isRecording && Sequencer.isPlaying()) {
      const step = Sequencer.getCurrentStep();
      if (step >= 0) {
        // Record into current step of first unoccupied track on same channel
        const trackIdx = Sequencer.getTracks().findIndex(t => t.midiChannel === msg.channel);
        if (trackIdx >= 0) {
          Sequencer.setStepData(trackIdx, step, {
            active: true,
            note: msg.note,
            velocity: msg.velocity,
          });
        }
      }
    }
  });

  // ─── Load saved project or init defaults ──────────────────────
  const saved = Storage.load();
  if (saved) {
    Storage.applyProject(saved);
    UI.showToast('Project restored', 'success');
  } else {
    Sequencer.initTracks(DEFAULT_TRACKS);
  }

  // ─── Render UI ────────────────────────────────────────────────
  UI.renderPresets();
  UI.renderKeyboard();
  UI.renderSequencer(Sequencer.getState());

  // ─── Audio Engine Init ────────────────────────────────────────
  // AudioEngine lazy-inits on first note; just render the instrument panel now
  if (window.SamplerEngine) {
    await SamplerEngine.init();
  }
  UI.renderInstruments();

  // Audio toggle button
  const audioToggleBtn = document.getElementById('btn-audio-toggle');
  audioToggleBtn.addEventListener('click', () => {
    const enabled = !AudioEngine.isEnabled();
    AudioEngine.setEnabled(enabled);
    audioToggleBtn.classList.toggle('active', enabled);
    audioToggleBtn.querySelector('.audio-toggle-icon').textContent = enabled ? '🔊' : '🔇';
    UI.showToast(enabled ? '🔊 Audio ON' : '🔇 Audio OFF', 'info');
  });

  // Master volume slider
  document.getElementById('master-vol').addEventListener('input', (e) => {
    AudioEngine.setMasterVolume(parseInt(e.target.value) / 100);
  });

  // Spatial FX UI bindings
  document.getElementById('fx-reverb-mix').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('fx-reverb-mix-val').textContent = val + '%';
    AudioEngine.setReverbMix(val / 100);
  });

  document.getElementById('fx-reverb-decay').addEventListener('input', (e) => {
    const val = parseInt(e.target.value) / 10;
    document.getElementById('fx-reverb-decay-val').textContent = val.toFixed(1) + 's';
    AudioEngine.setReverbDecay(val);
  });

  document.getElementById('fx-delay-mix').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('fx-delay-mix-val').textContent = val + '%';
    AudioEngine.setDelayMix(val / 100);
  });

  document.getElementById('fx-delay-time').addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    AudioEngine.setDelayTime(val);
  });

  document.getElementById('fx-delay-feedback').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('fx-delay-feedback-val').textContent = val + '%';
    AudioEngine.setDelayFeedback(val / 100);
  });


  document.getElementById('btn-play').addEventListener('click', () => {
    if (Sequencer.isPlaying()) {
      Sequencer.stop();
      document.getElementById('btn-play').classList.remove('active');
      document.getElementById('btn-play').textContent = '▶';
    } else {
      Sequencer.play();
      document.getElementById('btn-play').classList.add('active');
      document.getElementById('btn-play').textContent = '⏸';
    }
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    Sequencer.stop();
    document.getElementById('btn-play').classList.remove('active');
    document.getElementById('btn-play').textContent = '▶';
  });

  document.getElementById('btn-rewind').addEventListener('click', () => {
    Sequencer.rewind();
  });

  document.getElementById('btn-record').addEventListener('click', () => {
    Sequencer.toggleRecord();
    document.getElementById('btn-record').classList.toggle('active', Sequencer.getState().isRecording);
  });

  // ─── BPM Control ─────────────────────────────────────────────
  const bpmInput = document.getElementById('bpm-value');
  bpmInput.addEventListener('change', () => {
    Sequencer.setBpm(parseInt(bpmInput.value, 10));
  });
  bpmInput.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    Sequencer.setBpm(Sequencer.getState().bpm + delta);
    bpmInput.value = Sequencer.getState().bpm;
  }, { passive: false });

  document.getElementById('bpm-up').addEventListener('click', () => {
    Sequencer.setBpm(Sequencer.getState().bpm + 1);
    bpmInput.value = Sequencer.getState().bpm;
  });
  document.getElementById('bpm-down').addEventListener('click', () => {
    Sequencer.setBpm(Sequencer.getState().bpm - 1);
    bpmInput.value = Sequencer.getState().bpm;
  });

  document.getElementById('btn-tap').addEventListener('click', () => {
    Sequencer.tap();
    bpmInput.value = Sequencer.getState().bpm;
  });

  // ─── Swing Control ────────────────────────────────────────────
  const swingSlider = document.getElementById('swing-slider');
  const swingVal = document.getElementById('swing-value');
  swingSlider.addEventListener('input', () => {
    const v = parseInt(swingSlider.value);
    Sequencer.setSwing(v);
    swingVal.textContent = v + '%';
  });

  // ─── Step Count ───────────────────────────────────────────────
  document.getElementById('step-count').addEventListener('change', (e) => {
    Sequencer.setStepCount(parseInt(e.target.value));
  });

  // ─── MIDI Connect ─────────────────────────────────────────────
  document.getElementById('btn-request-midi').addEventListener('click', async () => {
    const ok = await MidiManager.requestAccess();
    if (ok) {
      UI.renderDevices(MidiManager.getDeviceList());
      UI.showToast('MIDI connected!', 'success');
    } else {
      UI.showToast('MIDI access denied. Use Chrome/Edge.', 'error');
    }
  });

  // Try auto-connect MIDI on load
  (async () => {
    if (navigator.requestMIDIAccess) {
      const ok = await MidiManager.requestAccess().catch(() => false);
      if (ok) UI.renderDevices(MidiManager.getDeviceList());
    }
  })();

  // ─── MIDI Monitor Clear ───────────────────────────────────────
  document.getElementById('btn-clear-monitor').addEventListener('click', () => {
    MidiManager.clearLog();
  });

  // ─── Preset Randomize ─────────────────────────────────────────
  document.getElementById('btn-randomize').addEventListener('click', () => {
    Sequencer.randomizeAll();
    UI.renderSequencer(Sequencer.getState());
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    UI.showToast('Randomized all tracks!', 'info');
  });

  document.getElementById('btn-clear-all').addEventListener('click', () => {
    Sequencer.clearAllTracks();
    UI.renderSequencer(Sequencer.getState());
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    UI.showToast('All tracks cleared', 'info');
  });

  // ─── Save / Load / Export ─────────────────────────────────────
  document.getElementById('btn-save').addEventListener('click', () => {
    const ok = Storage.save();
    UI.showToast(ok ? '💾 Project saved!' : 'Save failed', ok ? 'success' : 'error');
  });

  document.getElementById('btn-load').addEventListener('click', () => {
    document.getElementById('file-load-input').click();
  });

  document.getElementById('file-load-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Storage.importJson(file, (err, project) => {
      if (err) {
        UI.showToast('Load failed: invalid file', 'error');
      } else {
        UI.renderSequencer(Sequencer.getState());
        bpmInput.value = Sequencer.getState().bpm;
        swingSlider.value = Sequencer.getState().swing;
        swingVal.textContent = Sequencer.getState().swing + '%';
        UI.showToast('Project loaded!', 'success');
      }
    });
    e.target.value = '';
  });

  document.getElementById('btn-export-midi').addEventListener('click', () => {
    Storage.exportMidi();
    UI.showToast('MIDI file exported!', 'success');
  });

  // ─── Note Picker Modal ────────────────────────────────────────
  document.getElementById('sp-velocity').addEventListener('input', (e) => {
    document.getElementById('sp-velocity-val').textContent = e.target.value;
  });
  document.getElementById('sp-probability').addEventListener('input', (e) => {
    document.getElementById('sp-probability-val').textContent = e.target.value + '%';
  });

  document.getElementById('sp-confirm').addEventListener('click', () => {
    // Apply note picker values (modal — not used directly in current flow)
    UI.closeNotePicker();
  });

  document.getElementById('sp-cancel').addEventListener('click', () => {
    UI.closeNotePicker();
  });

  // Close modal on overlay click
  document.getElementById('modal-note-picker').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) UI.closeNotePicker();
  });

  // ─── Keyboard shortcuts ────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.contentEditable === 'true') return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        document.getElementById('btn-play').click();
        break;
      case 'Escape':
        Sequencer.stop();
        document.getElementById('btn-play').classList.remove('active');
        document.getElementById('btn-play').textContent = '▶';
        break;
      case 'KeyR':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); document.getElementById('btn-record').click(); }
        break;
      case 'KeyS':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); document.getElementById('btn-save').click(); }
        break;
    }
  });

  // ─── Auto-save ────────────────────────────────────────────────
  Storage.startAutoSave();

  console.log('🎛️ MusicBox initialized. Space=Play/Pause, Esc=Stop, Ctrl+S=Save');

})();
