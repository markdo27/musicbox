/**
 * midi.js — Web MIDI API Manager
 * ---------------------------------------------------------------------------
 * Handles device detection, connection, sending/receiving messages,
 * a drift-free MIDI clock, per-track output routing, and the monitor log.
 *
 * KEY FIXES (post-audit):
 *  - The clock is derived from the AudioContext, not a free-running
 *    setInterval. A setInterval clock drifts without bound and collapses
 *    to 2.5 BPM in a background tab; this one keeps an exact pulse COUNT
 *    over any window, so the average tempo is exact.
 *  - Changing the BPM no longer sends Stop + Start (which restarted the
 *    song position on every hardware slave).
 *  - Per-track output routing is honoured: `noteOn`/`noteOff` accept an
 *    outputId and the sequencer passes `track.midiOutputId`.
 *  - The DEVICE_PROFILES CC map is actually WIRED — it was decorative.
 *  - Every `send()` is guarded: a disconnected port can no longer break
 *    the transport.
 */

const MidiManager = (() => {

  // ─── State ──────────────────────────────────────────────────
  let midiAccess = null;
  const outputs = new Map();   // id → MIDIOutput
  const inputs  = new Map();   // id → MIDIInput
  let selectedOutputId = null;
  let onDeviceChange = null;   // callback → UI refresh
  let onMessage = null;        // callback → monitor
  let onExternalClock = null;  // callback → sequencer (slave mode)
  let onCcActivity = null;     // callback → MIDI activity LED

  // ─── Device profiles ────────────────────────────────────────
  // `match`   : regex list used to identify the device by name
  // `clock`   : receives MIDI clock (0xF8) and transport
  // `cc`      : internal parameter name → { cc, min, max, curve }
  // `program` : GM program number sent on play
  const DEVICE_PROFILES = {
    'TD-3': {
      match: [/td-?3/i], clock: false,
      cc: {
        cutoff:    { cc: 74, min: 0, max: 127, curve: 'exp' },
        resonance: { cc: 71, min: 0, max: 127, curve: 'lin' },
        envMod:    { cc: 79, min: 0, max: 127, curve: 'lin' },
        accent:    { cc: 65, min: 0, max: 127, curve: 'lin' },
        decay:     { cc: 80, min: 0, max: 127, curve: 'lin' },
      },
    },
    'Crave': {
      match: [/crave/i], clock: false,
      cc: {
        cutoff:    { cc: 74, min: 0, max: 127, curve: 'exp' },
        resonance: { cc: 71, min: 0, max: 127, curve: 'lin' },
        glide:     { cc: 5,  min: 0, max: 127, curve: 'lin' },
      },
    },
    'Edge': {
      match: [/edge/i], clock: false,
      cc: { cutoff: { cc: 74, min: 0, max: 127, curve: 'exp' } },
    },
    'Model D': {
      match: [/model\s?d/i], clock: false,
      cc: {
        cutoff:    { cc: 74, min: 0, max: 127, curve: 'exp' },
        resonance: { cc: 71, min: 0, max: 127, curve: 'lin' },
        glide:     { cc: 5,  min: 0, max: 127, curve: 'lin' },
        volume:    { cc: 7,  min: 0, max: 127, curve: 'exp' },
      },
    },
    'Neutron': {
      match: [/neutron/i], clock: false,
      cc: {
        cutoff:    { cc: 74, min: 0, max: 127, curve: 'exp' },
        resonance: { cc: 71, min: 0, max: 127, curve: 'lin' },
        drive:     { cc: 30, min: 0, max: 127, curve: 'lin' },
        oscMix:    { cc: 31, min: 0, max: 127, curve: 'lin' },
      },
    },
    'RD-6': {
      match: [/rd-?6/i], clock: true, program: 0,
    },
    'RD-8': {
      match: [/rd-?8/i], clock: true, program: 0,
    },
  };

  // GM program numbers per internal instrument type
  const GM_PROGRAMS = {
    bass: 38, lead: 81, pad: 89, acid: 38, drum: 0, synth: 81,
  };

  // ─── Request MIDI Access ────────────────────────────────────
  async function requestAccess() {
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI API not supported. Use Chrome/Edge.');
      return false;
    }
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      _scanDevices();
      midiAccess.onstatechange = (e) => {
        _scanDevices();
        log(`${e.port.type} ${e.port.name} ${e.port.state}`, 'cc');
        if (onDeviceChange) onDeviceChange(getDeviceList());
      };
      return true;
    } catch (err) {
      console.error('[MIDI] Access denied:', err);
      return false;
    }
  }

  // ─── Scan & cache devices ───────────────────────────────────
  function _scanDevices() {
    outputs.clear();
    inputs.clear();
    midiAccess.outputs.forEach(out => outputs.set(out.id, out));
    midiAccess.inputs.forEach(inp => {
      inputs.set(inp.id, inp);
      inp.onmidimessage = _handleIncoming;
    });
    // Auto-select first output if none chosen (or if the chosen one vanished)
    if ((!selectedOutputId || !outputs.has(selectedOutputId)) && outputs.size > 0) {
      selectedOutputId = [...outputs.keys()][0];
    }
  }

  // ─── Get device list for UI ─────────────────────────────────
  function getDeviceList() {
    const list = [];
    outputs.forEach((out) => {
      const profile = _matchProfile(out.name);
      list.push({
        id: out.id, name: out.name, type: 'output',
        profile: profile ? profile.key : null,
        connected: true,
        selected: out.id === selectedOutputId,
      });
    });
    inputs.forEach((inp) => {
      // Avoid duplicates when device has same name for in+out
      if (!list.find(d => d.name === inp.name)) {
        const profile = _matchProfile(inp.name);
        list.push({
          id: inp.id, name: inp.name, type: 'input',
          profile: profile ? profile.key : null,
          connected: true,
          selected: false,
        });
      }
    });
    return list;
  }

  // ─── Detect device profile ──────────────────────────────────
  function _matchProfile(name) {
    if (!name) return null;
    for (const key of Object.keys(DEVICE_PROFILES)) {
      const p = DEVICE_PROFILES[key];
      if (p.match.some(re => re.test(name))) return { key, ...p };
    }
    return null;
  }

  function getProfile(deviceName) {
    return _matchProfile(deviceName || '');
  }

  /** The profile of a specific output port, by id. */
  function getProfileForOutput(outputId) {
    const out = outputId ? outputs.get(outputId) : getSelectedOutput();
    if (!out) return null;
    return _matchProfile(out.name);
  }

  // ─── Select output device ───────────────────────────────────
  function selectOutput(id) {
    selectedOutputId = id;
    if (onDeviceChange) onDeviceChange(getDeviceList());
  }

  function getSelectedOutput() {
    return outputs.get(selectedOutputId) || [...outputs.values()][0] || null;
  }

  /** Get an output port by id (falls back to the selected output). */
  function getOutput(outputId) {
    if (outputId) return outputs.get(outputId) || null;
    return getSelectedOutput();
  }

  // ─── Safe send ──────────────────────────────────────────────
  function _send(out, bytes, when) {
    if (!out) return false;
    try {
      if (out.state && out.state !== 'connected') return false;
      if (when !== undefined && out.send.length > 1) {
        out.send(bytes, when);
      } else {
        out.send(bytes);
      }
      return true;
    } catch (e) {
      console.warn('[MIDI] send failed:', e);
      return false;
    }
  }

  // ─── Send Note On ───────────────────────────────────────────
  function noteOn(channel, note, velocity, outputId = null) {
    const out = getOutput(outputId);
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    const msg = [0x90 | ch, note & 0x7F, velocity & 0x7F];
    if (!_send(out, msg)) return;
    log(`Note On  ch${channel} ${midiToName(note)} vel${velocity}`, 'note-on');
    _flashActivity(channel, note);
  }

  // ─── Send Note Off ──────────────────────────────────────────
  function noteOff(channel, note, outputId = null) {
    const out = getOutput(outputId);
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    if (!_send(out, [0x80 | ch, note & 0x7F, 0])) return;
    log(`Note Off ch${channel} ${midiToName(note)}`, 'note-off');
  }

  /** Release every note on one channel (used by mute). */
  function noteOffChannel(channel, outputId = null) {
    const out = getOutput(outputId);
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    _send(out, [0xB0 | ch, 123, 0]); // All Notes Off
  }

  // ─── Send CC ────────────────────────────────────────────────
  function sendCC(channel, cc, value, outputId = null) {
    const out = getOutput(outputId);
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    if (!_send(out, [0xB0 | ch, cc & 0x7F, value & 0x7F])) return;
    log(`CC ch${channel} #${cc}=${value}`, 'cc');
  }

  // ─── Send Program Change ────────────────────────────────────
  function programChange(channel, program, outputId = null) {
    const out = getOutput(outputId);
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    if (_send(out, [0xC0 | ch, program & 0x7F])) {
      log(`Program ch${channel} → ${program}`, 'cc');
    }
  }

  /**
   * Push an internal parameter (0..1) to a device as a CC value,
   * using the device's own curve and range.
   */
  function pushParamToDevice(channel, paramName, value01, outputId = null) {
    const profile = getProfileForOutput(outputId);
    if (!profile || !profile.cc) return false;
    const m = profile.cc[paramName];
    if (!m) return false;
    const v = Math.max(0, Math.min(1, value01));
    const shaped = m.curve === 'exp' ? v * v : v;
    const ccValue = Math.round(m.min + shaped * (m.max - m.min));
    sendCC(channel, m.cc, ccValue, outputId);
    return true;
  }

  /**
   * Send a program change for every track according to its instrument.
   * Called when the transport starts.
   */
  function sendProgramChanges(tracks) {
    if (!tracks) return;
    tracks.forEach((track, i) => {
      const out = getOutput(track.midiOutputId);
      if (!out) return;
      const instr = window.AudioEngine ? AudioEngine.getTrackInstruments()[i]?.type : null;
      if (!instr) return;
      const program = GM_PROGRAMS[instr];
      if (program !== undefined) {
        programChange(track.midiChannel || 1, program, track.midiOutputId);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // MIDI CLOCK — derived from the AudioContext, drift-free
  // ═══════════════════════════════════════════════════════════════

  const clock = {
    running: false,
    bpm: 132,
    startTime: 0,   // AudioContext time of the first pulse
    pulsesSent: 0,
    timer: null,
    targets: [],
  };

  function _now() {
    if (window.AudioEngine) {
      const c = AudioEngine.getContext();
      if (c) return c.currentTime;
    }
    return performance.now() / 1000;
  }

  function _clockTargets() {
    const targets = [];
    outputs.forEach(out => {
      const profile = _matchProfile(out.name);
      // Unknown devices receive the clock too — a device that ignores it,
      // ignores it. Known non-clock devices (TD-3, Crave, …) are skipped.
      if (!profile || profile.clock) targets.push(out);
    });
    if (targets.length === 0) {
      const sel = getSelectedOutput();
      if (sel) targets.push(sel);
    }
    return targets;
  }

  function startClock(bpm) {
    stopClock();
    if (outputs.size === 0) return;
    // In external (slave) mode the hardware is the master — we must not
    // send a competing clock.
    if (clockSource === 'external') return;

    clock.targets = _clockTargets();
    if (clock.targets.length === 0) return;

    clock.bpm = bpm;
    clock.pulsesSent = 0;
    clock.startTime = _now() + 0.1;
    clock.running = true;

    // Transport messages to clock-capable outputs only.
    clock.targets.forEach(out => _send(out, [0xFA]));           // Start
    // Song position pointer: bar 1 = 0 (units of 6 sixteenths).
    clock.targets.forEach(out => {
      _send(out, [0xF2, 0x00, 0x00]);
    });

    clock.timer = setInterval(_clockTick, 8);
  }

  /**
   * Emit every pulse that is DUE, based on the AudioContext clock.
   * Because the pulse COUNT is derived from elapsed time, the average
   * tempo is exact over any window — there is no accumulating drift.
   */
  function _clockTick() {
    if (!clock.running) return;
    const elapsed = _now() - clock.startTime;
    if (elapsed < 0) return;
    const due = Math.floor(elapsed * (clock.bpm / 60) * 24);
    if (due <= clock.pulsesSent) return;
    // Guard against a huge catch-up burst after a stall.
    const maxBurst = 64;
    let count = Math.min(due - clock.pulsesSent, maxBurst);
    while (count-- > 0) {
      clock.pulsesSent++;
      clock.targets.forEach(out => _send(out, [0xF8])); // Clock pulse
    }
  }

  function stopClock() {
    if (clock.timer) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
    if (clock.running) {
      clock.targets.forEach(out => {
        try { _send(out, [0xFC]); } catch (e) {} // Stop
      });
    }
    clock.running = false;
    clock.pulsesSent = 0;
  }

  /**
   * Change the tempo WITHOUT restarting the transport.
   * The old implementation called startClock(), which sent Stop + Start
   * and reset the song position on every hardware slave.
   */
  function updateClockBpm(bpm) {
    if (!clock.running) return;
    const now = _now();
    const elapsed = now - clock.startTime;
    // Re-anchor so the pulse count stays continuous across the change.
    clock.startTime = now - (clock.pulsesSent / ((bpm / 60) * 24));
    clock.bpm = bpm;
    if (elapsed < 0) clock.startTime = now + 0.1;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXTERNAL (SLAVE) CLOCK
  // ═══════════════════════════════════════════════════════════════

  const ext = {
    running: false,
    pulses: 0,
    bpm: 120,
    lastPulseTime: 0,      // AudioContext time of the last pulse
    intervals: [],         // recent pulse intervals (ms), for a stable BPM
    started: false,
    stopped: false,
    continue: false,
  };

  /**
   * The AudioContext time of an incoming MIDI event.
   * `e.timeStamp` is on the performance timeline, so we can convert it
   * to the audio timeline and know exactly when the pulse happened —
   * not when the scheduler happened to notice it.
   */
  function _eventAudioTime(e) {
    const ctx = window.AudioEngine ? AudioEngine.getContext() : null;
    const nowPerf = performance.now();
    const delta = (typeof e.timeStamp === 'number' && e.timeStamp > 0)
      ? (e.timeStamp - nowPerf) / 1000
      : 0;
    if (ctx) return ctx.currentTime + delta;
    return nowPerf / 1000 + delta;
  }

  function getExternalClock() {
    return {
      running: ext.running,
      pulses: ext.pulses,
      bpm: ext.bpm,
      lastPulseTime: ext.lastPulseTime,
      pulseDuration: ext.bpm > 0 ? (60 / ext.bpm / 24) : 0,
    };
  }

  function _handleExternalClock(e) {
    const nowPerf = performance.now();
    if (ext.lastPulseTime > 0) {
      const dt = nowPerf - ext.lastPulseTime;
      ext.intervals.push(dt);
      if (ext.intervals.length > 48) ext.intervals.shift();
      // 24 pulses per quarter note
      const avg = ext.intervals.reduce((a, b) => a + b, 0) / ext.intervals.length;
      if (avg > 0) ext.bpm = Math.max(20, Math.min(300, 60000 / avg / 24));
    }
    ext.lastPulseTime = _eventAudioTime(e);
    ext.pulses++;
    ext.running = true;
    if (onExternalClock) onExternalClock(getExternalClock());
  }

  function resetExternalClock() {
    ext.pulses = 0;
    ext.lastPulseTime = 0;
    ext.intervals = [];
  }

  // ─── Clock source: internal (master) or external (slave) ──────
  let clockSource = 'internal';

  function setClockSource(src) {
    clockSource = (src === 'external') ? 'external' : 'internal';
    if (clockSource === 'external') {
      // Stop sending our own clock — the hardware is the master now.
      stopClock();
      resetExternalClock();
    }
    if (onClockSourceChange) onClockSourceChange(clockSource);
  }

  function getClockSource() { return clockSource; }
  let onClockSourceChange = null;
  function setClockSourceCallback(fn) { onClockSourceChange = fn; }

  // ─── All Notes Off ──────────────────────────────────────────
  function allNotesOff() {
    outputs.forEach(out => {
      for (let ch = 0; ch < 16; ch++) {
        _send(out, [0xB0 | ch, 123, 0]); // All Notes Off CC 123
      }
    });
  }

  // ─── Handle Incoming MIDI ───────────────────────────────────
  function _handleIncoming(e) {
    const [status, note, velocity] = e.data;
    const type = status & 0xF0;
    const ch   = (status & 0x0F) + 1;

    // System real-time messages (0xF8 clock, 0xFA start, 0xFB continue,
    // 0xFC stop) arrive as status bytes with no data.
    if (status >= 0xF8) {
      if (status === 0xF8) {
        _handleExternalClock(e);
        log('In: Clock', 'clock');
      } else if (status === 0xFA) {
        log('In: Start', 'clock');
        ext.running = true;
        ext.started = true;
        ext.stopped = false;
        resetExternalClock();
        if (onExternalClock) onExternalClock({ ...getExternalClock(), running: true, start: true });
      } else if (status === 0xFB) {
        log('In: Continue', 'clock');
        ext.continue = true;
        ext.running = true;
        if (onExternalClock) onExternalClock({ ...getExternalClock(), running: true, cont: true });
      } else if (status === 0xFC) {
        log('In: Stop', 'clock');
        ext.running = false;
        ext.stopped = true;
        if (onExternalClock) onExternalClock({ ...getExternalClock(), running: false, stop: true });
      }
      return;
    }

    if (type === 0x90 && velocity > 0) {
      log(`In: Note On  ch${ch} ${midiToName(note)} vel${velocity}`, 'note-on');
      if (onMessage) onMessage({ type: 'noteon', channel: ch, note, velocity });
    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      log(`In: Note Off ch${ch} ${midiToName(note)}`, 'note-off');
      if (onMessage) onMessage({ type: 'noteoff', channel: ch, note });
    } else if (type === 0xB0) {
      log(`In: CC ch${ch} #${note}=${velocity}`, 'cc');
      if (onMessage) onMessage({ type: 'cc', channel: ch, cc: note, value: velocity });
      // MIDI Learn gets first refusal on every CC.
      if (window.MidiLearn && MidiLearn.handleCC(ch, note, velocity)) {
        if (onCcActivity) onCcActivity(ch, note, velocity);
        return;
      }
      if (onCcActivity) onCcActivity(ch, note, velocity);
    } else if (type === 0xC0) {
      log(`In: Program ch${ch} → ${note}`, 'cc');
      if (onMessage) onMessage({ type: 'program', channel: ch, program: note });
    } else if (type === 0xE0) {
      log(`In: Pitch Bend ch${ch}`, 'cc');
      if (onMessage) onMessage({ type: 'bend', channel: ch, value: (velocity << 7) | note });
    }
  }

  // ─── Activity flash callback ─────────────────────────────────
  let activityCallback = null;
  function setActivityCallback(fn) { activityCallback = fn; }
  function _flashActivity(channel, note) {
    if (activityCallback) activityCallback(channel, note);
  }

  // ─── MIDI Monitor Log ────────────────────────────────────────
  const LOG_MAX = 80;
  let logEntries = [];
  let logEl = null;

  function setLogElement(el) { logEl = el; }

  function log(msg, type = 'default') {
    if (!logEl) return;
    // Skip MIDI clock spam
    if (type === 'clock' && !logEntries.length) return;

    const time = new Date().toLocaleTimeString('en', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const entry = document.createElement('div');
    entry.className = `monitor-entry monitor-${type}`;
    entry.innerHTML = `<span class="monitor-time">${time}</span><span>${escHtml(msg)}</span>`;
    logEl.appendChild(entry);

    logEntries.push(entry);
    if (logEntries.length > LOG_MAX) {
      logEntries.shift().remove();
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearLog() {
    if (logEl) logEl.innerHTML = '';
    logEntries = [];
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ─── Setters for callbacks ───────────────────────────────────
  function setDeviceChangeCallback(fn) { onDeviceChange = fn; }
  function setMessageCallback(fn) { onMessage = fn; }
  function setExternalClockCallback(fn) { onExternalClock = fn; }
  function setCcActivityCallback(fn) { onCcActivity = fn; }
  function setClockSourceCallback(fn) { onClockSourceChange = fn; }

  function isConnected() { return midiAccess !== null && outputs.size > 0; }

  /** Persist the user's output choice across reloads. */
  const LS_OUTPUT_KEY = 'musicbox_midi_output';
  function saveSelectedOutput() {
    try { localStorage.setItem(LS_OUTPUT_KEY, selectedOutputId || ''); } catch (e) {}
  }
  function restoreSelectedOutput() {
    try {
      const saved = localStorage.getItem(LS_OUTPUT_KEY);
      if (saved && outputs.has(saved)) selectedOutputId = saved;
    } catch (e) {}
  }

  return {
    requestAccess,
    getDeviceList,
    getProfile,
    getProfileForOutput,
    selectOutput,
    getSelectedOutput,
    getOutput,
    noteOn,
    noteOff,
    noteOffChannel,
    sendCC,
    programChange,
    pushParamToDevice,
    sendProgramChanges,
    startClock,
    stopClock,
    updateClockBpm,
    getExternalClock,
    setClockSource,
    getClockSource,
    setClockSourceCallback,
    setCcActivityCallback,
    allNotesOff,
    setLogElement,
    clearLog,
    setDeviceChangeCallback,
    setMessageCallback,
    setExternalClockCallback,
    setActivityCallback,
    isConnected,
    saveSelectedOutput,
    restoreSelectedOutput,
    outputs,
    inputs,
  };

})();

window.MidiManager = MidiManager;
