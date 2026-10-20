/**
 * ui.js — UI Rendering & Interaction
 * ---------------------------------------------------------------------------
 * Builds the sequencer grid, track rows, mixer, MIDI device panel,
 * the GENERATOR panel, the keyboard visualizer, and handles DOM events.
 *
 * KEY FIXES (post-audit):
 *  - renderDevices() no longer throws on the second call (it used to
 *    delete its own placeholder and then dereference null).
 *  - The track header name and MIDI channel are re-synced on every
 *    render, so a preset / undo / load cannot leave the grid lying.
 *  - The mixer is patched in place instead of being rebuilt, so a fader
 *    drag is not destroyed by a state change.
 *  - The GENERATOR panel gives the user real control over generation:
 *    genre, root, scale, progression, density, Euclidean rhythm,
 *    probability, accent/slide chance, motif length, humanise and a
 *    reproducible seed — with a LIVE preview.
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
  let _lastGenPatch = null;          // cached preview patch
  let _genSignature = '';            // last rendered generator parameter set

  // ─── Render genre preset buttons ────────────────────────────
  function renderPresets() {
    const grid = document.getElementById('preset-grid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.values(PRESETS).forEach(preset => {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.id = `preset-btn-${preset.id}`;
      btn.style.setProperty('--preset-color', preset.color);
      btn.style.setProperty('--preset-colorRgb', preset.colorRgb);
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
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`preset-btn-${presetId}`);
    if (btn) btn.classList.add('active');

    Sequencer.applyPreset(presetId);

    const preset = PRESETS[presetId];
    if (preset) {
      document.getElementById('bpm-value').value = preset.bpm;
      document.getElementById('swing-slider').value = preset.swing;
      document.getElementById('swing-value').textContent = preset.swing + '%';
    }
    showToast(`Loaded: ${preset ? preset.name : 'preset'}`, 'info');
  }

  // ─── Render full sequencer (called on state change) ────────────
  function renderSequencer(state) {
    renderStepIndicators(state.stepCount);
    renderTracks(state);
    renderMixer(state.tracks);
    // Only clear the step editor if the edited step no longer exists.
    if (currentStepBeingEdited) {
      const { trackIdx, stepIdx } = currentStepBeingEdited;
      if (!state.tracks[trackIdx] || !state.tracks[trackIdx].steps[stepIdx]) {
        const content = document.getElementById('step-editor-content');
        if (content) content.innerHTML = '<p class="hint-text">Click a step to edit</p>';
        currentStepBeingEdited = null;
      }
    }
  }

  // ─── Step indicator row ───────────────────────────────────────
  function renderStepIndicators(stepCount) {
    const row = document.getElementById('step-indicator-grid');
    if (!row) return;
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
    document.querySelectorAll('.step-btn.playhead-active').forEach(el => {
      el.classList.remove('playhead-active');
    });
    document.querySelectorAll('.step-indicator.playhead').forEach(el => {
      el.classList.remove('playhead');
    });

    if (step < 0) return;

    document.querySelectorAll(`.step-btn[data-step="${step}"]`).forEach(el => {
      el.classList.add('playhead-active');
    });
    const ind = document.getElementById(`step-ind-${step}`);
    if (ind) ind.classList.add('playhead');
  }

  // ─── Render all tracks ────────────────────────────────────────
  function renderTracks(state) {
    const container = document.getElementById('track-list');
    if (!container) return;
    const stepCount = state.stepCount;

    state.tracks.forEach((track, trackIdx) => {
      const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
      let row = document.getElementById(`track-row-${trackIdx}`);

      if (!row) {
        row = _createTrackRow(trackIdx, track, color, stepCount);
        container.appendChild(row);
      } else {
        // Re-sync the header: name and channel can change via preset /
        // undo / project load, and the grid must not keep showing stale text.
        const nameEl = row.querySelector(`#track-name-${trackIdx}`);
        if (nameEl && nameEl.textContent.trim() !== track.name) {
          nameEl.textContent = track.name;
        }
        const chEl = row.querySelector(`#track-ch-${trackIdx}`);
        if (chEl && String(chEl.value) !== String(track.midiChannel)) {
          chEl.value = String(track.midiChannel);
        }
        const modeEl = row.querySelector(`#track-mode-${trackIdx}`);
        if (modeEl && modeEl.value !== (track.audioMode || 'both')) {
          modeEl.value = track.audioMode || 'both';
        }
        const outEl = row.querySelector(`#track-out-${trackIdx}`);
        if (outEl) {
          const want = track.midiOutputId || '';
          if (outEl.value !== want) outEl.value = want;
          _refreshOutputOptions(outEl, trackIdx);
        }
        row.classList.toggle('muted', track.muted);
        row.classList.toggle('soloed', track.soloed);
      }

      const stepsGrid = row.querySelector('.steps-grid');
      _renderSteps(stepsGrid, track, trackIdx, stepCount, color);
    });

    while (container.children.length > state.tracks.length) {
      container.lastChild.remove();
    }
  }

  function _createTrackRow(trackIdx, track, color, stepCount) {
    const row = document.createElement('div');
    row.className = `track-row track-color-${trackIdx + 1}`;
    row.id = `track-row-${trackIdx}`;
    row.classList.toggle('muted', track.muted);
    row.classList.toggle('soloed', track.soloed);

    const chOptions = Array.from({length: 16}, (_, i) =>
      `<option value="${i+1}" ${track.midiChannel === i+1 ? 'selected' : ''}>${i+1}</option>`
    ).join('');

    row.innerHTML = `
      <div class="track-header">
        <div class="track-color-bar" style="background:${color.css}"></div>
        <div class="track-info">
          <div class="track-name" id="track-name-${trackIdx}" contenteditable="true" spellcheck="false">${escHtml(track.name)}</div>
          <div class="track-meta">
            <select class="track-ch-select" id="track-ch-${trackIdx}" title="MIDI channel">${chOptions}</select>
            <select class="track-mode-select" id="track-mode-${trackIdx}" title="Audio routing">
              <option value="both">Int+MIDI</option>
              <option value="internal">Internal</option>
              <option value="midi">MIDI only</option>
            </select>
            <select class="track-out-select" id="track-out-${trackIdx}" title="MIDI output device"></select>
          </div>
        </div>
        <div class="track-controls">
          <div class="track-activity" id="track-activity-${trackIdx}" style="--track-color:${color.css}"></div>
          <button class="track-btn mute-btn ${track.muted ? 'active' : ''}" id="mute-btn-${trackIdx}" title="Mute (M)">M</button>
          <button class="track-btn solo-btn ${track.soloed ? 'active' : ''}" id="solo-btn-${trackIdx}" title="Solo (S)">S</button>
        </div>
      </div>
      <div class="steps-grid" id="steps-grid-${trackIdx}"></div>
    `;

    // Track name edit
    const nameEl = row.querySelector(`#track-name-${trackIdx}`);
    nameEl.addEventListener('blur', () => {
      const name = nameEl.textContent.trim() || `Track ${trackIdx+1}`;
      Sequencer.setTrackProperty(trackIdx, 'name', name);
      const mixerName = document.getElementById(`mixer-name-${trackIdx}`);
      if (mixerName) mixerName.textContent = name;
    });
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

    // MIDI channel select
    row.querySelector(`#track-ch-${trackIdx}`).addEventListener('change', e => {
      Sequencer.setTrackProperty(trackIdx, 'midiChannel', parseInt(e.target.value, 10));
    });

    // Audio mode select (Internal / MIDI / Both)
    const modeEl = row.querySelector(`#track-mode-${trackIdx}`);
    modeEl.value = track.audioMode || 'both';
    modeEl.addEventListener('change', e => {
      Sequencer.setTrackAudioMode(trackIdx, e.target.value);
    });

    // MIDI output select
    const outEl = row.querySelector(`#track-out-${trackIdx}`);
    outEl.addEventListener('change', e => {
      Sequencer.setTrackMidiOutput(trackIdx, e.target.value || null);
    });
    _refreshOutputOptions(outEl, trackIdx);

    // Mute button
    row.querySelector(`#mute-btn-${trackIdx}`).addEventListener('click', () => {
      Sequencer.toggleMute(trackIdx);
      const st = Sequencer.getState().tracks[trackIdx];
      row.classList.toggle('muted', st.muted);
      row.querySelector(`#mute-btn-${trackIdx}`).classList.toggle('active', st.muted);
    });

    // Solo button — solo is orthogonal to mute, so only the solo flag changes.
    row.querySelector(`#solo-btn-${trackIdx}`).addEventListener('click', () => {
      Sequencer.toggleSolo(trackIdx);
      Sequencer.getState().tracks.forEach((t, i) => {
        const soloBtn = document.getElementById(`solo-btn-${i}`);
        const tr = document.getElementById(`track-row-${i}`);
        if (soloBtn) soloBtn.classList.toggle('active', t.soloed);
        if (tr) tr.classList.toggle('soloed', t.soloed);
      });
    });

    return row;
  }

  /** Populate a per-track MIDI output dropdown from the connected devices. */
  function _refreshOutputOptions(selectEl, trackIdx) {
    if (!selectEl) return;
    const devices = (window.MidiManager ? MidiManager.getDeviceList() : [])
      .filter(d => d.type === 'output');
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">Default output</option>` +
      devices.map(d => `<option value="${d.id}">${escHtml(d.name)}</option>`).join('');
    if (current) selectEl.value = current;
  }

  function _renderSteps(grid, track, trackIdx, stepCount, color) {
    if (!grid) return;
    for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
      let btn = document.getElementById(`step-${trackIdx}-${stepIdx}`);
      const step = track.steps[stepIdx];

      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'step-btn';
        btn.id = `step-${trackIdx}-${stepIdx}`;
        btn.dataset.track = trackIdx;
        btn.dataset.step = stepIdx;
        btn.setAttribute('role', 'gridcell');
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

    while (grid.children.length > stepCount) grid.lastChild.remove();
  }

  function _updateStepBtn(btn, step, color) {
    if (!step || !btn) return;
    btn.classList.toggle('active',      step.active);
    btn.classList.toggle('has-prob',    step.active && step.probability < 100);
    btn.classList.toggle('step-accent', step.active && (step.accent || false));
    btn.classList.toggle('step-slide',  step.active && (step.slide || false));
    btn.setAttribute('aria-pressed', step.active ? 'true' : 'false');
    btn.setAttribute('aria-label',
      `Step ${btn.dataset.step + 1}${step.active ? ', ' + midiToName(step.note) + ', velocity ' + step.velocity : ''}`);

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
    if (!step || !track || !content) return;

    // One undo entry per editing session.
    Sequencer.saveUndo();

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
        <span class="se-label">Offset</span>
        <input type="range" class="se-slider" id="se-offset" min="-50" max="50" value="${step.offset || 0}" />
        <span class="se-value" id="se-offset-val">${step.offset || 0}ms</span>
      </div>
      <div class="se-row">
        <span class="se-label">Repeat</span>
        <input type="range" class="se-slider" id="se-repeats" min="1" max="8" value="${step.repeats || 1}" />
        <span class="se-value" id="se-repeats-val">${step.repeats || 1}x</span>
      </div>
      <div class="se-row se-flags">
        <label class="se-flag-label ${step.accent ? 'flag-on' : ''}" id="se-accent-label">
          <input type="checkbox" id="se-accent" ${step.accent ? 'checked' : ''}>
          <span>&#9889; Accent</span>
        </label>
        <label class="se-flag-label ${step.slide ? 'flag-on' : ''}" id="se-slide-label">
          <input type="checkbox" id="se-slide" ${step.slide ? 'checked' : ''}>
          <span>&#8594; Slide</span>
        </label>
      </div>
      <div class="se-row">
        <button class="btn-secondary" id="se-toggle-active" style="flex:1">
          ${step.active ? '&#128308; Deactivate' : '&#128994; Activate'}
        </button>
      </div>
    `;

    document.getElementById('se-velocity').addEventListener('input', e => {
      document.getElementById('se-vel-val').textContent = e.target.value;
      _applyStepEdit({ velocity: parseInt(e.target.value, 10) });
    });
    document.getElementById('se-prob').addEventListener('input', e => {
      document.getElementById('se-prob-val').textContent = e.target.value + '%';
      _applyStepEdit({ probability: parseInt(e.target.value, 10) });
    });
    document.getElementById('se-offset').addEventListener('input', e => {
      document.getElementById('se-offset-val').textContent = e.target.value + 'ms';
      _applyStepEdit({ offset: parseInt(e.target.value, 10) });
    });
    document.getElementById('se-repeats').addEventListener('input', e => {
      document.getElementById('se-repeats-val').textContent = e.target.value + 'x';
      _applyStepEdit({ repeats: parseInt(e.target.value, 10) });
    });
    document.getElementById('se-note-select').addEventListener('change', e => {
      _applyStepEdit({ note: parseInt(e.target.value, 10) });
    });
    document.getElementById('se-gate').addEventListener('change', e => {
      _applyStepEdit({ gate: parseFloat(e.target.value) });
    });
    document.getElementById('se-accent').addEventListener('change', e => {
      _applyStepEdit({ accent: e.target.checked });
      document.getElementById('se-accent-label').classList.toggle('flag-on', e.target.checked);
      _refreshStepBtn(trackIdx, stepIdx);
    });
    document.getElementById('se-slide').addEventListener('change', e => {
      _applyStepEdit({ slide: e.target.checked });
      document.getElementById('se-slide-label').classList.toggle('flag-on', e.target.checked);
      _refreshStepBtn(trackIdx, stepIdx);
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
    // The undo snapshot is taken once when the editor opens, so dragging a
    // velocity slider does not push 60 undo entries.
    Sequencer.setStepData(trackIdx, stepIdx, data, { noUndo: true });
    _refreshStepBtn(trackIdx, stepIdx);
  }

  function _refreshStepBtn(trackIdx, stepIdx) {
    const btn = document.getElementById(`step-${trackIdx}-${stepIdx}`);
    if (!btn) return;
    const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
    _updateStepBtn(btn, Sequencer.getStep(trackIdx, stepIdx), color);
  }

  // ─── Mixer (patched in place, never rebuilt) ──────────────────
  function renderMixer(tracks) {
    const container = document.getElementById('mixer-tracks');
    if (!container) return;

    tracks.forEach((track, i) => {
      const color = TRACK_COLORS[i % TRACK_COLORS.length];
      let div = document.getElementById(`mixer-track-${i}`);

      if (!div) {
        div = document.createElement('div');
        div.className = 'mixer-track';
        div.id = `mixer-track-${i}`;
        div.innerHTML = `
          <div class="mixer-color-dot" style="background:${color.css}"></div>
          <span class="mixer-track-name" id="mixer-name-${i}"></span>
          <div class="mixer-fader-wrap">
            <input type="range" class="mixer-fader" id="mixer-vol-${i}" min="0" max="100"
              title="Volume" aria-label="${escHtml(track.name)} volume" data-learn="${escHtml(track.name)} volume" data-learn-track="${i}" />
            <div class="mixer-vu" id="mixer-vu-${i}"></div>
          </div>
          <span class="mixer-vol-val" id="mixer-vol-val-${i}"></span>
        `;
        div.querySelector(`#mixer-vol-${i}`).addEventListener('input', e => {
          const val = parseInt(e.target.value, 10);
          const lbl = document.getElementById(`mixer-vol-val-${i}`);
          if (lbl) lbl.textContent = val;
          // Real-time Web Audio volume control (no state churn while dragging)
          if (window.AudioEngine) AudioEngine.setTrackVolume(i, val / 100);
        });
        div.querySelector(`#mixer-vol-${i}`).addEventListener('change', e => {
          const val = parseInt(e.target.value, 10);
          Sequencer.setTrackProperty(i, 'volume', val);
          // Push the equivalent CC to the hardware, if the device supports it.
          const t = Sequencer.getState().tracks[i];
          if (window.MidiManager && t) {
            MidiManager.pushParamToDevice(t.midiChannel, 'volume', val / 100, t.midiOutputId);
          }
        });
        container.appendChild(div);
      }

      // Patch in place — rebuilding would destroy an in-progress drag.
      const nameEl = document.getElementById(`mixer-name-${i}`);
      if (nameEl && nameEl.textContent !== track.name) nameEl.textContent = track.name;
      const fader = document.getElementById(`mixer-vol-${i}`);
      if (fader && document.activeElement !== fader) fader.value = track.volume;
      const valEl = document.getElementById(`mixer-vol-val-${i}`);
      if (valEl) valEl.textContent = track.volume;
    });

    while (container.children.length > tracks.length) {
      container.lastChild.remove();
    }

    // The mixer faders are learnable — decorate them once they exist.
    if (window.MidiLearn) MidiLearn.decorate(container);
  }

  // ─── MIDI Device Panel ────────────────────────────────────────
  // Named hardware cards: always shown (connected or offline)
  const KNOWN_HARDWARE = [
    { name: 'RD-6',  desc: 'Drum Machine' },
    { name: 'RD-8',  desc: 'Drum Machine' },
    { name: 'TD-3',  desc: 'Acid 303 Bass' },
    { name: 'Crave', desc: 'Analogue Monosynth' },
    { name: 'Edge',  desc: 'Effects Synth' },
  ];

  function renderDevices(deviceList) {
    const list = document.getElementById('device-list');
    if (!list) return;
    const dot = document.getElementById('midi-dot');
    const statusText = document.getElementById('midi-status-text');

    const anyConnected = deviceList.length > 0;
    // The placeholder is only meaningful when the browser has no Web MIDI
    // support at all — otherwise the device cards convey the state.
    const noMsg = document.getElementById('no-devices-msg');
    const hasWebMidi = !!(window.navigator && navigator.requestMIDIAccess);
    if (noMsg) {
      noMsg.style.display = hasWebMidi ? 'none' : 'block';
      if (!hasWebMidi) noMsg.textContent = 'This browser has no Web MIDI support — internal audio only.';
    }
    list.innerHTML = '';
    if (dot) dot.classList.toggle('connected', anyConnected);
    if (statusText) {
      statusText.textContent = anyConnected
        ? `${deviceList.length} device${deviceList.length !== 1 ? 's' : ''}`
        : 'No MIDI';
    }

    const selectedId = window.MidiManager ? MidiManager.getSelectedOutput()?.id : null;

    // Known hardware — always rendered
    KNOWN_HARDWARE.forEach(hw => {
      const found = deviceList.find(d => d.name.toLowerCase().includes(hw.name.toLowerCase()));
      const card = document.createElement('button');
      card.className = 'device-card' + (found ? ' device-connected' : ' device-offline');
      card.type = 'button';
      card.dataset.deviceId = found ? found.id : '';
      card.innerHTML = `
        <div class="device-card-name">${hw.name}</div>
        <div class="device-card-desc">${hw.desc}</div>
        <div class="device-card-status">
          <span class="device-status-dot ${found ? 'online' : 'offline'}"></span>
          <span class="device-status-text">${found ? 'Connected' : 'Offline'}</span>
        </div>
      `;
      if (found && found.id === selectedId) card.classList.add('device-selected');
      if (found) {
        card.addEventListener('click', () => {
          MidiManager.selectOutput(found.id);
          MidiManager.saveSelectedOutput();
          renderDevices(MidiManager.getDeviceList());
          showToast(`MIDI output → ${found.name}`, 'success');
        });
      } else {
        card.disabled = true;
      }
      list.appendChild(card);
    });

    // Additional connected devices not in the known list
    deviceList.forEach(device => {
      const isKnown = KNOWN_HARDWARE.some(hw => device.name.toLowerCase().includes(hw.name.toLowerCase()));
      if (!isKnown) {
        const item = document.createElement('button');
        item.className = 'device-card device-connected';
        item.type = 'button';
        const typeIcon = device.type === 'output' ? '>' : '<';
        item.innerHTML = `
          <div class="device-card-name">[${typeIcon}] ${escHtml(device.name)}</div>
          <div class="device-card-desc">${escHtml(device.type)}${device.profile ? ' — ' + escHtml(device.profile) : ''}</div>
          <div class="device-card-status">
            <span class="device-status-dot online"></span>
            <span class="device-status-text">${device.type === 'output' && device.id === selectedId ? 'Selected output' : 'Connected'}</span>
          </div>
        `;
        if (device.type === 'output') {
          item.addEventListener('click', () => {
            MidiManager.selectOutput(device.id);
            MidiManager.saveSelectedOutput();
            renderDevices(MidiManager.getDeviceList());
            showToast(`MIDI output → ${device.name}`, 'success');
          });
          if (device.id === selectedId) item.classList.add('device-selected');
        } else {
          item.disabled = true;
        }
        list.appendChild(item);
      }
    });

    // Refresh the per-track output dropdowns with the new device list.
    const state = window.Sequencer ? Sequencer.getState() : null;
    if (state) {
      state.tracks.forEach((t, i) => {
        const sel = document.getElementById(`track-out-${i}`);
        if (sel) _refreshOutputOptions(sel, i);
      });
    }
  }

  // ─── Piano keyboard visualizer ────────────────────────────────
  function renderKeyboard() {
    const wrap = document.getElementById('keyboard-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';

    const startOctave = 3;
    const octaves = 2;
    const whites = [];
    const blacks = [];

    let whiteIdx = 0;
    for (let o = 0; o < octaves; o++) {
      NOTE_NAMES_DISPLAY.forEach((name, noteIdx) => {
        const midi = (startOctave + o + 1) * 12 + noteIdx;
        if (SHARP_NOTES.has(noteIdx)) {
          // A black key straddles the boundary between two white keys.
          blacks.push({ midi, boundary: whiteIdx, name: name + (startOctave + o) });
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

    whites.forEach(k => {
      const el = document.createElement('button');
      el.className = 'key white-key';
      el.id = `key-${k.midi}`;
      el.type = 'button';
      el.style.width = keyWidthPct + '%';
      el.title = k.name;
      el.setAttribute('aria-label', `Play ${k.name}`);
      el.addEventListener('mousedown', () => _playKey(k.midi));
      el.addEventListener('touchstart', (e) => { e.preventDefault(); _playKey(k.midi); }, { passive: false });
      wrap.appendChild(el);
    });

    blacks.forEach(k => {
      const el = document.createElement('button');
      el.className = 'key black-key';
      el.id = `key-${k.midi}`;
      el.type = 'button';
      // Centre the black key on the boundary between two white keys.
      // The CSS applies translateX(-50%), so `left` is the boundary itself.
      el.style.left = (k.boundary * keyWidthPct) + '%';
      el.title = k.name;
      el.setAttribute('aria-label', `Play ${k.name}`);
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
    const vu = document.getElementById(`mixer-vu-${trackIdx}`);
    if (vu) {
      vu.classList.add('vu-active');
      setTimeout(() => vu.classList.remove('active'), 200);
    }
  }

  // ─── Toast notification ───────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
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
    if (!step || !modal) return;

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

    _pickerOctave = Math.floor((step.note || 60) / 12) - 1;
    _selectedNoteInPicker = (step.note || 60) % 12;
    grid.children[_selectedNoteInPicker]?.classList.add('selected');

    const octSel = document.getElementById('sp-octave');
    if (octSel) octSel.value = String(_pickerOctave);

    document.getElementById('sp-velocity').value = step.velocity || 100;
    document.getElementById('sp-velocity-val').textContent = step.velocity || 100;
    document.getElementById('sp-gate').value = step.gate || 0.5;
    document.getElementById('sp-probability').value = step.probability || 100;
    document.getElementById('sp-probability-val').textContent = (step.probability || 100) + '%';

    modal.hidden = false;
  }

  function closeNotePicker() {
    const modal = document.getElementById('modal-note-picker');
    if (modal) modal.hidden = true;
    currentStepBeingEdited = null;
  }

  // ─── Instrument Panel ─────────────────────────────────────────
  const INSTRUMENT_TYPES = [
    { id: 'drum',  label: 'Drum 606',  desc: 'TR-606 kick/snare/hihat synthesis' },
    { id: 'acid',  label: 'Acid 303',  desc: 'TB-303 sawtooth + filter sweep + slide' },
    { id: 'bass',  label: 'Bass',      desc: 'Saw+Sub synth, fat filter' },
    { id: 'lead',  label: 'Lead',      desc: 'Dual saw monosynth, ladder filter' },
    { id: 'pad',   label: 'Pad',       desc: '5-voice detuned pad, slow attack' },
  ];

  function renderInstruments() {
    const container = document.getElementById('instrument-list');
    if (!container || !window.AudioEngine) return;
    const instrs = AudioEngine.getTrackInstruments();
    const cats = window.SamplerEngine ? SamplerEngine.getCategories() : [];

    instrs.forEach((instr, trackIdx) => {
      const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
      const trackName = Sequencer.getState().tracks[trackIdx]?.name || `Track ${trackIdx+1}`;
      let row = document.getElementById(`instr-row-${trackIdx}`);

      if (!row) {
        row = document.createElement('div');
        row.className = 'instr-row';
        row.id = `instr-row-${trackIdx}`;
        container.appendChild(row);
      }

      let options = `<optgroup label="Internal Synths">`;
      options += INSTRUMENT_TYPES.map(t =>
        `<option value="${t.id}" ${instr.type === t.id ? 'selected' : ''}>${t.label}</option>`
      ).join('');
      options += `</optgroup>`;

      if (cats.length > 0) {
        options += `<optgroup label="Strudel Samples">`;
        options += cats.map(c => {
          const count = SamplerEngine.getSampleCount ? SamplerEngine.getSampleCount(c) : '';
          const badge = count ? ` (${count})` : '';
          // Namespaced so a sample category can never shadow an internal type.
          const value = AudioEngine.samplerCategoryName(c);
          return `<option value="${escHtml(value)}" ${instr.type === value ? 'selected' : ''}>${escHtml(c)}${badge}</option>`;
        }).join('');
        options += `</optgroup>`;
      }

      const dot = row.querySelector('.instr-color-dot');
      if (dot) dot.style.background = color.css;
      const nameEl = row.querySelector('.instr-track-name');
      if (nameEl) nameEl.textContent = trackName;

      let sel = row.querySelector('.instr-select');
      if (!sel) {
        sel = document.createElement('select');
        sel.className = 'instr-select';
        sel.id = `instr-select-${trackIdx}`;
        sel.title = 'Instrument type';
        sel.addEventListener('change', e => {
          const value = e.target.value;
          AudioEngine.setTrackInstrument(trackIdx, value);
          // Pre-load the samples so the first hit is in time.
          if (window.SamplerEngine && AudioEngine.isSamplerType(value)) {
            const cat = value.slice('strudel:'.length);
            SamplerEngine.prefetch(AudioEngine.getContext(), cat);
          }
          // Push a program change if the device supports it.
          const t = Sequencer.getState().tracks[trackIdx];
          if (window.MidiManager && t) {
            const gm = { bass: 38, lead: 81, pad: 89, acid: 38, drum: 0 }[value];
            if (gm !== undefined) MidiManager.programChange(t.midiChannel || 1, gm, t.midiOutputId);
          }
        });
        row.appendChild(sel);
      }
      sel.innerHTML = options;
    });

    while (container.children.length > instrs.length) {
      container.lastChild.remove();
    }
  }

  function syncSpatialSliders(fx) {
    if (!fx) return;
    const set = (id, valId, value, suffix = '') => {
      const el = document.getElementById(id);
      const lbl = document.getElementById(valId);
      if (el) el.value = value;
      if (lbl) lbl.textContent = value + suffix;
    };
    if (fx.reverbMix !== undefined) {
      set('fx-reverb-mix', 'fx-reverb-mix-val', Math.round(fx.reverbMix * 100), '%');
    }
    if (fx.reverbDecay !== undefined) {
      const el = document.getElementById('fx-reverb-decay');
      const lbl = document.getElementById('fx-reverb-decay-val');
      if (el) el.value = Math.round(fx.reverbDecay * 10);
      if (lbl) lbl.textContent = fx.reverbDecay.toFixed(1) + 's';
    }
    if (fx.reverbTone !== undefined) {
      set('fx-reverb-tone', 'fx-reverb-tone-val', Math.round(fx.reverbTone / 100) / 10, 'k');
    }
    if (fx.delayMix !== undefined) {
      set('fx-delay-mix', 'fx-delay-mix-val', Math.round(fx.delayMix * 100), '%');
    }
    if (fx.delayTime !== undefined) {
      const el = document.getElementById('fx-delay-time');
      if (el) {
        // Snap to the nearest legal option so the select never goes blank.
        const opts = Array.from(el.options || []).map(o => parseFloat(o.value));
        if (opts.length === 0) {
          // No options to snap to — leave the select alone.
        } else if (!opts.some(o => Math.abs(o - fx.delayTime) < 0.001)) {
          const nearest = opts.reduce((a, b) =>
            Math.abs(b - fx.delayTime) < Math.abs(a - fx.delayTime) ? b : a);
          el.value = String(nearest);
        } else {
          el.value = String(fx.delayTime);
        }
      }
    }
    if (fx.delayFeedback !== undefined) {
      set('fx-delay-feedback', 'fx-delay-feedback-val', Math.round(fx.delayFeedback * 100), '%');
    }
  }

  // ─── Sync every bound control to the state ────────────────────
  function syncControls(state) {
    if (!state) return;
    const bpm = document.getElementById('bpm-value');
    if (bpm && document.activeElement !== bpm) bpm.value = state.bpm;

    const swing = document.getElementById('swing-slider');
    const swingVal = document.getElementById('swing-value');
    if (swing && document.activeElement !== swing) swing.value = state.swing;
    if (swingVal) swingVal.textContent = state.swing + '%';

    const steps = document.getElementById('step-count');
    if (steps && document.activeElement !== steps) steps.value = String(state.stepCount);

    const undoBtn = document.getElementById('btn-undo');
    if (undoBtn) undoBtn.disabled = !Sequencer.canUndo();
    const redoBtn = document.getElementById('btn-redo');
    if (redoBtn) redoBtn.disabled = !Sequencer.canRedo();

    const playBtn = document.getElementById('btn-play');
    if (playBtn) {
      playBtn.classList.toggle('active', state.isPlaying);
      playBtn.textContent = state.isPlaying ? '⏸' : '▶';
    }
    const recBtn = document.getElementById('btn-record');
    if (recBtn) recBtn.classList.toggle('active', state.isRecording);
  }

  // ═══════════════════════════════════════════════════════════════
  // GENERATOR PANEL
  // ═══════════════════════════════════════════════════════════════

  const GEN_PARAM_IDS = [
    'gen-genre', 'gen-root', 'gen-scale', 'gen-progression',
    'gen-density', 'gen-euclid-k', 'gen-euclid-n', 'gen-euclid-rot',
    'gen-probability', 'gen-accent', 'gen-slide', 'gen-motif',
    'gen-human-timing', 'gen-human-velocity', 'gen-seed',
  ];

  function _genReadParams() {
    const g = window.Generator;
    if (!g) return null;
    const val = (id, dflt) => {
      const el = document.getElementById(id);
      return el ? el.value : dflt;
    };
    const num = (id, dflt) => {
      const el = document.getElementById(id);
      return el ? parseInt(el.value, 10) : dflt;
    };
    return {
      genre: val('gen-genre', 'techno'),
      root: num('gen-root', 40),
      scale: val('gen-scale', 'phrygian'),
      progression: val('gen-progression', 'none'),
      density: num('gen-density', 50) / 100,
      euclidEnabled: true,
      euclid: {
        k: num('gen-euclid-k', 5),
        n: num('gen-euclid-n', 16),
        rot: num('gen-euclid-rot', 0),
      },
      probability: num('gen-probability', 20) / 100,
      accentChance: num('gen-accent', 20) / 100,
      slideChance: num('gen-slide', 25) / 100,
      motifLength: num('gen-motif', 4),
      humanize: {
        timing: num('gen-human-timing', 0),
        velocity: num('gen-human-velocity', 0),
      },
      seed: val('gen-seed', '') || undefined,
    };
  }

  function _genWriteParams(params) {
    if (!params) return;
    const setVal = (id, value) => {
      const el = document.getElementById(id);
      if (el && el.value !== String(value)) el.value = String(value);
    };
    setVal('gen-genre', params.genre);
    setVal('gen-root', params.root);
    setVal('gen-scale', params.scale);
    setVal('gen-progression', params.progression);
    setVal('gen-density', Math.round((params.density ?? 0.5) * 100));
    setVal('gen-euclid-k', params.euclid?.k ?? 5);
    setVal('gen-euclid-n', params.euclid?.n ?? 16);
    setVal('gen-euclid-rot', params.euclid?.rot ?? 0);
    setVal('gen-probability', Math.round((params.probability ?? 0.2) * 100));
    setVal('gen-accent', Math.round((params.accentChance ?? 0.2) * 100));
    setVal('gen-slide', Math.round((params.slideChance ?? 0.25) * 100));
    setVal('gen-motif', params.motifLength ?? 4);
    setVal('gen-human-timing', params.humanize?.timing ?? 0);
    setVal('gen-human-velocity', params.humanize?.velocity ?? 0);
    if (params.seed) setVal('gen-seed', params.seed);
    _genUpdateLabels();
  }

  function _genUpdateLabels() {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set('gen-density-val', (num('gen-density', 50)) + '%');
    set('gen-probability-val', (num('gen-probability', 20)) + '%');
    set('gen-accent-val', (num('gen-accent', 20)) + '%');
    set('gen-slide-val', (num('gen-slide', 25)) + '%');
    set('gen-motif-val', num('gen-motif', 4) + ' steps');
    set('gen-human-timing-val', num('gen-human-timing', 0) + 'ms');
    set('gen-human-velocity-val', num('gen-human-velocity', 0));
    set('gen-euclid-val', `E(${num('gen-euclid-k', 5)},${num('gen-euclid-n', 16)})`);
  }

  function num(id, dflt) {
    const el = document.getElementById(id);
    return el ? parseInt(el.value, 10) : dflt;
  }

  /** Render the generator's static controls once. */
  function renderGenerator() {
    const g = window.Generator;
    if (!g) return;

    // Genre
    const genreSel = document.getElementById('gen-genre');
    if (genreSel && !genreSel.options.length) {
      Object.entries(g.GENRES).forEach(([key, gdef]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = gdef.name;
        genreSel.appendChild(opt);
      });
    }

    // Root
    const rootSel = document.getElementById('gen-root');
    if (rootSel && !rootSel.options.length) {
      g.ROOTS.forEach(r => {
        const opt = document.createElement('option');
        opt.value = String(r.midi);
        opt.textContent = r.name;
        rootSel.appendChild(opt);
      });
    }

    // Scale
    const scaleSel = document.getElementById('gen-scale');
    if (scaleSel && !scaleSel.options.length) {
      Object.entries(g.SCALES).forEach(([key, def]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = g.SCALE_NAMES[key] || key;
        scaleSel.appendChild(opt);
      });
    }

    // Progression
    const progSel = document.getElementById('gen-progression');
    if (progSel && !progSel.options.length) {
      Object.entries(g.PROGRESSIONS).forEach(([key]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = g.PROGRESSION_NAMES[key] || key;
        progSel.appendChild(opt);
      });
    }

    // Target track selector
    const trackSel = document.getElementById('gen-target-track');
    if (trackSel) {
      const tracks = Sequencer.getState().tracks;
      const current = trackSel.value;
      trackSel.innerHTML = tracks.map((t, i) =>
        `<option value="${i}">${escHtml(t.name)}</option>`).join('');
      if (current && tracks[parseInt(current, 10)]) trackSel.value = current;
    }

    // Wire the controls
    GEN_PARAM_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.wired) return;
      el.dataset.wired = '1';
      const ev = (el.tagName === 'SELECT' || el.type === 'text') ? 'change' : 'input';
      el.addEventListener(ev, () => {
        _genUpdateLabels();
        _genPreview();
      });
    });

    // Seed controls
    const reroll = document.getElementById('gen-reroll');
    if (reroll && !reroll.dataset.wired) {
      reroll.dataset.wired = '1';
      reroll.addEventListener('click', () => {
        const seed = window.Generator.randomSeedString();
        const el = document.getElementById('gen-seed');
        if (el) el.value = seed;
        _genUpdateLabels();
        _genPreview();
      });
    }
    const copy = document.getElementById('gen-copy');
    if (copy && !copy.dataset.wired) {
      copy.dataset.wired = '1';
      copy.addEventListener('click', () => {
        const params = _genReadParams();
        if (!params) return;
        const url = `${location.origin}${location.pathname}#seed=${encodeURIComponent(params.seed || '')}` +
          `&genre=${params.genre}&root=${params.root}&scale=${params.scale}`;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(
            () => showToast('Share link copied!', 'success'),
            () => showToast(url, 'info'));
        } else {
          showToast(url, 'info');
        }
      });
    }

    // Generate buttons
    const genAll = document.getElementById('gen-generate');
    if (genAll && !genAll.dataset.wired) {
      genAll.dataset.wired = '1';
      genAll.addEventListener('click', () => {
        const params = _genReadParams();
        if (!params) return;
        Sequencer.setGenerativeParams(params);
        if (Sequencer.randomizeAll()) {
          UI.renderSequencer(Sequencer.getState());
          UI.renderInstruments();
          UI.syncControls(Sequencer.getState());
          showToast(`Generated — seed ${params.seed}`, 'success');
        }
      });
    }

    const genTrack = document.getElementById('gen-generate-track');
    if (genTrack && !genTrack.dataset.wired) {
      genTrack.dataset.wired = '1';
      genTrack.addEventListener('click', () => {
        const params = _genReadParams();
        const trackSel = document.getElementById('gen-target-track');
        const idx = trackSel ? parseInt(trackSel.value, 10) : 0;
        if (!params || isNaN(idx)) return;
        Sequencer.setGenerativeParams(params);
        if (Sequencer.randomizeTrack(idx)) {
          UI.renderSequencer(Sequencer.getState());
          showToast(`Track ${idx + 1} regenerated`, 'success');
        }
      });
    }

    // Load the current params into the controls
    const current = Sequencer.getGenerativeParams();
    if (current) _genWriteParams(current);
    else _genWriteParams(window.Generator.normaliseParams({ genre: 'techno' }));

    // The seed must never be empty, or every preview would use a
    // different random seed and the preview would not match the result.
    const seedEl = document.getElementById('gen-seed');
    if (seedEl && !seedEl.value) seedEl.value = window.Generator.randomSeedString();

    _genUpdateLabels();
    _genPreview(true);
  }

  /** Live preview of the generated pattern — all tracks, one row each. */
  function _genPreview(force = false) {
    const g = window.Generator;
    const grid = document.getElementById('gen-preview-grid');
    if (!g || !grid) return;

    const params = _genReadParams();
    if (!params) return;

    // Generating a full 8-track patch is not free — skip it when nothing
    // has changed, so a state refresh does not regenerate the world.
    const sig = JSON.stringify(params);
    if (!force && sig === _genSignature) return;
    _genSignature = sig;

    let patch;
    try {
      patch = g.generate(params);
    } catch (e) {
      console.error('[Generator] preview failed', e);
      return;
    }
    _lastGenPatch = patch;

    const trackSel = document.getElementById('gen-target-track');
    const targetIdx = trackSel ? parseInt(trackSel.value, 10) : 0;

    grid.innerHTML = '';

    patch.tracks.forEach((track, tIdx) => {
      const row = document.createElement('div');
      row.className = 'gen-preview-row' + (tIdx === targetIdx ? ' selected' : '');

      const label = document.createElement('div');
      label.className = 'gen-preview-row-label';
      label.textContent = track.name;
      label.title = `${track.name} — ${track.role || ''}`;
      row.appendChild(label);

      const cells = document.createElement('div');
      cells.className = 'gen-preview-cells';
      track.steps.forEach((st) => {
        const cell = document.createElement('div');
        cell.className = 'gen-cell';
        if (st.active) {
          cell.classList.add('on');
          if (st.accent) cell.classList.add('accent');
          if (st.slide) cell.classList.add('slide');
          if (st.probability < 100) cell.classList.add('prob');
          cell.style.setProperty('--h', (st.velocity / 127 * 100) + '%');
          cell.title = `${g.noteName(st.note)} · vel ${st.velocity} · gate ${Math.round(st.gate * 100)}%`;
        }
        cells.appendChild(cell);
      });
      row.appendChild(cells);

      // Clicking a row makes it the regeneration target.
      row.addEventListener('click', () => {
        if (trackSel) trackSel.value = String(tIdx);
        grid.querySelectorAll('.gen-preview-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
      });

      grid.appendChild(row);
    });

    const info = document.getElementById('gen-preview-info');
    if (info) {
      const hits = patch.tracks.reduce((n, t) => n + t.steps.filter(s => s.active).length, 0);
      info.textContent = `${patch.tracks.length} tracks · ${hits} hits · seed ${params.seed || '—'}`;
    }
  }

  // ─── Synth parameter panel ───────────────────────────────────
  // Per-track "front panel" for the internal engines. Each parameter is
  // MIDI-learnable and, where the device profile supports it, pushed to
  // the hardware as CC.
  const SYNTH_PARAM_MAP = [
    { key: 'cutoff',    id: 'synth-cutoff',    scale: 100, suffix: '%', cc: 'cutoff' },
    { key: 'resonance', id: 'synth-resonance', scale: 100, suffix: '%', cc: 'resonance' },
    { key: 'env',       id: 'synth-env',       scale: 100, suffix: '%', cc: 'envMod' },
    { key: 'decay',     id: 'synth-decay',     scale: 100, suffix: '%', cc: 'decay' },
    { key: 'drive',     id: 'synth-drive',     scale: 100, suffix: '%', cc: 'drive' },
    { key: 'glide',     id: 'synth-glide',     scale: 100, suffix: '%', cc: 'glide' },
    { key: 'level',     id: 'synth-level',     scale: 100, suffix: '%', cc: null },
    { key: 'tune',      id: 'synth-tune',      scale: 1,   suffix: 'st', cc: null },
  ];

  // The per-track insert FX (channel strip).
  const FX_PARAM_MAP = [
    { key: 'eqLow',      id: 'fx-eq-low',      scale: 1,   suffix: 'dB', cc: null },
    { key: 'eqMid',      id: 'fx-eq-mid',      scale: 1,   suffix: 'dB', cc: null },
    { key: 'eqHigh',     id: 'fx-eq-high',     scale: 1,   suffix: 'dB', cc: null },
    { key: 'drive',      id: 'fx-drive',       scale: 100, suffix: '%',  cc: 'drive' },
    { key: 'sendDelay',  id: 'fx-send-delay',  scale: 100, suffix: '%',  cc: null },
    { key: 'sendReverb', id: 'fx-send-reverb', scale: 100, suffix: '%',  cc: null },
  ];

  let _synthTrackIdx = 4;   // the 303 track by default

  function renderSynthPanel() {
    const sel = document.getElementById('synth-track');
    if (!sel) return;
    const tracks = Sequencer.getState().tracks;

    if (!sel.options.length) {
      tracks.forEach((t, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = t.name;
        sel.appendChild(o);
      });
      sel.value = String(_synthTrackIdx);
      sel.addEventListener('change', () => {
        _synthTrackIdx = parseInt(sel.value, 10) || 0;
        syncSynthPanel();
      });
    } else {
      // Keep the labels in sync with renamed tracks.
      tracks.forEach((t, i) => {
        const o = sel.options[i];
        if (o) o.textContent = t.name;
      });
    }
    syncSynthPanel();
  }

  function syncSynthPanel() {
    const params = window.AudioEngine ? AudioEngine.getTrackParams(_synthTrackIdx) : null;
    if (params) {
      SYNTH_PARAM_MAP.forEach(m => {
        const el = document.getElementById(m.id);
        const lbl = document.getElementById(m.id + '-val');
        if (!el) return;
        const v = params[m.key];
        if (document.activeElement !== el) el.value = String(Math.round(v * m.scale));
        if (lbl) lbl.textContent = (m.key === 'tune' ? v : Math.round(v * m.scale)) + m.suffix;
      });
    }
    const fx = window.AudioEngine ? AudioEngine.getTrackFx(_synthTrackIdx) : null;
    if (fx) {
      FX_PARAM_MAP.forEach(m => {
        const el = document.getElementById(m.id);
        const lbl = document.getElementById(m.id + '-val');
        if (!el) return;
        const v = fx[m.key];
        if (document.activeElement !== el) el.value = String(Math.round(v * m.scale));
        if (lbl) {
          lbl.textContent = m.suffix === 'dB'
            ? (v > 0 ? '+' : '') + v.toFixed(1) + 'dB'
            : Math.round(v * m.scale) + m.suffix;
        }
      });
    }
    if (window.MidiLearn) {
      MidiLearn.decorate(document.getElementById('panel-synth'));
    }
  }

  function getSynthTrackIdx() { return _synthTrackIdx; }
  function setSynthTrackIdx(i) {
    _synthTrackIdx = Math.max(0, i);
    const sel = document.getElementById('synth-track');
    if (sel) sel.value = String(_synthTrackIdx);
    syncSynthPanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // VARIATIONS PICKER
  // ═══════════════════════════════════════════════════════════════
  // "Generate 16" and *choose* one, rather than accepting whatever the
  // first dice roll produced. This is the single best generative UX in
  // the market (Ableton's Generate, Elektron's pattern randomiser).

  let _variationPatches = [];
  let _variationIndex = 0;
  let _variationBaseSeed = '';

  /** Draw a patch into a canvas thumbnail. */
  function _renderVariationCanvas(canvas, patch) {
    const cols = patch.stepCount || 16;
    const rows = patch.tracks.length;
    const cw = 5, ch = 5;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cols * cw * dpr;
    canvas.height = rows * ch * dpr;
    canvas.style.width = (cols * cw) + 'px';
    canvas.style.height = (rows * ch) + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cols * cw, rows * ch);
    patch.tracks.forEach((track, r) => {
      track.steps.forEach((st, c) => {
        if (!st.active) return;
        ctx.fillStyle = st.accent ? '#a16207' : st.slide ? '#15803d' : '#0e7490';
        ctx.fillRect(c * cw, r * ch, cw - 1, ch - 1);
      });
    });
  }

  function openVariations() {
    const g = window.Generator;
    if (!g) return;
    const params = _genReadParams();
    if (!params) return;
    _variationBaseSeed = params.seed || g.randomSeedString();
    _variationPatches = g.generateVariations({ ...params, seed: _variationBaseSeed }, 16);
    _variationIndex = 0;
    _renderVariations();
    const modal = document.getElementById('modal-variations');
    if (modal) modal.hidden = false;
    const info = document.getElementById('variations-info');
    if (info) info.textContent = `16 candidates from seed ${_variationBaseSeed}`;
  }

  function _renderVariations() {
    const grid = document.getElementById('variations-grid');
    if (!grid) return;
    grid.innerHTML = '';
    _variationPatches.forEach((patch, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'variation' + (i === _variationIndex ? ' selected' : '');

      const canvas = document.createElement('canvas');
      canvas.className = 'variation-canvas';
      _renderVariationCanvas(canvas, patch);

      const hits = patch.tracks.reduce((n, t) => n + t.steps.filter(s => s.active).length, 0);
      const meta = document.createElement('div');
      meta.className = 'variation-meta';
      meta.textContent = `${String(i + 1).padStart(2, '0')} · ${hits} hits`;

      cell.appendChild(canvas);
      cell.appendChild(meta);
      cell.addEventListener('click', () => _applyVariation(i));
      cell.addEventListener('mouseenter', () => { _variationIndex = i; _highlightVariation(i); });
      grid.appendChild(cell);
    });
  }

  function _highlightVariation(i) {
    const grid = document.getElementById('variations-grid');
    if (!grid) return;
    grid.querySelectorAll('.variation').forEach((el, idx) => {
      el.classList.toggle('selected', idx === i);
    });
  }

  function moveVariationSelection(delta) {
    if (!_variationPatches.length) return;
    _variationIndex = (_variationIndex + delta + _variationPatches.length) % _variationPatches.length;
    _highlightVariation(_variationIndex);
    const grid = document.getElementById('variations-grid');
    const sel = grid?.querySelector('.variation.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function applySelectedVariation() {
    _applyVariation(_variationIndex);
  }

  function _applyVariation(i) {
    const patch = _variationPatches[i];
    if (!patch) return;
    Sequencer.applyPatch(patch);
    UI.renderSequencer(Sequencer.getState());
    UI.renderInstruments();
    UI.syncControls(Sequencer.getState());
    // The chosen candidate's own seed goes in the field, so exactly this
    // result can be reproduced later.
    const seedEl = document.getElementById('gen-seed');
    if (seedEl) seedEl.value = patch.meta.seed || '';
    const params = Sequencer.getGenerativeParams();
    if (params) Sequencer.setGenerativeParams({ ...params, seed: patch.meta.seed });
    closeVariations();
    showToast(`Applied variation ${i + 1} of 16 — seed ${patch.meta.seed}`, 'success');
  }

  function closeVariations() {
    const modal = document.getElementById('modal-variations');
    if (modal) modal.hidden = true;
  }

  function isVariationsOpen() {
    const modal = document.getElementById('modal-variations');
    return !!(modal && !modal.hidden);
  }

  // ═══════════════════════════════════════════════════════════════
  // PATTERN BANK + SONG ARRANGER
  // ═══════════════════════════════════════════════════════════════
  // Eight pattern slots, and an arrangement that chains them across bars.
  // In song mode the ARRANGEMENT decides what sounds — so the grid can be
  // showing slot B while slot A plays.

  let _songPaint = null;   // { slot, active } while dragging the strip

  function renderPatternBank() {
    const container = document.getElementById('pattern-slots');
    if (!container) return;
    const bank = Sequencer.getBank();
    const song = Sequencer.getSong();

    container.innerHTML = '';
    bank.slots.forEach((slot, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-pad'
        + (i === bank.activeSlot ? ' active' : '')
        + (slot.tracks ? ' filled' : '');
      btn.textContent = slot.name;
      btn.title = slot.tracks
        ? `Slot ${slot.name} — saved ${new Date(slot.savedAt).toLocaleTimeString()}`
        : `Slot ${slot.name} — empty`;
      btn.addEventListener('click', () => {
        Sequencer.setActiveSlot(i);
        renderPatternBank();
      });
      // Right-click saves the current buffer into the slot.
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        Sequencer.saveToSlot(i);
        renderPatternBank();
        showToast(`Saved to slot ${slot.name}`, 'success');
      });
      container.appendChild(btn);
    });

    const toggle = document.getElementById('song-enabled');
    if (toggle) toggle.checked = !!song.enabled;
    const bars = document.getElementById('song-bars');
    if (bars) bars.value = String(song.bars);

    renderSong();
  }

  function renderSong() {
    const strip = document.getElementById('song-strip');
    if (!strip) return;
    const song = Sequencer.getSong();
    const bank = Sequencer.getBank();

    strip.innerHTML = '';
    for (let bar = 0; bar < song.bars; bar++) {
      const slotIdx = song.arrangement[bar] || 0;
      const cell = document.createElement('div');
      cell.className = 'song-cell' + (song.enabled ? ' enabled' : '');
      cell.dataset.bar = String(bar);
      cell.textContent = bank.slots[slotIdx]?.name || 'A';
      cell.title = `Bar ${bar + 1} → slot ${bank.slots[slotIdx]?.name} — click to change`;

      cell.addEventListener('click', () => {
        const next = (slotIdx + 1) % bank.slots.length;
        Sequencer.setArrangementBar(bar, next);
        renderSong();
      });

      // Drag across the strip to paint a slot across several bars.
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const next = (slotIdx + 1) % bank.slots.length;
        _songPaint = { slot: next };
        Sequencer.setArrangementBar(bar, next);
        renderSong();
      });
      cell.addEventListener('mouseenter', () => {
        if (!_songPaint) return;
        const bar2 = parseInt(cell.dataset.bar, 10);
        if (Sequencer.getSong().arrangement[bar2] !== _songPaint.slot) {
          Sequencer.setArrangementBar(bar2, _songPaint.slot);
          renderSong();
        }
      });
      strip.appendChild(cell);
    }
    updateSongPlayhead(Sequencer.currentSongBar());
  }

  function endSongPaint() { _songPaint = null; }

  /** Highlight the bar that is currently playing. */
  function updateSongPlayhead(bar) {
    const strip = document.getElementById('song-strip');
    if (!strip) return;
    strip.querySelectorAll('.song-cell').forEach(el => {
      el.classList.toggle('playing', parseInt(el.dataset.bar, 10) === bar);
    });
  }

  // ─── Utility ──────────────────────────────────────────────────
  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  return {
    renderPresets,
    renderSequencer,
    updatePlayhead,
    renderDevices,
    renderKeyboard,
    renderInstruments,
    renderGenerator,
    syncControls,
    flashKey,
    flashTrackActivity,
    showToast,
    openNotePicker,
    closeNotePicker,
    refreshStepBtn: _refreshStepBtn,
    renderSynthPanel,
    syncSynthPanel,
    getSynthTrackIdx,
    setSynthTrackIdx,
    openVariations,
    closeVariations,
    isVariationsOpen,
    moveVariationSelection,
    applySelectedVariation,
    renderPatternBank,
    renderSong,
    updateSongPlayhead,
    endSongPaint,
    SYNTH_PARAM_MAP,
    FX_PARAM_MAP,
    TRACK_COLORS,
    syncSpatialSliders,
    getCurrentStepEditing: () => currentStepBeingEdited,
    getSelectedNoteInPicker: () => _selectedNoteInPicker,
  };

})();

window.UI = UI;
window.showToast = UI.showToast;
