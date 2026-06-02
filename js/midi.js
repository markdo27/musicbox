/**
 * midi.js — Web MIDI API Manager
 * Handles device detection, connection, sending/receiving messages,
 * MIDI clock output, and the MIDI monitor log.
 */

const MidiManager = (() => {

  // ─── State ──────────────────────────────────────────────────
  let midiAccess = null;
  let outputs = new Map();   // id → MIDIOutput
  let inputs  = new Map();   // id → MIDIInput
  let selectedOutputId = null;
  let clockInterval = null;
  let clockRunning = false;
  let onDeviceChange = null; // callback → UI refresh
  let onMessage = null;      // callback → monitor

  // Behringer / Roland device CC profiles
  // clock:true = device accepts MIDI clock sync
  const DEVICE_PROFILES = {
    'RD-6':    { clock: true,  tempo: 0 },                                          // ← NEW
    'RD-8':    { clock: true,  tempo: 0 },
    'TD-3':    { clock: false, cutoff: 74, resonance: 71, envMod: 79, accent: 65, decay: 80 },
    'Crave':   { clock: false, cutoff: 74, resonance: 71, glide: 5 },
    'Edge':    { clock: false, cutoff: 74 },                                         // ← NEW
    'Model D': { clock: false, cutoff: 74, resonance: 71, glide: 5, volume: 7 },
    'Neutron': { clock: false, cutoff: 74, resonance: 71, drive: 30, osc_mix: 31 },
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
    // Auto-select first output if none chosen
    if (!selectedOutputId && outputs.size > 0) {
      selectedOutputId = [...outputs.keys()][0];
    }
  }

  // ─── Get device list for UI ─────────────────────────────────
  function getDeviceList() {
    const list = [];
    outputs.forEach((out) => {
      list.push({ id: out.id, name: out.name, type: 'output', profile: _matchProfile(out.name), connected: true });
    });
    inputs.forEach((inp) => {
      // Avoid duplicates when device has same name for in+out
      if (!list.find(d => d.name === inp.name)) {
        list.push({ id: inp.id, name: inp.name, type: 'input', profile: _matchProfile(inp.name), connected: true });
      }
    });
    return list;
  }

  // ─── Detect Behringer profile ───────────────────────────────
  function _matchProfile(name) {
    for (const key of Object.keys(DEVICE_PROFILES)) {
      if (name.toLowerCase().includes(key.toLowerCase())) return key;
    }
    return null;
  }

  function getProfile(deviceName) {
    const key = _matchProfile(deviceName || '');
    return key ? DEVICE_PROFILES[key] : null;
  }

  // ─── Select output device ───────────────────────────────────
  function selectOutput(id) {
    selectedOutputId = id;
  }

  function getSelectedOutput() {
    return outputs.get(selectedOutputId) || [...outputs.values()][0] || null;
  }

  // ─── Send Note On ───────────────────────────────────────────
  function noteOn(channel, note, velocity, outputId = null) {
    const out = outputId ? outputs.get(outputId) : getSelectedOutput();
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    const msg = [0x90 | ch, note & 0x7F, velocity & 0x7F];
    out.send(msg);
    log(`Note On  ch${channel} ${midiToName(note)} vel${velocity}`, 'note-on');
    _flashActivity(channel, note);
  }

  // ─── Send Note Off ──────────────────────────────────────────
  function noteOff(channel, note, outputId = null) {
    const out = outputId ? outputs.get(outputId) : getSelectedOutput();
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    out.send([0x80 | ch, note & 0x7F, 0]);
    log(`Note Off ch${channel} ${midiToName(note)}`, 'note-off');
  }

  // ─── Send CC ────────────────────────────────────────────────
  function sendCC(channel, cc, value, outputId = null) {
    const out = outputId ? outputs.get(outputId) : getSelectedOutput();
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    out.send([0xB0 | ch, cc & 0x7F, value & 0x7F]);
    log(`CC ch${channel} #${cc}=${value}`, 'cc');
  }

  // ─── Send Program Change ────────────────────────────────────
  function programChange(channel, program, outputId = null) {
    const out = outputId ? outputs.get(outputId) : getSelectedOutput();
    if (!out) return;
    const ch = Math.max(0, Math.min(15, channel - 1));
    out.send([0xC0 | ch, program & 0x7F]);
  }

  // ─── MIDI Clock ─────────────────────────────────────────────
  // 24 pulses per quarter note
  // Broadcasts to ALL outputs with clock:true profile, or ALL if none have a profile
  function startClock(bpm) {
    stopClock();
    if (outputs.size === 0) return;

    // Determine which outputs receive clock
    const clockOutputs = [];
    outputs.forEach(out => {
      const profileKey = _matchProfile(out.name);
      const profile = profileKey ? DEVICE_PROFILES[profileKey] : null;
      // Send to: devices with clock:true, or all devices if no profiles matched
      if (!profile || profile.clock) clockOutputs.push(out);
    });
    // Fallback: if no clock-capable device found, send to selected output
    if (clockOutputs.length === 0) {
      const sel = getSelectedOutput();
      if (sel) clockOutputs.push(sel);
    }

    // Send Start message to all clock outputs
    clockOutputs.forEach(out => out.send([0xFA]));

    const intervalMs = (60000 / bpm) / 24;
    clockRunning = true;

    function tick() {
      if (!clockRunning) return;
      clockOutputs.forEach(out => {
        try { out.send([0xF8]); } catch(e) {} // Clock pulse
      });
    }

    clockInterval = setInterval(tick, intervalMs);
  }

  function stopClock() {
    if (clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
    if (clockRunning) {
      // Broadcast Stop to all outputs
      outputs.forEach(out => {
        try { out.send([0xFC]); } catch(e) {}; // Stop
      });
    }
    clockRunning = false;
  }

  function updateClockBpm(bpm) {
    if (clockRunning) startClock(bpm);
  }

  // ─── All Notes Off ──────────────────────────────────────────
  function allNotesOff() {
    outputs.forEach(out => {
      for (let ch = 0; ch < 16; ch++) {
        out.send([0xB0 | ch, 123, 0]); // All Notes Off CC 123
      }
    });
  }

  // ─── Handle Incoming MIDI ───────────────────────────────────
  function _handleIncoming(e) {
    const [status, note, velocity] = e.data;
    const type = status & 0xF0;
    const ch   = (status & 0x0F) + 1;

    if (type === 0x90 && velocity > 0) {
      log(`In: Note On  ch${ch} ${midiToName(note)} vel${velocity}`, 'note-on');
      if (onMessage) onMessage({ type: 'noteon', channel: ch, note, velocity });
    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      log(`In: Note Off ch${ch} ${midiToName(note)}`, 'note-off');
      if (onMessage) onMessage({ type: 'noteoff', channel: ch, note });
    } else if (type === 0xB0) {
      log(`In: CC ch${ch} #${note}=${velocity}`, 'cc');
      if (onMessage) onMessage({ type: 'cc', channel: ch, cc: note, value: velocity });
    }
  }

  // ─── Activity flash callback ─────────────────────────────────
  let activityCallback = null;
  function setActivityCallback(fn) { activityCallback = fn; }
  function _flashActivity(channel, note) {
    if (activityCallback) activityCallback(channel, note);
  }

  // ─── MIDI Monitor Log ────────────────────────────────────────
  const LOG_MAX = 60;
  let logEntries = [];
  let logEl = null;

  function setLogElement(el) { logEl = el; }

  function log(msg, type = 'default') {
    if (!logEl) return;
    // Skip MIDI clock spam
    if (type === 'clock') return;

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
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ─── Setters for callbacks ───────────────────────────────────
  function setDeviceChangeCallback(fn) { onDeviceChange = fn; }
  function setMessageCallback(fn) { onMessage = fn; }

  function isConnected() { return midiAccess !== null && outputs.size > 0; }

  return {
    requestAccess,
    getDeviceList,
    getProfile,
    selectOutput,
    getSelectedOutput,
    noteOn,
    noteOff,
    sendCC,
    programChange,
    startClock,
    stopClock,
    updateClockBpm,
    allNotesOff,
    setLogElement,
    clearLog,
    setDeviceChangeCallback,
    setMessageCallback,
    setActivityCallback,
    isConnected,
    outputs,
    inputs,
  };

})();

window.MidiManager = MidiManager;
