/**
 * ui.js — UI Rendering & Interaction
 * Builds the sequencer grid, track rows, mixer, MIDI device panel,
 * keyboard visualizer, note picker modal, and handles all DOM events.
 */

const UI = (() => {

  // Track colors (CSS variable references)
  const TRACK_COLORS = [
    { css: 'var(--track-1)', rgb: '0,212,255',   cls: 'track-color-1' },
    { css: 'var(--track-2)', rgb: '0,255,136',   cls: 'track-color-2' },
    { css: 'var(--track-3)', rgb: '255,170,0',   cls: 'track-color-3' },
    { css: 'var(--track-4)', rgb: '192,132,252',  cls: 'track-color-4' },
    { css: 'var(--track-5)', rgb: '255,110,180', cls: 'track-color-5' },
    { css: 'var(--track-6)', rgb: '255,122,26',  cls: 'track-color-6' },
    { css: 'var(--track-7)', rgb: '125,243,225', cls: 'track-color-7' },
    { css: 'var(--track-8)', rgb: '167,139,250', cls: 'track-color-8' },
  ];

  const NOTE_NAMES_DISPLAY = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const SHARP_NOTES = new Set([1,3,6,8,10]); // C#, D#, F#, G#, A#

  let currentStepBeingEdited = null; // { trackIdx, stepIdx }
  let _selectedNoteInPicker = 0;
  let _pickerOctave = 4;

  // ─── Render genre preset buttons ────────────────────────────
  function renderPresets() {
    const grid = document.getElementById('preset-grid');
    grid.innerHTML = '';
    Object.values(PRESETS).forEach(preset => {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.id = `preset-btn-${preset.id}`;
      btn.style.setProperty('--preset-color', preset.color);
      btn.style.setProperty('--preset-color-rgb', preset.colorRgb);
      btn.innerHTML = `
        <span class="preset-icon">${preset.icon}</span>
        <span class="preset-name">${preset.name}</span>
        <span class="preset-bpm">${preset.bpm} BPM</span>
      `;
      btn.title = preset.description;
      btn.addEventListener('click', () => _applyPreset(preset.id));
      grid.appendChild(btn);
    });
  }

  function _applyPreset(presetId) {
    // Highlight active preset
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`preset-btn-${presetId}`);
    if (btn) btn.classList.add('active');

    Sequencer.applyPreset(presetId);

    // Update BPM display
    const preset = PRESETS[presetId];
    document.getElementById('bpm-value').value = preset.bpm;
    document.getElementById('swing-slider').value = preset.swing;
    document.getElementById('swing-value').textContent = preset.swing + '%';

    showToast(`Loaded: ${preset.name}`, 'info');
  }

  // ─── Render full sequencer (called on state change) ────────────
  function renderSequencer(state) {
    renderStepIndicators(state.stepCount);
    renderTracks(state);
    renderMixer(state.tracks);
    // Clear step editor panel so stale data doesn't show after preset/randomize
    if (currentStepBeingEdited) {
      const content = document.getElementById('step-editor-content');
      if (content) content.innerHTML = '<p class="hint-text">Click a step to edit</p>';
      currentStepBeingEdited = null;
    }
  }

  // ─── Step indicator row ───────────────────────────────────────
  function renderStepIndicators(stepCount) {
    const row = document.getElementById('step-indicator-row');
    row.innerHTML = '';
    for (let i = 0; i < stepCount; i++) {
      const el = document.createElement('div');
      el.className = 'step-indicator' + (i % 4 === 0 ? ' bar-start' : '');
      el.id = `step-ind-${i}`;
      el.textContent = i % 4 === 0 ? (i / 4 + 1) : '';
      row.appendChild(el);
    }
  }

  // ─── Update playhead position ─────────────────────────────────
  function updatePlayhead(step) {
    // Clear old playhead
    document.querySelectorAll('.step-btn.playhead-active').forEach(el => {
      el.classList.remove('playhead-active');
    });
    document.querySelectorAll('.step-indicator.playhead').forEach(el => {
      el.classList.remove('playhead');
    });

    if (step < 0) return;

    // Light up playhead column
    document.querySelectorAll(`.step-btn[data-step="${step}"]`).forEach(el => {
      el.classList.add('playhead-active');
    });
    const ind = document.getElementById(`step-ind-${step}`);
    if (ind) ind.classList.add('playhead');
  }

  // ─── Render all tracks ────────────────────────────────────────
  function renderTracks(state) {
    const container = document.getElementById('track-list');
    const existingCount = container.children.length;
    const stepCount = state.stepCount;

    state.tracks.forEach((track, trackIdx) => {
      const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
      let row = document.getElementById(`track-row-${trackIdx}`);

      if (!row) {
        row = _createTrackRow(trackIdx, track, color, stepCount);
        container.appendChild(row);
      } else {
        // Update track state classes
        row.classList.toggle('muted', track.muted);
        row.classList.toggle('soloed', track.soloed);
      }

      // Update steps
      const stepsGrid = row.querySelector('.steps-grid');
      _renderSteps(stepsGrid, track, trackIdx, stepCount, color);
    });

    // Remove extra rows
    while (container.children.length > state.tracks.length) {
      container.lastChild.remove();
    }
  }

  function _createTrackRow(trackIdx, track, color, stepCount) {
    const row = document.createElement('div');
    row.className = `track-row track-color-${trackIdx + 1}`;
    row.id = `track-row-${trackIdx}`;
    row.classList.toggle('muted', track.muted);

    // Build MIDI channel options
    const chOptions = Array.from({length: 16}, (_, i) =>
      `<option value="${i+1}" ${track.midiChannel === i+1 ? 'selected' : ''}>${i+1}</option>`
    ).join('');

    row.innerHTML = `
      <div class="track-header">
        <div class="track-color-bar" style="background:${color.css}; box-shadow: 0 0 8px ${color.css}33;"></div>
        <div class="track-info">
          <div class="track-name" id="track-name-${trackIdx}" contenteditable="true" spellcheck="false">${escHtml(track.name)}</div>
          <div class="track-meta">
            Ch: <select class="track-ch-select" id="track-ch-${trackIdx}">${chOptions}</select>
          </div>
        </div>
        <div class="track-controls">
          <div class="track-activity" id="track-activity-${trackIdx}" style="--track-color:${color.css}"></div>
          <button class="track-btn mute-btn ${track.muted ? 'active' : ''}" id="mute-btn-${trackIdx}" title="Mute">M</button>
          <button class="track-btn solo-btn ${track.soloed ? 'active' : ''}" id="solo-btn-${trackIdx}" title="Solo">S</button>
        </div>
      </div>
      <div class="steps-grid" id="steps-grid-${trackIdx}"></div>
    `;

    // Events: track name edit
    const nameEl = row.querySelector(`#track-name-${trackIdx}`);
    nameEl.addEventListener('blur', () => {
      Sequencer.setTrackProperty(trackIdx, 'name', nameEl.textContent.trim() || `Track ${trackIdx+1}`);
      // Update mixer
      const mixerName = document.getElementById(`mixer-name-${trackIdx}`);
      if (mixerName) mixerName.textContent = nameEl.textContent.trim();
    });
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

    // MIDI channel select
    row.querySelector(`#track-ch-${trackIdx}`).addEventListener('change', e => {
      Sequencer.setTrackProperty(trackIdx, 'midiChannel', parseInt(e.target.value));
    });

    // Mute button
    row.querySelector(`#mute-btn-${trackIdx}`).addEventListener('click', () => {
      Sequencer.toggleMute(trackIdx);
      const st = Sequencer.getState().tracks[trackIdx];
      row.classList.toggle('muted', st.muted);
      row.querySelector(`#mute-btn-${trackIdx}`).classList.toggle('active', st.muted);
    });

    // Solo button
    row.querySelector(`#solo-btn-${trackIdx}`).addEventListener('click', () => {
      Sequencer.toggleSolo(trackIdx);
      Sequencer.getState().tracks.forEach((t, i) => {
        const muteBtn = document.getElementById(`mute-btn-${i}`);
        const soloBtn = document.getElementById(`solo-btn-${i}`);
        const tr = document.getElementById(`track-row-${i}`);
        if (muteBtn) muteBtn.classList.toggle('active', t.muted && !t.soloed);
        if (soloBtn) soloBtn.classList.toggle('active', t.soloed);
        if (tr)      tr.classList.toggle('muted', t.muted);
      });
    });

    return row;
  }

  function _renderSteps(grid, track, trackIdx, stepCount, color) {
    // Add or update step buttons
    for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
      let btn = document.getElementById(`step-${trackIdx}-${stepIdx}`);
      const step = track.steps[stepIdx];

      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'step-btn';
        btn.id = `step-${trackIdx}-${stepIdx}`;
        btn.dataset.track = trackIdx;
        btn.dataset.step = stepIdx;
        btn.innerHTML = `
          <span class="step-note-label"></span>
          <span class="step-prob-dot"></span>
        `;

        btn.addEventListener('click', (e) => {
          if (e.shiftKey || e.altKey) {
            _openStepEditor(trackIdx, stepIdx);
          } else {
            Sequencer.toggleStep(trackIdx, stepIdx);
            _updateStepBtn(btn, Sequencer.getStep(trackIdx, stepIdx), color);
          }
        });

        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          _openStepEditor(trackIdx, stepIdx);
        });

        grid.appendChild(btn);
      }

      _updateStepBtn(btn, step, color);
    }

    // Remove extra buttons
    while (grid.children.length > stepCount) grid.lastChild.remove();
  }

  function _updateStepBtn(btn, step, color) {
    if (!step) return;
    btn.classList.toggle('active', step.active);
    btn.classList.toggle('has-prob', step.active && step.probability < 100);

    const velPct = step.active ? Math.round((step.velocity / 127) * 100) : 0;
    btn.style.setProperty('--vel-bar', velPct + '%');

    const noteLabel = btn.querySelector('.step-note-label');
    if (noteLabel) {
      noteLabel.textContent = step.active ? midiToName(step.note) : '';
    }
  }

  // ─── Step Editor sidebar panel ────────────────────────────────
  function _openStepEditor(trackIdx, stepIdx) {
    currentStepBeingEdited = { trackIdx, stepIdx };
    const step = Sequencer.getStep(trackIdx, stepIdx);
    const track = Sequencer.getState().tracks[trackIdx];
    const content = document.getElementById('step-editor-content');

    const noteName = midiToName(step.note || 60);
    content.innerHTML = `
      <div class="se-row">
        <span class="se-label">Track</span>
        <span class="se-value">${escHtml(track.name)}</span>
      </div>
      <div class="se-row">
        <span class="se-label">Step</span>
        <span class="se-value">${stepIdx + 1}</span>
      </div>
      <div class="se-row">
        <span class="se-label">Note</span>
        <select class="se-select" id="se-note-select">${_buildNoteOptions(step.note)}</select>
      </div>
      <div class="se-row">
        <span class="se-label">Velocity</span>
        <input type="range" class="se-slider" id="se-velocity" min="1" max="127" value="${step.velocity}" />
        <span class="se-value" id="se-vel-val">${step.velocity}</span>
      </div>
      <div class="se-row">
        <span class="se-label">Gate</span>
        <select class="se-select" id="se-gate">
          ${[0.1,0.25,0.5,0.75,1.0].map(g =>
            `<option value="${g}" ${step.gate === g ? 'selected' : ''}>${Math.round(g*100)}%</option>`
          ).join('')}
        </select>
      </div>
      <div class="se-row">
        <span class="se-label">Prob %</span>
        <input type="range" class="se-slider" id="se-prob" min="0" max="100" value="${step.probability}" />
        <span class="se-value" id="se-prob-val">${step.probability}%</span>
      </div>
      <div class="se-row">
        <button class="btn-secondary" id="se-toggle-active" style="flex:1">
          ${step.active ? '🔴 Deactivate' : '🟢 Activate'}
        </button>
      </div>
    `;

    // Bind events
    document.getElementById('se-velocity').addEventListener('input', e => {
      document.getElementById('se-vel-val').textContent = e.target.value;
      _applyStepEdit({ velocity: parseInt(e.target.value) });
    });
    document.getElementById('se-prob').addEventListener('input', e => {
      document.getElementById('se-prob-val').textContent = e.target.value + '%';
      _applyStepEdit({ probability: parseInt(e.target.value) });
    });
    document.getElementById('se-note-select').addEventListener('change', e => {
      _applyStepEdit({ note: parseInt(e.target.value) });
    });
    document.getElementById('se-gate').addEventListener('change', e => {
      _applyStepEdit({ gate: parseFloat(e.target.value) });
    });
    document.getElementById('se-toggle-active').addEventListener('click', () => {
      Sequencer.toggleStep(trackIdx, stepIdx);
      _openStepEditor(trackIdx, stepIdx); // re-render
      _refreshStepBtn(trackIdx, stepIdx);
    });
  }

  function _buildNoteOptions(selectedNote) {
    const options = [];
    for (let octave = -1; octave <= 8; octave++) {
      NOTE_NAMES_DISPLAY.forEach((name, noteIdx) => {
        const midi = (octave + 1) * 12 + noteIdx;
        if (midi < 0 || midi > 127) return;
        const label = name + octave;
        options.push(`<option value="${midi}" ${midi === selectedNote ? 'selected' : ''}>${label}</option>`);
      });
    }
    return options.join('');
  }

  function _applyStepEdit(data) {
    if (!currentStepBeingEdited) return;
    const { trackIdx, stepIdx } = currentStepBeingEdited;
    Sequencer.setStepData(trackIdx, stepIdx, data);
    _refreshStepBtn(trackIdx, stepIdx);
  }

  function _refreshStepBtn(trackIdx, stepIdx) {
    const btn = document.getElementById(`step-${trackIdx}-${stepIdx}`);
    if (!btn) return;
    const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
    _updateStepBtn(btn, Sequencer.getStep(trackIdx, stepIdx), color);
  }

  // ─── Mixer ─────────────────────────────────────────────────────
  function renderMixer(tracks) {
    const container = document.getElementById('mixer-tracks');
    container.innerHTML = '';
    tracks.forEach((track, i) => {
      const color = TRACK_COLORS[i % TRACK_COLORS.length];
      const div = document.createElement('div');
      div.className = 'mixer-track';
      div.innerHTML = `
        <div class="mixer-color-dot" style="background:${color.css}; box-shadow: 0 0 6px ${color.css}66;"></div>
        <span class="mixer-track-name" id="mixer-name-${i}">${escHtml(track.name)}</span>
        <div class="mixer-fader-wrap">
          <input type="range" class="mixer-fader" id="mixer-vol-${i}" min="0" max="100" value="${track.volume}"
            title="Volume: ${track.volume}%" />
          <div class="mixer-vu" id="mixer-vu-${i}"></div>
        </div>
        <span class="mixer-vol-val" id="mixer-vol-val-${i}">${track.volume}</span>
      `;
      div.querySelector(`#mixer-vol-${i}`).addEventListener('input', e => {
        const val = parseInt(e.target.value);
        Sequencer.setTrackProperty(i, 'volume', val);
        document.getElementById(`mixer-vol-val-${i}`).textContent = val;
        // Real-time Web Audio volume control
        if (window.AudioEngine) AudioEngine.setTrackVolume(i, val / 100);
      });
      container.appendChild(div);
    });
  }

  // ─── MIDI Device Panel ────────────────────────────────────────
  function renderDevices(deviceList) {
    const list = document.getElementById('device-list');
    const noMsg = document.getElementById('no-devices-msg');
    const dot = document.getElementById('midi-dot');
    const statusText = document.getElementById('midi-status-text');

    if (deviceList.length === 0) {
      list.innerHTML = '';
      list.appendChild(noMsg);
      noMsg.style.display = '';
      dot.classList.remove('connected');
      statusText.textContent = 'No MIDI';
      return;
    }

    noMsg.style.display = 'none';
    list.innerHTML = '';
    dot.classList.add('connected');
    statusText.textContent = `${deviceList.length} device${deviceList.length !== 1 ? 's' : ''}`;

    deviceList.forEach(device => {
      const item = document.createElement('div');
      item.className = 'device-item';
      const profile = device.profile ? `(${device.profile})` : '';
      item.innerHTML = `
        <span class="device-icon">${device.type === 'output' ? '📤' : '📥'}</span>
        <div class="device-info">
          <div class="device-name" title="${escHtml(device.name)}">${escHtml(device.name)} ${profile}</div>
          <div class="device-type">${device.type}</div>
        </div>
        ${device.type === 'output' ? `<select class="device-ch-select" title="MIDI Ch">
          ${Array.from({length:16},(_,i)=>`<option value="${i+1}">Ch${i+1}</option>`).join('')}
        </select>` : ''}
      `;
      list.appendChild(item);
    });
  }

  // ─── Piano keyboard visualizer ────────────────────────────────
  function renderKeyboard() {
    const wrap = document.getElementById('keyboard-wrap');
    wrap.innerHTML = '';

    // Render 2 octaves (C3 to B4) = 24 keys
    const startOctave = 3;
    const octaves = 2;
    const whites = [];
    const blacks = [];

    let whiteIdx = 0;
    for (let o = 0; o < octaves; o++) {
      NOTE_NAMES_DISPLAY.forEach((name, noteIdx) => {
        const midi = (startOctave + o + 1) * 12 + noteIdx;
        if (SHARP_NOTES.has(noteIdx)) {
          blacks.push({ midi, whiteIdx: whiteIdx - 0.5, name: name + (startOctave + o) });
        } else {
          whites.push({ midi, whiteIdx, name: name + (startOctave + o) });
          whiteIdx++;
        }
      });
    }

    const totalWhites = whites.length;
    const keyWidthPct = 100 / totalWhites;

    function _playKey(midi) {
      if (window.AudioEngine) {
        AudioEngine.init();
        AudioEngine.triggerNote(-1, 1, midi, 90, 0.4);
      }
    }

    // White keys
    whites.forEach(k => {
      const el = document.createElement('div');
      el.className = 'key white-key';
      el.id = `key-${k.midi}`;
      el.style.width = keyWidthPct + '%';
      el.title = k.name;
      // Playable
      el.addEventListener('mousedown', () => _playKey(k.midi));
      el.addEventListener('touchstart', (e) => { e.preventDefault(); _playKey(k.midi); }, { passive: false });
      wrap.appendChild(el);
    });

    // Black keys (overlaid)
    blacks.forEach(k => {
      const el = document.createElement('div');
      el.className = 'key black-key';
      el.id = `key-${k.midi}`;
      el.style.left = (k.whiteIdx * keyWidthPct + keyWidthPct * 0.6) + '%';
      el.title = k.name;
      // Playable
      el.addEventListener('mousedown', (e) => { e.stopPropagation(); _playKey(k.midi); });
      el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); _playKey(k.midi); }, { passive: false });
      wrap.appendChild(el);
    });
  }

  function flashKey(note) {
    const key = document.getElementById(`key-${note}`);
    if (!key) return;
    key.classList.add('active-key');
    setTimeout(() => key.classList.remove('active-key'), 150);
  }

  // ─── Track activity flash ─────────────────────────────────────
  function flashTrackActivity(trackIdx) {
    const el = document.getElementById(`track-activity-${trackIdx}`);
    if (el) {
      el.classList.add('active');
      setTimeout(() => el.classList.remove('active'), 120);
    }
    // Also flash the VU meter in the mixer
    const vu = document.getElementById(`mixer-vu-${trackIdx}`);
    if (vu) {
      vu.classList.add('vu-active');
      setTimeout(() => vu.classList.remove('vu-active'), 150);
    }
  }

  // ─── Toast notification ───────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast ${type}`;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ─── Note picker modal ────────────────────────────────────────
  function openNotePicker(trackIdx, stepIdx) {
    currentStepBeingEdited = { trackIdx, stepIdx };
    const step = Sequencer.getStep(trackIdx, stepIdx);
    const modal = document.getElementById('modal-note-picker');

    // Build note grid (1 octave, 12 notes)
    const grid = document.getElementById('note-picker-grid');
    grid.innerHTML = '';
    NOTE_NAMES_DISPLAY.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'note-picker-btn' + (SHARP_NOTES.has(i) ? ' sharp' : '');
      btn.textContent = name;
      btn.dataset.noteIdx = i;
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.note-picker-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        _selectedNoteInPicker = i;
      });
      grid.appendChild(btn);
    });

    // Set initial note state
    _pickerOctave = Math.floor((step.note || 60) / 12) - 1;
    _selectedNoteInPicker = (step.note || 60) % 12;

    // Highlight current note
    grid.children[_selectedNoteInPicker]?.classList.add('selected');

    // Sync octave selector
    const octSel = document.getElementById('sp-octave');
    if (octSel) octSel.value = String(_pickerOctave);

    // Set initial values
    document.getElementById('sp-velocity').value = step.velocity || 100;
    document.getElementById('sp-velocity-val').textContent = step.velocity || 100;
    document.getElementById('sp-gate').value = step.gate || 0.5;
    document.getElementById('sp-probability').value = step.probability || 100;
    document.getElementById('sp-probability-val').textContent = (step.probability || 100) + '%';

    modal.hidden = false;
  }

  function closeNotePicker() {
    document.getElementById('modal-note-picker').hidden = true;
    currentStepBeingEdited = null;
  }

  // ─── Instrument Panel ─────────────────────────────────────────
  const INSTRUMENT_TYPES = [
    { id: 'drum',  label: 'Drum',  icon: '🥁', desc: 'Kick/Snare/HH synthesis' },
    { id: 'bass',  label: 'Bass',  icon: '🎸', desc: 'Saw+Sub synth, fat filter' },
    { id: 'lead',  label: 'Lead',  icon: '🎹', desc: 'Square/Saw, bright filter' },
    { id: 'pad',   label: 'Pad',   icon: '🌊', desc: '5-voice detuned pad, slow attack' },
  ];

  function renderInstruments() {
    const container = document.getElementById('instrument-list');
    if (!container || !window.AudioEngine) return;
    container.innerHTML = '';
    const instrs = AudioEngine.getTrackInstruments();
    instrs.forEach((instr, trackIdx) => {
      const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
      const trackName = Sequencer.getState().tracks[trackIdx]?.name || `Track ${trackIdx+1}`;
      const row = document.createElement('div');
      row.className = 'instr-row';
      row.id = `instr-row-${trackIdx}`;

      let options = `<optgroup label="Internal Synths">`;
      options += INSTRUMENT_TYPES.map(t =>
        `<option value="${t.id}" ${instr.type === t.id ? 'selected' : ''}>${t.icon} ${t.label}</option>`
      ).join('');
      options += `</optgroup>`;

      if (window.SamplerEngine) {
        const cats = SamplerEngine.getCategories();
        if (cats.length > 0) {
          options += `<optgroup label="Strudel Samples">`;
          options += cats.map(c => {
            const count = SamplerEngine.getSampleCount ? SamplerEngine.getSampleCount(c) : '';
            const badge = count ? ` (${count})` : '';
            return `<option value="${c}" ${instr.type === c ? 'selected' : ''}>\uD83D\uDCC1 ${c}${badge}</option>`;
          }).join('');
          options += `</optgroup>`;
        }
      }

      row.innerHTML = `
        <div class="instr-color-dot" style="background:${color.css}"></div>
        <span class="instr-track-name">${escHtml(trackName)}</span>
        <select class="instr-select" id="instr-select-${trackIdx}" title="Instrument type">
          ${options}
        </select>
      `;

      row.querySelector(`#instr-select-${trackIdx}`).addEventListener('change', e => {
        AudioEngine.setTrackInstrument(trackIdx, e.target.value);
      });

      container.appendChild(row);
    });
  }

  function syncSpatialSliders(fx) {
    if (!fx) return;
    if (fx.reverbMix !== undefined) {
      document.getElementById('fx-reverb-mix').value = Math.round(fx.reverbMix * 100);
      document.getElementById('fx-reverb-mix-val').textContent = Math.round(fx.reverbMix * 100) + '%';
    }
    if (fx.reverbDecay !== undefined) {
      document.getElementById('fx-reverb-decay').value = Math.round(fx.reverbDecay * 10);
      document.getElementById('fx-reverb-decay-val').textContent = fx.reverbDecay.toFixed(1) + 's';
    }
    if (fx.delayMix !== undefined) {
      document.getElementById('fx-delay-mix').value = Math.round(fx.delayMix * 100);
      document.getElementById('fx-delay-mix-val').textContent = Math.round(fx.delayMix * 100) + '%';
    }
    if (fx.delayTime !== undefined) {
      document.getElementById('fx-delay-time').value = fx.delayTime;
    }
    if (fx.delayFeedback !== undefined) {
      document.getElementById('fx-delay-feedback').value = Math.round(fx.delayFeedback * 100);
      document.getElementById('fx-delay-feedback-val').textContent = Math.round(fx.delayFeedback * 100) + '%';
    }
  }

  // ─── Utility ──────────────────────────────────────────────────
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return {
    renderPresets,
    renderSequencer,
    updatePlayhead,
    renderDevices,
    renderKeyboard,
    renderInstruments,
    flashKey,
    flashTrackActivity,
    showToast,
    openNotePicker,
    closeNotePicker,
    TRACK_COLORS,
    syncSpatialSliders,
    getCurrentStepEditing: () => currentStepBeingEdited,
    getSelectedNoteInPicker: () => _selectedNoteInPicker,
  };

})();

window.UI = UI;
window.showToast = UI.showToast;
