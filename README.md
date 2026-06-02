<div align="center">

# ⬡ MusicBox

**Browser-native step sequencer built for Techno & Acid**

*TR-606 drums · TB-303 acid bass · MIDI hardware sync — no DAW required*

[![Live Demo](https://img.shields.io/badge/Open_in-Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](#getting-started)
[![Web MIDI](https://img.shields.io/badge/Web_MIDI-API-00d4ff?style=for-the-badge)](#midi-hardware)
[![Web Audio](https://img.shields.io/badge/Web_Audio-API-00ff88?style=for-the-badge)](#audio-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-ffaa00?style=for-the-badge)](LICENSE)

</div>

---

## ✨ What It Is

MusicBox is a **pure browser step sequencer** focused on Techno and Acid music production. It runs entirely in Chrome — no install, no build step, no dependencies.

**Two modes in one:**
- **Standalone** — full TR-606 drum synthesis + TB-303 acid bass engine built in
- **Hardware** — MIDI clock + notes sent to your gear (RD-6, TD-3, Crave, Edge, etc.)

---

## 🔊 Audio Engine

All sounds are synthesized in real-time using the **Web Audio API**.

### TR-606 Drum Synthesis

Authentic Roland TR-606 emulation — no samples, pure oscillator synthesis:

| MIDI Note | Sound | Synthesis |
|---|---|---|
| C1 (36) | **Kick** | Sine sweep 180 → 30 Hz over 400ms · soft-clip distortion waveshaper |
| D1 (38) | **Snare** | Sine body 220 → 110 Hz (60%) + bandpass noise 2500 Hz (40%) |
| F#1 (42) | **Hi-Hat Closed** | 6 square oscillators (2070–10100 Hz) · 60ms decay |
| A#1 (46) | **Hi-Hat Open** | Same 6-osc stack · 350ms decay |
| D#1 (39) | **Clap** | 4 noise bursts at 0 / 3 / 6 / 10ms · bandpass 1800 Hz |
| A#1 (49) | **Crash** | 6 high-register partials · long shimmer decay |
| D#2 (51) | **Ride** | 8 bell partials · medium decay |

### TB-303 Acid Bass (`Acid 303` instrument type)

Per-channel voice state enables authentic **slide** (pitch glide) between notes:

- **Slide** — pitch glides smoothly between held notes (no retrigger)
- **Accent** — filter resonance peaks and volume boosts on accented steps
- **Filter sweep** — sawtooth through a 4-pole ladder-approximated LP filter with envelope modulation
- **Voice map** — each MIDI channel gets its own persistent voice for correct slide tracking

### Melodic Synths

| Type | Sound | Use |
|---|---|---|
| `Bass` | Sawtooth + sub octave, LP filter envelope | Sub bass, mono lines |
| `Lead` | Dual detuned saw, ladder filter | Melodic sequences |
| `Pad` | 5-voice detuned saw, 500ms attack | Chords, atmosphere |

---

## 🥁 Step Sequencer

8-track · 16 or 32 steps · AudioContext-accurate scheduling with swing

### Step Buttons

| Action | Result |
|---|---|
| **Left-click** | Toggle step on / off |
| **Right-click** or **Shift+click** | Open step editor sidebar |

### Step Editor (Right-click any step)

- **Note** — full MIDI range selector
- **Velocity** — 1–127 slider
- **Gate** — 10% / 25% / 50% / 75% / 100%
- **Probability** — 0–100% (amber dot = probabilistic step)
- **⚡ Accent** — enables TB-303 accent on this step (amber border on button)
- **→ Slide** — enables pitch slide to next note (green arrow on button)

### Visual Indicators

| Visual | Meaning |
|---|---|
| Amber top border | Accent active |
| Green `→` pip | Slide active |
| Amber dot | Probability < 100% |
| Velocity fill bar | Bottom fill height = velocity |

### Randomizer

Click **🎲 Randomize** for genre-aware pattern generation:

- **Kick** → 4-on-the-floor (+ optional ghost on step 15)
- **Snare** → backbeat (steps 4 + 12)
- **Hi-Hat** → 8ths or offbeats, random choice
- **Bass** → Phrygian/Minor pentatonic acid line with accent + slide variations
- **Lead** → sparse melodic sequence from minor pentatonic

---

## 📡 MIDI Hardware

### Supported Devices

Named hardware cards in the MIDI panel always show your gear — connected (🟢) or offline (⚫):

| Device | Role | MIDI Clock |
|---|---|---|
| **RD-6** | Drum machine | ✅ Receives clock |
| **TD-3** | Acid bass | — |
| **Crave** | Analogue monosynth | — |
| **Edge** | Effects synth | — |
| **RD-8** | Drum machine | ✅ Receives clock |

Any class-compliant USB MIDI device works — just not shown as a named card.

### Clock Broadcast

When playback starts, MIDI Start + 24 PPQN clock pulses are broadcast to **all clock-capable devices** simultaneously (RD-6, RD-8). No manual device selection needed.

### Accent → Hardware

Steps with **Accent** enabled send MIDI velocity ≥ 100. This triggers the TD-3's hardware accent circuit directly.

### Slide → Hardware

Steps with **Slide** enabled **omit the MIDI note-off** before the next note-on. The TD-3 / hardware synth receives legato and activates its slide/glide circuit automatically.

### Audio Routing (per track)

Each track has an `audioMode` property:

| Mode | Behaviour |
|---|---|
| `both` (default) | Plays internal synthesis AND sends MIDI |
| `internal` | Internal audio only, no MIDI output |
| `midi` | MIDI output only, no internal synthesis |

---

## 🎛️ Presets

| Preset | BPM | Character |
|---|---|---|
| ⚡ **Techno** | 135 | 4-on-the-floor kick, Phrygian acid bass, driving hats |
| 🧪 **Acid** | 138 | TB-303 style rapid 16th bass with accent + slide variations |

Click **🎲 Randomize** to generate a new variation within the current genre feel.

---

## 💾 Save & Export

| Action | How |
|---|---|
| **Auto-save** | Every 30 seconds to `localStorage` |
| **Manual save** | `Ctrl+S` or 💾 button |
| **Load project** | 📂 button → pick a `.json` file |
| **Export MIDI** | ⬇ `.mid` → standard MIDI file, loads in any DAW |

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Esc` | Stop |
| `Ctrl+S` | Save project |
| `Ctrl+Z` | Undo |
| `Shift+Click` step | Open step editor |
| `Right-click` step | Open step editor |

---

## 🚀 Getting Started

MusicBox is a **pure static HTML/CSS/JavaScript app** — zero build step, zero dependencies.

```bash
git clone https://github.com/markdo27/musicbox.git
cd musicbox

# Open in Chrome (Web MIDI + Web Audio require Chrome or Edge)
start chrome index.html
```

> **Browser requirement**: Use **Google Chrome** or **Microsoft Edge**. Firefox and Safari do not support the Web MIDI API.

---

## 📁 Project Structure

```
musicbox/
├── index.html          # App shell — all panels and modals
├── css/
│   └── style.css       # Design system (dark hardware aesthetic)
└── js/
    ├── presets.js      # Techno + Acid presets with per-step accent/slide
    ├── audio.js        # TR-606 drums + TB-303 acid synthesis engine
    ├── midi.js         # Web MIDI — device profiles, clock broadcast, note routing
    ├── sequencer.js    # Scheduler (AudioContext timing, accent/slide, audioMode)
    ├── storage.js      # LocalStorage, JSON export/import, MIDI file export
    ├── ui.js           # UI rendering — step grid, device cards, step editor
    └── app.js          # Main entry point — wires all modules together
```

**Stack**: Vanilla HTML · CSS · JavaScript (ES2020) · Web MIDI API · Web Audio API  
**Dependencies**: Zero (Google Fonts via CDN only)

---

## 🗺️ Roadmap

- [ ] Per-track audio mode toggle in UI (Internal / MIDI / Both)
- [ ] CC automation lanes (draw filter cutoff curves per track)
- [ ] LFO modulation engine mapped to any CC
- [ ] Piano Roll editor (free-draw note arrangement)
- [ ] Pattern / Song arranger (chain patterns A → B → C)
- [ ] MIDI Learn (click a knob, move hardware knob → auto-map)
- [ ] More genre presets (Industrial, Breaks, Deep House)

---

## 📄 License

MIT © 2026 MusicBox
