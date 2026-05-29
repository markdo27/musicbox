/**
 * storage.js — Project Save / Load
 * Handles localStorage persistence, JSON export/import,
 * and basic MIDI file export.
 */

const Storage = (() => {

  const LS_KEY = 'musicbox_project';
  const LS_SLOTS_KEY = 'musicbox_slots';

  // ─── Save project to localStorage ───────────────────────────
  function save() {
    const state = Sequencer.getState();
    const project = {
      version: 1,
      savedAt: new Date().toISOString(),
      bpm: state.bpm,
      swing: state.swing,
      stepCount: state.stepCount,
      tracks: state.tracks.map(t => ({
        name: t.name,
        midiChannel: t.midiChannel,
        muted: t.muted,
        volume: t.volume,
        steps: t.steps.map(s => ({ ...s })),
      })),
    };
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
      return JSON.parse(raw);
    } catch (e) {
      console.error('[Storage] Load failed:', e);
      return null;
    }
  }

  // ─── Apply loaded project to sequencer ──────────────────────
  function applyProject(project) {
    if (!project || project.version !== 1) return false;
    Sequencer.setBpm(project.bpm || 132);
    Sequencer.setSwing(project.swing || 0);
    // Set step count without triggering full rebuild (will be done by initTracks)
    Sequencer.getState().stepCount = project.stepCount || 16;
    Sequencer.initTracks(project.tracks || []);
    return true;
  }

  // ─── Export project as JSON file ─────────────────────────────
  function exportJson() {
    const state = Sequencer.getState();
    const project = {
      version: 1,
      name: 'MusicBox Project',
      savedAt: new Date().toISOString(),
      bpm: state.bpm,
      swing: state.swing,
      stepCount: state.stepCount,
      tracks: state.tracks.map(t => ({
        name: t.name,
        midiChannel: t.midiChannel,
        muted: t.muted,
        volume: t.volume,
        steps: t.steps.map(s => ({ ...s })),
      })),
    };

    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    _download(blob, `musicbox_${Date.now()}.json`);
  }

  // ─── Import JSON file ────────────────────────────────────────
  function importJson(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const project = JSON.parse(e.target.result);
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
    const ppq = 96; // pulses per quarter note
    const stepTicks = ppq / 4; // ticks per 16th note

    // MIDI file structure: header + 1 track per sequencer track
    const tracks = state.tracks.map(track => {
      const events = [];
      track.steps.forEach((step, stepIdx) => {
        if (!step.active) return;
        const tick = stepIdx * stepTicks;
        const gateTicks = Math.max(1, Math.round(stepTicks * step.gate));
        const ch = Math.max(0, Math.min(15, (track.midiChannel || 1) - 1));
        events.push({ tick, type: 'noteon',  ch, note: step.note, vel: step.velocity });
        events.push({ tick: tick + gateTicks, type: 'noteoff', ch, note: step.note, vel: 0 });
      });
      events.sort((a, b) => a.tick - b.tick);
      return events;
    });

    const bytes = _buildMidiFile(ppq, bpm, tracks, stepCount * stepTicks);
    const blob = new Blob([bytes], { type: 'audio/midi' });
    _download(blob, `musicbox_${Date.now()}.mid`);
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
    trackEventArrays.forEach(events => {
      chunks.push(_buildEventTrack(events, totalTicks));
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
    const endTrack = [0x00, 0xFF, 0x2F, 0x00];
    return _wrapTrackChunk([...tempoEvent, ...endTrack]);
  }

  function _buildEventTrack(events, totalTicks) {
    const bytes = [];
    let lastTick = 0;
    events.forEach(ev => {
      const delta = ev.tick - lastTick;
      lastTick = ev.tick;
      bytes.push(..._varLen(delta));
      if (ev.type === 'noteon') {
        bytes.push(0x90 | ev.ch, ev.note, ev.vel);
      } else {
        bytes.push(0x80 | ev.ch, ev.note, 0);
      }
    });
    // End of track
    const remaining = totalTicks - lastTick;
    bytes.push(..._varLen(Math.max(0, remaining)));
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

  // ─── Auto-save every 30 seconds ──────────────────────────────
  function startAutoSave() {
    setInterval(() => {
      save();
    }, 30000);
  }

  return {
    save, load, applyProject,
    exportJson, importJson,
    exportMidi,
    startAutoSave,
  };

})();

window.Storage = Storage;
