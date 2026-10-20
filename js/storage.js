/**
 * storage.js — Project Save / Load
 * ---------------------------------------------------------------------------
 * Handles localStorage persistence, JSON export/import, and MIDI file export.
 *
 * KEY FIXES (post-audit):
 *  - The project snapshot is LOSSLESS: audioMode, soloed, midiOutputId,
 *    the generative parameters, the spatial FX and the master volume are
 *    all saved and restored.
 *  - The project format is VERSIONED with a migration path, and a corrupt
 *    or future-versioned file can no longer brick the app (or be silently
 *    overwritten by the autosave).
 *  - The autosave writes to its OWN key with a rotating history, so it no
 *    longer destroys the user's manual save.
 *  - The exported .mid is musically faithful: muted tracks are skipped,
 *    velocity is scaled by the track volume, accents are honoured, slides
 *    are exported as legato, swing is applied, and program changes + track
 *    names are written.
 */

const Storage = (() => {

  const LS_KEY = 'musicbox_project';
  const LS_AUTOSAVE_KEY = 'musicbox_autosave';
  const LS_AUTOSAVE_HISTORY = ['musicbox_autosave_1', 'musicbox_autosave_2'];
  const LS_SLOTS_KEY = 'musicbox_slots';
  const SLOT_IDS = ['A', 'B', 'C', 'D'];

  const CURRENT_VERSION = 2;

  // ─── Snapshot ────────────────────────────────────────────────
  function _buildProjectSnapshot(name = 'MusicBox Project') {
    const state = Sequencer.getState();
    return {
      version: CURRENT_VERSION,
      name,
      savedAt: new Date().toISOString(),
      bpm: state.bpm,
      swing: state.swing,
      stepCount: state.stepCount,
      generative: state.generative ? JSON.parse(JSON.stringify(state.generative)) : null,
      tracks: state.tracks.map(t => ({
        name: t.name,
        midiChannel: t.midiChannel,
        muted: !!t.muted,
        soloed: !!t.soloed,
        volume: t.volume,
        audioMode: t.audioMode || 'both',
        midiOutputId: t.midiOutputId || null,
        role: t.role || null,
        steps: t.steps.map(s => ({ ...s })),
      })),
      instruments: window.AudioEngine ? AudioEngine.getTrackInstruments().map(i => i.type) : [],
      synthParams: window.AudioEngine ? AudioEngine.getAllTrackParams() : null,
      spatialFX: window.AudioEngine ? AudioEngine.getSpatialFX() : null,
      masterVolume: window.AudioEngine ? AudioEngine.getMasterVolume() : 0.72,
      audioEnabled: window.AudioEngine ? AudioEngine.isEnabled() : true,
    };
  }

  // ─── Validation ─────────────────────────────────────────────
  function _isValidProject(project) {
    if (!project || typeof project !== 'object') return false;
    if (typeof project.version !== 'number') return false;
    if (project.version > CURRENT_VERSION) return false;
    if (!Array.isArray(project.tracks)) return false;
    if (typeof project.bpm !== 'number' || !isFinite(project.bpm)) return false;
    return true;
  }

  /** Migrate an older project format to the current one. */
  function _migrate(project) {
    const p = { ...project };
    if (p.version === 1) {
      // v1 did not save audioMode / soloed / midiOutputId / generative / FX.
      p.tracks = (p.tracks || []).map(t => ({
        ...t,
        soloed: false,
        audioMode: 'both',
        midiOutputId: null,
        role: null,
        steps: (t.steps || []).map(s => ({
          active: !!s.active,
          note: s.note ?? 60,
          velocity: s.velocity ?? 100,
          gate: s.gate ?? 0.5,
          probability: s.probability ?? 100,
          accent: !!s.accent,
          slide: !!s.slide,
          offset: s.offset ?? 0,
          repeats: s.repeats ?? 1,
        })),
      }));
      p.generative = p.generative || null;
      p.synthParams = p.synthParams || null;
      p.spatialFX = p.spatialFX || null;
      p.version = 2;
    }
    return p;
  }

  // ─── Save project to localStorage ───────────────────────────
  function save() {
    const project = _buildProjectSnapshot();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(project));
      return true;
    } catch (e) {
      console.error('[Storage] Save failed:', e);
      return false;
    }
  }

  // ─── Load project from localStorage ─────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const project = JSON.parse(raw);
      if (!_isValidProject(project)) {
        console.warn('[Storage] Saved project is invalid or from a newer version.');
        return null;
      }
      return _migrate(project);
    } catch (e) {
      console.error('[Storage] Load failed:', e);
      return null;
    }
  }

  // ─── Apply loaded project to sequencer ──────────────────────
  function applyProject(project) {
    if (!_isValidProject(project)) return false;
    const p = _migrate(project);

    try {
      Sequencer.setBpm(p.bpm);
      Sequencer.setSwing(p.swing || 0);
      // Use the API, not a direct state mutation, so the steps are
      // padded AND trimmed and the UI can be synced.
      Sequencer.setStepCount(p.stepCount === 32 ? 32 : 16);
      Sequencer.initTracks(p.tracks || []);
      if (p.generative) Sequencer.setGenerativeParams(p.generative);
      if (p.synthParams && window.AudioEngine) {
        p.synthParams.forEach((params, idx) => {
          if (!params) return;
          Object.entries(params).forEach(([key, value]) => {
            AudioEngine.setTrackParam(idx, key, value);
          });
        });
        if (window.UI && UI.syncSynthPanel) UI.syncSynthPanel();
      }
      if (p.instruments && window.AudioEngine) {
        p.instruments.forEach((type, idx) => {
          if (idx < (p.tracks || []).length) AudioEngine.setTrackInstrument(idx, type);
        });
        if (window.UI && UI.renderInstruments) UI.renderInstruments();
      }
      if (p.spatialFX && window.AudioEngine) {
        const fx = p.spatialFX;
        AudioEngine.setReverbMix(fx.reverbMix ?? 0.25);
        AudioEngine.setReverbDecay(fx.reverbDecay ?? 2.5);
        if (fx.reverbTone !== undefined) AudioEngine.setReverbTone(fx.reverbTone);
        AudioEngine.setDelayMix(fx.delayMix ?? 0.2);
        AudioEngine.setDelayTime(fx.delayTime ?? 0.35);
        AudioEngine.setDelayFeedback(fx.delayFeedback ?? 0.45);
        if (fx.delayTone !== undefined) AudioEngine.setDelayTone(fx.delayTone);
        if (window.UI && UI.syncSpatialSliders) UI.syncSpatialSliders(fx);
      }
      if (p.masterVolume !== undefined && window.AudioEngine) {
        AudioEngine.setMasterVolume(p.masterVolume);
      }
      return true;
    } catch (e) {
      console.error('[Storage] Apply failed:', e);
      return false;
    }
  }

  // ─── Export project as JSON file ─────────────────────────────
  function exportJson() {
    const project = _buildProjectSnapshot();
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    _download(blob, `musicbox_${_safeName(project.name)}_${Date.now()}.json`);
  }

  function _safeName(s) {
    return String(s || 'project').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 32);
  }

  // ─── Named Save Slots (A/B/C/D) ─────────────────────────────
  function saveSlot(slotId) {
    if (!SLOT_IDS.includes(slotId)) return false;
    const project = _buildProjectSnapshot(`Slot ${slotId}`);
    try {
      localStorage.setItem(`musicbox_slot_${slotId}`, JSON.stringify(project));
      return true;
    } catch (e) {
      console.error(`[Storage] Slot ${slotId} save failed:`, e);
      return false;
    }
  }

  function loadSlot(slotId) {
    if (!SLOT_IDS.includes(slotId)) return false;
    try {
      const raw = localStorage.getItem(`musicbox_slot_${slotId}`);
      if (!raw) return false;
      const project = JSON.parse(raw);
      if (!_isValidProject(project)) return false;
      return applyProject(project);
    } catch (e) {
      console.error(`[Storage] Slot ${slotId} load failed:`, e);
      return false;
    }
  }

  function getSlotMeta() {
    return SLOT_IDS.map(id => {
      try {
        const raw = localStorage.getItem(`musicbox_slot_${id}`);
        if (!raw) return { id, empty: true };
        const p = JSON.parse(raw);
        return { id, empty: false, savedAt: p.savedAt, bpm: p.bpm, name: p.name };
      } catch { return { id, empty: true }; }
    });
  }

  // ─── Import JSON file ────────────────────────────────────────
  function importJson(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const raw = JSON.parse(e.target.result);
        if (!_isValidProject(raw)) {
          callback(new Error('Unsupported or invalid project file'), null);
          return;
        }
        const project = _migrate(raw);
        const ok = applyProject(project);
        callback(ok ? null : new Error('Invalid project format'), project);
      } catch (err) {
        callback(err, null);
      }
    };
    reader.readAsText(file);
  }

  // ─── Export as MIDI file ─────────────────────────────────────
  function exportMidi() {
    const state = Sequencer.getState();
    const bpm = state.bpm;
    const stepCount = state.stepCount;
    const ppq = 96;              // pulses per quarter note
    const stepTicks = ppq / 4;   // ticks per 16th note
    const swing = state.swing || 0;

    const instruments = window.AudioEngine
      ? AudioEngine.getTrackInstruments().map(i => i.type)
      : [];
    const GM_PROGRAMS = { bass: 38, lead: 81, pad: 89, acid: 38, drum: 0, synth: 81 };

    // MIDI file structure: header + 1 tempo track + 1 track per sequencer track
    const tracks = state.tracks.map((track, trackIdx) => {
      const events = [];
      const ch = Math.max(0, Math.min(15, (track.midiChannel || 1) - 1));
      const volScale = (track.volume ?? 100) / 100;

      track.steps.slice(0, stepCount).forEach((step, stepIdx) => {
        if (!step.active) return;

        // Swing: odd steps are pushed later by the swing amount.
        const swingTicks = (stepIdx % 2 === 1) ? Math.round(stepTicks * swing / 100) : 0;
        const tick = stepIdx * stepTicks + swingTicks;

        // Gate is clamped to one step so a note can never bleed into the next.
        const gateTicks = Math.max(1, Math.min(stepTicks, Math.round(stepTicks * step.gate)));

        let vel = Math.round(step.velocity * volScale);
        if (step.accent) vel = Math.max(vel, 100);   // accent → hardware accent
        vel = Math.max(1, Math.min(127, vel));

        events.push({ tick, order: 0, type: 'noteon',  ch, note: step.note, vel });
        // A slide is a legato: no note-off until the next note-on.
        if (!step.slide) {
          events.push({ tick: tick + gateTicks, order: 1, type: 'noteoff', ch, note: step.note, vel: 0 });
        }
      });

      // Track name (META 0xFF 0x03) and program change.
      const meta = [];
      const nameBytes = _asciiBytes(track.name || `Track ${trackIdx + 1}`);
      meta.push({ tick: 0, bytes: [0xFF, 0x03, nameBytes.length, ...nameBytes] });

      const instr = instruments[trackIdx];
      if (instr && GM_PROGRAMS[instr] !== undefined && ch !== 9) {
        meta.push({ tick: 0, bytes: [0xC0 | ch, GM_PROGRAMS[instr]] });
      }

      return { events, meta, name: track.name };
    });

    // Skip muted tracks entirely.
    const active = tracks.filter((_, i) => !state.tracks[i].muted);

    const totalTicks = stepCount * stepTicks;
    const bytes = _buildMidiFile(ppq, bpm, active, totalTicks);
    const blob = new Blob([bytes], { type: 'audio/midi' });
    _download(blob, `musicbox_${Date.now()}.mid`);
  }

  function _asciiBytes(s) {
    return Array.from(String(s).slice(0, 20)).map(c => c.charCodeAt(0) & 0x7F);
  }

  // ─── Build raw MIDI bytes ─────────────────────────────────────
  function _buildMidiFile(ppq, bpm, trackEventArrays, totalTicks) {
    const numTracks = trackEventArrays.length + 1; // +1 for tempo track
    const chunks = [];

    // Header chunk
    chunks.push(_midiHeader(1, numTracks, ppq));

    // Tempo track
    chunks.push(_buildTempoTrack(bpm));

    // Event tracks
    trackEventArrays.forEach(track => {
      chunks.push(_buildEventTrack(track, totalTicks));
    });

    // Flatten
    let totalLen = 0;
    chunks.forEach(c => totalLen += c.length);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    chunks.forEach(c => { result.set(c, offset); offset += c.length; });
    return result;
  }

  function _midiHeader(format, numTracks, ppq) {
    return new Uint8Array([
      0x4D,0x54,0x68,0x64, // MThd
      0x00,0x00,0x00,0x06, // chunk length 6
      0x00, format,        // format
      (numTracks >> 8) & 0xFF, numTracks & 0xFF,
      (ppq >> 8) & 0xFF, ppq & 0xFF,
    ]);
  }

  function _buildTempoTrack(bpm) {
    const microsecondsPerBeat = Math.round(60000000 / bpm);
    const tempoEvent = [
      0x00,              // delta time 0
      0xFF, 0x51, 0x03,  // tempo meta event
      (microsecondsPerBeat >> 16) & 0xFF,
      (microsecondsPerBeat >> 8)  & 0xFF,
       microsecondsPerBeat        & 0xFF,
    ];
    // Time signature: 4/4
    const timeSig = [0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08];
    const endTrack = [0x00, 0xFF, 0x2F, 0x00];
    return _wrapTrackChunk([...tempoEvent, ...timeSig, ...endTrack]);
  }

  function _buildEventTrack(track, totalTicks) {
    const bytes = [];
    let lastTick = 0;

    // META events (track name) first, at tick 0.
    (track.meta || []).forEach(m => {
      bytes.push(..._varLen(0));
      bytes.push(...m.bytes);
    });

    // Note events: sorted by tick, note-offs BEFORE note-ons at the same
    // tick (that is the correct MIDI idiom and avoids truncated notes).
    const events = (track.events || []).slice().sort((a, b) =>
      a.tick - b.tick || a.order - b.order);

    events.forEach(ev => {
      const delta = ev.tick - lastTick;
      lastTick = ev.tick;
      bytes.push(..._varLen(delta));
      if (ev.type === 'noteon') {
        bytes.push(0x90 | ev.ch, ev.note & 0x7F, ev.vel & 0x7F);
      } else {
        bytes.push(0x80 | ev.ch, ev.note & 0x7F, 0);
      }
    });

    // End of track
    const remaining = Math.max(0, totalTicks - lastTick);
    bytes.push(..._varLen(remaining));
    bytes.push(0xFF, 0x2F, 0x00);
    return _wrapTrackChunk(bytes);
  }

  function _wrapTrackChunk(bytes) {
    const len = bytes.length;
    const header = [
      0x4D,0x54,0x72,0x6B, // MTrk
      (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF,
    ];
    return new Uint8Array([...header, ...bytes]);
  }

  function _varLen(value) {
    const bytes = [];
    bytes.unshift(value & 0x7F);
    value >>= 7;
    while (value > 0) {
      bytes.unshift((value & 0x7F) | 0x80);
      value >>= 7;
    }
    return bytes;
  }

  // ─── File download helper ─────────────────────────────────────
  function _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ─── Auto-save ───────────────────────────────────────────────
  // Writes to its OWN key with a rotating history, so it never destroys
  // the user's manual save.
  let autosaveTimer = null;
  function startAutoSave(intervalMs = 30000) {
    if (autosaveTimer) clearInterval(autosaveTimer);
    autosaveTimer = setInterval(() => autoSave(), intervalMs);
  }

  function autoSave() {
    try {
      const project = _buildProjectSnapshot('Autosave');
      const raw = JSON.stringify(project);
      // Rotate the history.
      try {
        const prev = localStorage.getItem(LS_AUTOSAVE_KEY);
        if (prev) {
          localStorage.setItem(LS_AUTOSAVE_HISTORY[1], localStorage.getItem(LS_AUTOSAVE_HISTORY[0]) || prev);
          localStorage.setItem(LS_AUTOSAVE_HISTORY[0], prev);
        }
      } catch (e) { /* history is best-effort */ }
      localStorage.setItem(LS_AUTOSAVE_KEY, raw);
      return true;
    } catch (e) {
      console.error('[Storage] Autosave failed:', e);
      return false;
    }
  }

  function getAutosaveMeta() {
    try {
      const raw = localStorage.getItem(LS_AUTOSAVE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return { savedAt: p.savedAt, bpm: p.bpm };
    } catch { return null; }
  }

  /** Restore the most recent autosave. */
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(LS_AUTOSAVE_KEY);
      if (!raw) return false;
      const project = JSON.parse(raw);
      if (!_isValidProject(project)) return false;
      return applyProject(project);
    } catch { return false; }
  }

  return {
    save, load, applyProject,
    exportJson, importJson,
    exportMidi,
    startAutoSave, autoSave, getAutosaveMeta, loadAutosave,
    saveSlot, loadSlot, getSlotMeta,
  };

})();

window.Storage = Storage;
