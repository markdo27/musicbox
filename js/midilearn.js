/**
 * midilearn.js — MIDI Learn
 * ---------------------------------------------------------------------------
 * Lets the user bind a hardware control to any app control:
 *
 *   1. Click the ◉ badge next to a control
 *   2. Move a knob / fader on the MIDI device
 *   3. The control is now mapped — and the mapping is bidirectional, so
 *      moving the app control also moves the hardware.
 *
 * The mapping is persisted to localStorage, so it survives a reload.
 *
 * Learnable controls are declared in the markup with `data-learn="Label"`.
 * The control's value range is taken from the element itself, so a
 * <input type="range"> and a <select> both work without extra wiring.
 */

const MidiLearn = (() => {
  'use strict';

  const STORAGE_KEY = 'musicbox_midilearn_v1';

  // controlId → { cc, ch, label, outputId }
  const map = new Map();

  let learning = null;        // { el, id, label }
  let applying = false;       // true while a CC is driving the UI
  let statusCb = null;        // fn(msg, kind)
  let bindCb = null;          // fn(controlId, binding)
  let outputResolver = null;  // fn(el) → outputId (or null for the default)

  // ─── Persistence ─────────────────────────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.entries(obj).forEach(([k, v]) => {
        if (v && typeof v.cc === 'number') map.set(k, v);
      });
    } catch (e) {
      console.warn('[MidiLearn] could not restore mappings:', e);
    }
  }

  function save() {
    try {
      const obj = {};
      map.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn('[MidiLearn] could not save mappings:', e);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────
  function _key(el) {
    if (el.id) return el.id;
    if (!el.dataset.learnKey) {
      el.dataset.learnKey = 'auto-' + Math.random().toString(36).slice(2, 8);
    }
    return el.dataset.learnKey;
  }

  function _status(msg, kind = 'info') {
    if (statusCb) statusCb(msg, kind);
  }

  /** The MIDI output a control should talk to. */
  function _outputFor(el) {
    if (outputResolver) {
      try { return outputResolver(el); } catch (e) { return null; }
    }
    return null;
  }

  // ─── Decoration ──────────────────────────────────────────────
  /**
   * Inject a learn badge after every `[data-learn]` element.
   * Idempotent — safe to call after every render.
   */
  function decorate(root) {
    const scope = root || document;
    const els = scope.querySelectorAll('[data-learn]');
    els.forEach((el) => {
      if (el._learnBadge) { refreshBadge(el); return; }      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'learn-badge';
      btn.setAttribute('aria-label', `MIDI learn for ${el.dataset.learn}`);
      btn.title = `MIDI learn: ${el.dataset.learn} — click, then move a hardware control`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginLearn(el);
      });
      el._learnBadge = btn;
      if (el.parentNode) el.parentNode.insertBefore(btn, el.nextSibling);
      // Bidirectional: moving the control in the app moves the hardware.
      const echo = () => sendFor(el);
      el.addEventListener('input', echo);
      el.addEventListener('change', echo);
      refreshBadge(el);
    });
  }

  function refreshBadge(el) {
    const btn = el._learnBadge;
    if (!btn) return;
    const id = _key(el);
    const m = map.get(id);
    if (learning && learning.id === id) {
      btn.classList.add('learning');
      btn.textContent = '●';
      btn.title = 'Move a hardware control now…';
    } else if (m) {
      btn.classList.add('mapped');
      btn.textContent = 'CC' + m.cc;
      btn.title = `${el.dataset.learn} ← CC${m.cc} (ch ${m.ch}). Click to re-learn.`;
    } else {
      btn.classList.remove('learning', 'mapped');
      btn.textContent = '○';
      btn.title = `MIDI learn: ${el.dataset.learn}`;
    }
  }

  function refreshAll(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-learn]').forEach((el) => refreshBadge(el));
  }

  // ─── Learning ────────────────────────────────────────────────
  function beginLearn(el) {
    if (learning) cancelLearn();
    learning = { el, id: _key(el), label: el.dataset.learn || 'control' };
    el.classList.add('learning');
    refreshBadge(el);
    _status(`Move a hardware control to map → ${learning.label}`, 'learn');
  }

  function cancelLearn() {
    if (!learning) return;
    learning.el.classList.remove('learning');
    const el = learning.el;
    learning = null;
    refreshBadge(el);
    _status('MIDI learn cancelled', 'info');
  }

  function isLearning() { return !!learning; }
  function learningLabel() { return learning ? learning.label : null; }

  // ─── Applying a CC value to an element ───────────────────────
  function applyToElement(el, ccValue) {
    const v = Math.max(0, Math.min(127, ccValue));
    applying = true;
    try {
      if (el.tagName === 'SELECT') {
        const n = el.options ? el.options.length : 0;
        if (n > 0) {
          el.selectedIndex = Math.round((v / 127) * (n - 1));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      const min = parseFloat(el.min ?? '0');
      const max = parseFloat(el.max ?? '127');
      const step = parseFloat(el.step ?? '1');
      let value = min + (v / 127) * (max - min);
      if (step > 0) value = Math.round(value / step) * step;
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      applying = false;
    }
  }

  /** Convert an element's current value back into a 0..127 CC value. */
  function valueToCC(el) {
    if (el.tagName === 'SELECT') {
      const n = el.options ? el.options.length : 1;
      return Math.round((el.selectedIndex / Math.max(1, n - 1)) * 127);
    }
    const min = parseFloat(el.min ?? '0');
    const max = parseFloat(el.max ?? '127');
    const val = parseFloat(el.value ?? '0');
    if (max === min) return 0;
    return Math.max(0, Math.min(127, Math.round(((val - min) / (max - min)) * 127)));
  }

  /** Push the element's current value to the mapped hardware control. */
  function sendFor(el) {
    if (applying) return;           // don't echo a value we just received
    const m = map.get(_key(el));
    if (!m) return;
    if (!window.MidiManager) return;
    MidiManager.sendCC(m.ch, m.cc, valueToCC(el), m.outputId || _outputFor(el));
  }

  // ─── Incoming CC ─────────────────────────────────────────────
  /**
   * Handle an incoming CC.
   * @returns {boolean} true if the CC was consumed (learned or mapped).
   */
  function handleCC(channel, cc, value) {
    // ── Learning mode consumes the first CC that arrives.
    if (learning) {
      const { el, id, label } = learning;
      const binding = {
        cc,
        ch: channel,
        label,
        outputId: _outputFor(el) || null,
      };
      map.set(id, binding);
      save();
      learning = null;
      el.classList.remove('learning');
      refreshBadge(el);
      // Reflect the incoming value immediately.
      applyToElement(el, value);
      _status(`Mapped ${label} ← CC${cc} (ch ${channel})`, 'success');
      if (bindCb) bindCb(id, binding);
      return true;
    }

    // ── Normal mapping
    let hit = false;
    map.forEach((m, id) => {
      if (m.cc !== cc) return;
      if (m.ch !== undefined && m.ch !== null && m.ch !== channel) return;
      const el = document.getElementById(id);
      if (!el) return;
      applyToElement(el, value);
      hit = true;
    });
    return hit;
  }

  // ─── Unbind ──────────────────────────────────────────────────
  function unbind(el) {
    const id = _key(el);
    if (map.has(id)) {
      map.delete(id);
      save();
      refreshBadge(el);
      _status(`Unmapped ${el.dataset.learn || id}`, 'info');
    }
  }

  function clearAll() {
    map.clear();
    save();
    refreshAll();
    _status('All MIDI mappings cleared', 'info');
  }

  function getMap() {
    const out = {};
    map.forEach((v, k) => { out[k] = v; });
    return out;
  }

  function count() { return map.size; }

  return {
    load, save, decorate, refreshAll, refreshBadge,
    beginLearn, cancelLearn, isLearning, learningLabel,
    handleCC, applyToElement, valueToCC, sendFor,
    unbind, clearAll, getMap, count,
    setStatusCallback: (fn) => { statusCb = fn; },
    setBindCallback: (fn) => { bindCb = fn; },
    setOutputResolver: (fn) => { outputResolver = fn; },
  };
})();

window.MidiLearn = MidiLearn;
