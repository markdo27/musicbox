/**
 * app.js — Main Application Entry Point
 * Wires together MIDI, Sequencer, UI, and Storage modules.
 * Handles all top-level event listeners and initialization.
 */

(async function init() {

  // ─── Default tracks (8 empty tracks) ─────────────────────────
  // audioMode: 'both' | 'internal' | 'midi'
  const DEFAULT_TRACKS = [
    { name: 'Kick',    midiChannel: 10, muted: false, volume: 100, audioMode: 'both' },
    { name: 'Snare',   midiChannel: 10, muted: false, volume: 100, audioMode: 'both' },
    { name: 'HH',      midiChannel: 10, muted: false, volume: 100, audioMode: 'both' },
    { name: 'Perc',    midiChannel: 10, muted: false, volume: 100, audioMode: 'both' },
    { name: 'Bass',    midiChannel: 1,  muted: false, volume: 100, audioMode: 'both' },
    { name: 'Lead',    midiChannel: 2,  muted: false, volume: 100, audioMode: 'both' },
    { name: 'Chord',   midiChannel: 3,  muted: false, volume: 100, audioMode: 'both' },
    { name: 'FX',      midiChannel: 4,  muted: false, volume: 100, audioMode: 'both' },
  ].map(t => ({
    ...t,
    steps: Array.from({ length: 16 }, () => ({
      active: false, note: 60, velocity: 100, gate: 0.5, probability: 100,
      accent: false, slide: false, offset: 0, repeats: 1,
    })),
  }));

  // ─── DOM shorthands ──────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const bpmInput = $('bpm-value');
  const swingSlider = $('swing-slider');
  const swingVal = $('swing-value');

  // ─── Initialize modules ───────────────────────────────────────

  // Sequencer: register callbacks
  Sequencer.setStepCallback((step) => {
    UI.updatePlayhead(step);
    if (step >= 0) {
      // Flash track activity LEDs for active steps
      Sequencer.getTracks().forEach((track, i) => {
        const stepData = track.steps[step];
        if (stepData?.active && !track.muted) {
          UI.flashTrackActivity(i);
          if (stepData.note !== undefined) UI.flashKey(stepData.note);
        }
      });
      // Update bar:beat:step clock — use the PLAYING step, not the
      // scheduler's look-ahead step, or the clock reads one step ahead.
      const bb = Sequencer.barBeat(step);
      $('clock-bar').textContent = bb.bar;
      $('clock-beat').textContent = bb.beat;
      $('clock-step').textContent = bb.step;
    }
  });

  Sequencer.setStateCallback((state) => {
    UI.renderSequencer(state);
    UI.syncControls(state);
  });

  // Light updates: BPM, swing, transport, undo/redo availability.
  // These must NOT re-render the 256 step buttons.
  Sequencer.setTransportCallback((state) => {
    UI.syncControls(state);
  });

  // MIDI: register monitor element
  MidiManager.setLogElement($('monitor-log'));

  // MIDI device change callback → refresh device panel
  MidiManager.setDeviceChangeCallback((devices) => {
    UI.renderDevices(devices);
  });

  // MIDI incoming message → record if active
  MidiManager.setMessageCallback((msg) => {
    if (msg.type === 'noteon' && Sequencer.getState().isRecording && Sequencer.isPlaying()) {
      // Use the PLAYING step, otherwise the note lands 1–2 sixteenths
      // ahead of where it was actually played.
      const step = Sequencer.getPlayingStep();
      if (step >= 0) {
        const trackIdx = Sequencer.getTracks().findIndex(t => t.midiChannel === msg.channel);
        if (trackIdx >= 0) {
          Sequencer.setStepData(trackIdx, step, {
            active: true,
            note: msg.note,
            velocity: msg.velocity,
          });
          UI.refreshStepBtn(trackIdx, step);
        }
      }
    }
  });

  // MIDI activity → flash the matching track
  MidiManager.setActivityCallback((channel, note) => {
    const idx = Sequencer.getTracks().findIndex(t => t.midiChannel === channel);
    if (idx >= 0) UI.flashTrackActivity(idx);
  });

  // ─── Load saved project or init defaults ──────────────────────
  const saved = Storage.load();
  if (saved) {
    const ok = Storage.applyProject(saved);
    if (ok) {
      UI.showToast('Project restored', 'success');
    } else {
      Sequencer.initTracks(DEFAULT_TRACKS);
      UI.showToast('Saved project could not be read — starting fresh', 'error');
    }
  } else {
    Sequencer.initTracks(DEFAULT_TRACKS);
  }

  // On a FIRST run the app would open to a completely empty grid, which
  // reads as "broken" rather than "blank". Seed it with a playable pattern
  // so the user lands on something they can immediately hear and edit.
  if (!saved && window.Generator) {
    const seed = Generator.randomSeedString();
    Sequencer.setGenerativeParams(Generator.normaliseParams({ genre: 'techno', seed }));
    Sequencer.randomizeAll();
  }

  // ─── Render UI ────────────────────────────────────────────────
  UI.renderPresets();
  UI.renderKeyboard();
  UI.renderSequencer(Sequencer.getState());
  UI.syncControls(Sequencer.getState());
  // The known-hardware cards must ALWAYS be visible (connected or offline).
  // Previously renderDevices() was only called after a successful MIDI
  // request, so on a browser without Web MIDI the panel was simply empty.
  UI.renderDevices(MidiManager.getDeviceList());

  // ─── Audio Engine Init ────────────────────────────────────────
  // The AudioContext is created lazily on the first user gesture, so the
  // autoplay policy is respected. The sampler database is fetched in the
  // BACKGROUND — awaiting it here used to block every button on the page
  // when the network was slow.
  if (window.SamplerEngine) {
    SamplerEngine.init().then(() => {
      UI.renderInstruments();
    });
  }
  UI.renderInstruments();
  UI.renderGenerator();

  // Audio toggle button
  const audioToggleBtn = $('btn-audio-toggle');
  audioToggleBtn.addEventListener('click', () => {
    const enabled = !AudioEngine.isEnabled();
    AudioEngine.setEnabled(enabled);
    audioToggleBtn.classList.toggle('active', enabled);
    audioToggleBtn.setAttribute('aria-pressed', String(enabled));
    audioToggleBtn.querySelector('.audio-toggle-icon').textContent = enabled ? '🔊' : '🔇';
    UI.showToast(enabled ? '🔊 Audio ON' : '🔇 Audio OFF', 'info');
  });

  // Master volume slider
  $('master-vol').addEventListener('input', (e) => {
    AudioEngine.setMasterVolume(parseInt(e.target.value, 10) / 100);
  });

  // Spatial FX UI bindings
  $('fx-reverb-mix').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    $('fx-reverb-mix-val').textContent = val + '%';
    AudioEngine.setReverbMix(val / 100);
  });

  $('fx-reverb-decay').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10) / 10;
    $('fx-reverb-decay-val').textContent = val.toFixed(1) + 's';
    AudioEngine.setReverbDecay(val);
  });

  $('fx-reverb-tone').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    $('fx-reverb-tone-val').textContent = (val / 1000).toFixed(1) + 'k';
    AudioEngine.setReverbTone(val);
  });

  $('fx-delay-mix').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    $('fx-delay-mix-val').textContent = val + '%';
    AudioEngine.setDelayMix(val / 100);
  });

  $('fx-delay-time').addEventListener('change', (e) => {
    AudioEngine.setDelayTime(parseFloat(e.target.value));
  });

  $('fx-delay-feedback').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    $('fx-delay-feedback-val').textContent = val + '%';
    AudioEngine.setDelayFeedback(val / 100);
  });

  // ─── Transport ────────────────────────────────────────────────
  $('btn-play').addEventListener('click', () => {
    if (Sequencer.isPlaying()) {
      Sequencer.stop();
    } else {
      // The AudioContext must exist and be running before the transport starts.
      AudioEngine.init();
      AudioEngine.resume();
      Sequencer.play();
      // Tell the hardware which patch each track should play.
      MidiManager.sendProgramChanges(Sequencer.getTracks());
    }
    UI.syncControls(Sequencer.getState());
  });

  $('btn-stop').addEventListener('click', () => {
    Sequencer.stop();
    UI.syncControls(Sequencer.getState());
  });

  $('btn-rewind').addEventListener('click', () => {
    Sequencer.rewind();
    UI.syncControls(Sequencer.getState());
  });

  $('btn-record').addEventListener('click', () => {
    Sequencer.toggleRecord();
    UI.syncControls(Sequencer.getState());
  });

  // ─── BPM Control ─────────────────────────────────────────────
  bpmInput.addEventListener('change', () => {
    Sequencer.setBpm(parseInt(bpmInput.value, 10));
    UI.syncControls(Sequencer.getState());
  });
  bpmInput.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    Sequencer.setBpm(Sequencer.getState().bpm + delta);
    UI.syncControls(Sequencer.getState());
  }, { passive: false });

  $('bpm-up').addEventListener('click', () => {
    Sequencer.setBpm(Sequencer.getState().bpm + 1);
    UI.syncControls(Sequencer.getState());
  });

  $('bpm-down').addEventListener('click', () => {
    Sequencer.setBpm(Sequencer.getState().bpm - 1);
    UI.syncControls(Sequencer.getState());
  });

  $('btn-tap').addEventListener('click', () => {
    Sequencer.tap();
    UI.syncControls(Sequencer.getState());
  });

  // ─── Swing Control ────────────────────────────────────────────
  swingSlider.addEventListener('input', () => {
    const v = parseInt(swingSlider.value, 10);
    Sequencer.setSwing(v);
    swingVal.textContent = v + '%';
  });

  // ─── Step Count ───────────────────────────────────────────────
  $('step-count').addEventListener('change', (e) => {
    Sequencer.setStepCount(parseInt(e.target.value, 10));
    UI.syncControls(Sequencer.getState());
  });

  // ─── MIDI Connect ─────────────────────────────────────────────
  $('btn-request-midi').addEventListener('click', async () => {
    const ok = await MidiManager.requestAccess();
    if (ok) {
      MidiManager.restoreSelectedOutput();
      UI.renderDevices(MidiManager.getDeviceList());
      UI.showToast('MIDI connected!', 'success');
    } else {
      UI.showToast('MIDI access denied. Use Chrome/Edge over http:// or https://.', 'error');
    }
  });

  // Reconnect silently if the browser has already granted MIDI access.
  // Chrome 124+ prompts for ALL Web MIDI use, so an unsolicited prompt on
  // page load gets ignored — only auto-connect when permission exists.
  (async () => {
    if (!navigator.requestMIDIAccess) return;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: 'midi' });
        if (status.state !== 'granted') return;
      }
    } catch (e) {
      // Permissions API does not know about 'midi' in some browsers —
      // fall through and try anyway.
    }
    const ok = await MidiManager.requestAccess().catch(() => false);
    if (ok) {
      MidiManager.restoreSelectedOutput();
      UI.renderDevices(MidiManager.getDeviceList());
    }
  })();

  // ─── MIDI Monitor Clear ───────────────────────────────────────
  $('btn-clear-monitor').addEventListener('click', () => {
    MidiManager.clearLog();
  });

  // ─── Preset Randomize ─────────────────────────────────────────
  $('btn-randomize').addEventListener('click', () => {
    if (window.Generator) {
      // Generate from the panel's current parameters.
      UI.renderGenerator();
      const genBtn = $('gen-generate');
      if (genBtn) genBtn.click();
    } else {
      Sequencer.randomizeAll();
      UI.renderSequencer(Sequencer.getState());
    }
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    UI.showToast('Generated a new pattern', 'info');
    UI.syncControls(Sequencer.getState());
  });

  $('btn-clear-all').addEventListener('click', () => {
    Sequencer.clearAllTracks();
    UI.renderSequencer(Sequencer.getState());
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    UI.showToast('All tracks cleared', 'info');
    UI.syncControls(Sequencer.getState());
  });

  // ─── Save / Load / Export ─────────────────────────────────────
  $('btn-save').addEventListener('click', () => {
    const ok = Storage.save();
    UI.showToast(ok ? '💾 Project saved!' : 'Save failed', ok ? 'success' : 'error');
  });

  $('btn-load').addEventListener('click', () => {
    $('file-load-input').click();
  });

  $('file-load-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Storage.importJson(file, (err) => {
      if (err) {
        UI.showToast('Load failed: ' + (err.message || 'invalid file'), 'error');
      } else {
        UI.renderSequencer(Sequencer.getState());
        UI.renderInstruments();
        UI.renderGenerator();
        UI.syncControls(Sequencer.getState());
        UI.showToast('Project loaded!', 'success');
      }
    });
    e.target.value = '';
  });

  $('btn-export-json').addEventListener('click', () => {
    Storage.exportJson();
    UI.showToast('Project exported as .json', 'success');
  });

  $('btn-export-midi').addEventListener('click', () => {
    Storage.exportMidi();
    UI.showToast('MIDI file exported!', 'success');
  });

  // ─── Note Picker Modal ────────────────────────────────────────
  $('sp-velocity').addEventListener('input', (e) => {
    $('sp-velocity-val').textContent = e.target.value;
  });
  $('sp-probability').addEventListener('input', (e) => {
    $('sp-probability-val').textContent = e.target.value + '%';
  });

  $('sp-confirm').addEventListener('click', () => {
    const editing = UI.getCurrentStepEditing();
    if (editing) {
      const { trackIdx, stepIdx } = editing;
      const octave = parseInt($('sp-octave')?.value || '4', 10);
      const noteInOctave = UI.getSelectedNoteInPicker();
      const note = (octave + 1) * 12 + noteInOctave;
      const velocity = parseInt($('sp-velocity').value, 10);
      const gate = parseFloat($('sp-gate').value);
      const probability = parseInt($('sp-probability').value, 10);
      Sequencer.setStepData(trackIdx, stepIdx, { note, velocity, gate, probability });
    }
    UI.closeNotePicker();
  });

  $('sp-cancel').addEventListener('click', () => {
    UI.closeNotePicker();
  });

  $('modal-note-picker').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) UI.closeNotePicker();
  });

  // ─── Keyboard shortcuts ───────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs or when a button has focus
    // (Space would otherwise activate the button AND toggle playback).
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
        e.target.contentEditable === 'true') return;

    switch (e.code) {
      case 'Space':
        if (tag === 'BUTTON') return;
        e.preventDefault();
        $('btn-play').click();
        break;
      case 'Escape':
        Sequencer.stop();
        UI.syncControls(Sequencer.getState());
        // Close any open modals
        $('modal-shortcuts').hidden = true;
        $('modal-about').hidden = true;
        $('modal-note-picker').hidden = true;
        break;
      case 'KeyR':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          $('btn-record').click();
        } else {
          // New random seed in the generator
          e.preventDefault();
          const reroll = $('gen-reroll');
          if (reroll) reroll.click();
        }
        break;
      case 'KeyS':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); $('btn-save').click(); }
        break;
      case 'KeyZ':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) $('btn-redo').click();
          else $('btn-undo').click();
        }
        break;
      case 'KeyG':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const genBtn = $('gen-generate');
          if (genBtn) genBtn.click();
        }
        break;
      default:
        // "?" — layout independent (e.code === 'Slash' only works on US/UK).
        if (e.key === '?') {
          e.preventDefault();
          const modal = $('modal-shortcuts');
          modal.hidden = !modal.hidden;
        }
    }
  });

  // ─── Undo / Redo ──────────────────────────────────────────────
  $('btn-undo').addEventListener('click', () => {
    if (Sequencer.undo()) {
      UI.renderSequencer(Sequencer.getState());
      UI.renderInstruments();
      UI.renderGenerator();
      UI.showToast('↩ Undo', 'info');
    }
    UI.syncControls(Sequencer.getState());
  });

  $('btn-redo').addEventListener('click', () => {
    if (Sequencer.redo()) {
      UI.renderSequencer(Sequencer.getState());
      UI.renderInstruments();
      UI.renderGenerator();
      UI.showToast('↪ Redo', 'info');
    }
    UI.syncControls(Sequencer.getState());
  });

  // ─── Keyboard Shortcuts Modal ─────────────────────────────────
  $('btn-help').addEventListener('click', () => {
    $('modal-shortcuts').hidden = false;
  });
  $('shortcuts-close').addEventListener('click', () => {
    $('modal-shortcuts').hidden = true;
  });
  $('modal-shortcuts').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  // ─── About & Licence Modal ────────────────────────────────────
  $('btn-about').addEventListener('click', () => {
    $('modal-about').hidden = false;
  });
  $('about-close').addEventListener('click', () => {
    $('modal-about').hidden = true;
  });
  $('modal-about').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  // ─── Save Slots ───────────────────────────────────────────────
  let _pendingSlotId = null;
  const slotMenu = $('slot-menu');

  function _updateSlotButtons() {
    const meta = Storage.getSlotMeta();
    meta.forEach(slot => {
      const btn = $(`slot-btn-${slot.id}`);
      if (!btn) return;
      btn.classList.toggle('filled', !slot.empty);
      if (!slot.empty) {
        const date = new Date(slot.savedAt).toLocaleTimeString();
        btn.title = `Slot ${slot.id} — ${slot.bpm} BPM (${date})`;
      } else {
        btn.title = `Slot ${slot.id} — empty`;
      }
    });
  }

  document.querySelectorAll('.slot-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      _pendingSlotId = btn.dataset.slot;
      const rect = btn.getBoundingClientRect();
      slotMenu.style.top = (rect.bottom + 8) + 'px';
      slotMenu.style.left = rect.left + 'px';
      slotMenu.hidden = false;
    });
  });

  $('slot-menu-save').addEventListener('click', () => {
    if (!_pendingSlotId) return;
    const ok = Storage.saveSlot(_pendingSlotId);
    UI.showToast(ok ? `Saved to Slot ${_pendingSlotId}` : 'Save failed', ok ? 'success' : 'error');
    _updateSlotButtons();
    slotMenu.hidden = true;
  });

  $('slot-menu-load').addEventListener('click', () => {
    if (!_pendingSlotId) return;
    Sequencer.saveUndo();
    const ok = Storage.loadSlot(_pendingSlotId);
    if (ok) {
      UI.renderSequencer(Sequencer.getState());
      UI.renderInstruments();
      UI.renderGenerator();
      UI.syncControls(Sequencer.getState());
      UI.showToast(`Loaded Slot ${_pendingSlotId}`, 'success');
    } else {
      UI.showToast(`Slot ${_pendingSlotId} is empty`, 'error');
    }
    slotMenu.hidden = true;
  });

  $('slot-menu-cancel').addEventListener('click', () => {
    slotMenu.hidden = true;
  });

  document.addEventListener('click', (e) => {
    if (!slotMenu.hidden && !slotMenu.contains(e.target) && !e.target.classList.contains('slot-btn')) {
      slotMenu.hidden = true;
    }
  });

  _updateSlotButtons();

  // ─── Seed from the URL hash (shareable results) ───────────────
  (function applyUrlSeed() {
    if (!location.hash) return;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const seed = params.get('seed');
    if (!seed) return;
    const gen = window.Generator;
    if (!gen) return;
    const patch = {
      seed,
      genre: params.get('genre') || undefined,
      root: params.get('root') ? parseInt(params.get('root'), 10) : undefined,
      scale: params.get('scale') || undefined,
    };
    const opts = gen.normaliseParams(patch);
    Sequencer.setGenerativeParams(opts);
    Sequencer.randomizeAll();
    UI.renderSequencer(Sequencer.getState());
    UI.renderGenerator();
    UI.syncControls(Sequencer.getState());
    UI.showToast(`Loaded shared seed ${seed}`, 'success');
  })();

  // ─── Master level meter (real, from an AnalyserNode) ──────────
  (function masterMeter() {
    const fill = $('master-meter-fill');
    if (!fill) return;
    const data = new Uint8Array(512);
    function tick() {
      const analyser = AudioEngine.getAnalyser();
      if (analyser) {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        fill.style.width = Math.min(100, Math.round(peak * 118)) + '%';
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  // ─── Auto-save + unload save ──────────────────────────────────
  Storage.startAutoSave(30000);

  window.addEventListener('beforeunload', () => {
    // The autosave has its own key, so this is a safe belt-and-braces copy.
    Storage.autoSave();
  });

  console.log('🎛️ MusicBox v2 initialized. Space=Play/Pause, Esc=Stop, Ctrl+S=Save, G=Generate');

})();
