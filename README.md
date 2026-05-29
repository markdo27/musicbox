<div align="center">

# ⬡ MusicBox

**Browser-native music sequencer with MIDI I/O and built-in synthesis**

*Create techno, tech house, acid and more — directly in Chrome. No DAW required.*

[![Live Demo](https://img.shields.io/badge/Open_in-Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](#getting-started)
[![Web MIDI](https://img.shields.io/badge/Web_MIDI-API-00d4ff?style=for-the-badge)](#midi-hardware)
[![Web Audio](https://img.shields.io/badge/Web_Audio-API-00ff88?style=for-the-badge)](#built-in-audio)
[![License: MIT](https://img.shields.io/badge/License-MIT-ffaa00?style=for-the-badge)](LICENSE)

![MusicBox screenshot](docs/screenshot.png)

</div>

---

## ✨ Features

| Feature | Details |
|---|---|
| 🥁 **8-Track Step Sequencer** | 16 or 32 steps per track, LED-style buttons |
| 🔊 **Built-in Audio Engine** | Kick, snare, hi-hat, bass, lead & pad synthesis — no hardware needed |
| 📡 **Web MIDI I/O** | Auto-detects Behringer synths, sends notes + MIDI Clock |
| 🎨 **7 Genre Presets** | Techno, Tech House, Acid, Minimal, Deep House, Breaks, Industrial |
| ✏️ **Per-Step Editor** | Note, velocity, gate length, and **probability** per step |
| 🎛️ **Mixer** | Per-track volume, mute, solo |
| 💾 **Save / Load** | Auto-save, JSON export/import, and MIDI file export (`.mid`) |
| ⌨️ **Keyboard Shortcuts** | `Space` play/pause · `Esc` stop · `Ctrl+S` save |

---

## 🚀 Getting Started

MusicBox is a pure static HTML/CSS/JavaScript app — **zero build step, zero dependencies**.

```bash
# Clone the repo
git clone https://github.com/markdo27/musicbox.git
cd musicbox

# Open directly in Chrome (Web MIDI + Web Audio require Chrome/Edge)
open -a "Google Chrome" index.html
```

> **⚠️ Browser requirement**: Use **Google Chrome** or **Microsoft Edge**. Firefox and Safari do not support the Web MIDI API natively.

---

## 🎛️ How to Use

### Quick Start (No Hardware)

1. Open `index.html` in Chrome
2. Click a **Genre Preset** in the left sidebar (e.g. ⚡ Techno)
3. Press **`Space`** or click **▶** to play
4. Hear the sequence immediately via the built-in synthesizer

### Connecting Behringer Hardware

1. Plug in your device via USB
2. Click **Connect MIDI** in the MIDI Devices panel
3. Grant browser MIDI permission when prompted
4. Your device appears in the device list — MIDI notes and clock are sent automatically

### Step Sequencer

- **Left-click** a step button → toggle on/off
- **Right-click** (or **Shift+click**) → open Step Editor (note, velocity, gate, probability)
- **Probability < 100%** → step plays randomly (great for techno variation, shown by amber dot)
- Drag the **velocity bar** (fill height) to set dynamics visually

### Genre Presets

Each preset loads a complete 8-track pattern with appropriate BPM and swing:

| Preset | BPM | Character |
|---|---|---|
| ⚡ Techno | 135 | 4/4 kick, Phrygian bass, driving |
| 🔥 Tech House | 128 | Groovy 16th bass, shuffled percussion |
| 🧪 Acid | 138 | TB-303 style rapid 16th bass with gate/accent variation |
| ⬜ Minimal | 130 | Sparse, hypnotic, evolving |
| 🌊 Deep House | 122 | Walking bass, chord pads, soulful |
| 💥 Breaks | 150 | Syncopated breakbeat, high energy |
| 🏭 Industrial | 140 | Double-kick, metallic percussion, dark |

Click **🎲 Randomize** to generate a variation within the current feel.

---

## 🔊 Built-in Audio Engine

MusicBox synthesizes all sounds in-browser using the **Web Audio API** — no samples or external files needed.

### Drum Synthesis (Channel 10 / `🥁 Drum` instrument type)

Uses standard **GM MIDI note mapping**:

| MIDI Note | Drum Sound | Synthesis Method |
|---|---|---|
| C1 (36) | Kick | Sine osc, 160→38Hz pitch envelope + noise click |
| D1 (38) | Snare | Bandpass noise + sine tone |
| F#1 (42) | Hi-Hat Closed | 6 detuned square oscs, highpass filtered, 60ms |
| A#1 (46) | Hi-Hat Open | Same as closed, 350ms decay |
| D#1 (39) | Clap | 3 layered noise bursts with ms offsets |
| A#1/D# | Crash/Ride | Multi-osc high-register shimmer |

### Melodic Synthesis

| Type | Sound | Best for |
|---|---|---|
| `🎸 Bass` | Sawtooth + sub octave, LP filter env (300→2000→600Hz) | Bass lines, sub |
| `🎹 Lead` | Square + detuned saw, bright filter | Melodies, acid riffs |
| `🌊 Pad` | 5-voice detuned saw, 500ms attack, warm LP | Chords, atmospheres |

Switch any track's instrument in the **INSTRUMENTS** panel (right sidebar).

### Audio Controls (Header Bar)

- **🔊 AUDIO button** — toggle internal audio on/off (green glow = active)
- **VOL slider** — master volume

---

## 🎹 MIDI Hardware Support

MusicBox uses the **Web MIDI API** and works with any class-compliant USB MIDI device. It has built-in CC profiles for Behringer hardware:

| Device | Recognised CCs |
|---|---|
| **TD-3** | Cutoff (74), Resonance (71), Env Mod (79), Accent (65), Decay (80) |
| **Model D** | Cutoff (74), Resonance (71), Glide (5), Volume (7) |
| **Neutron** | Cutoff (74), Resonance (71), Drive (30), Osc Mix (31) |
| **Crave** | Cutoff (74), Resonance (71), Glide (5) |
| **RD-8** | MIDI Clock sync |

MIDI Clock is sent to all connected output devices when the sequencer plays, keeping your Behringer hardware in sync.

---

## 💾 Project Save & Export

| Action | How |
|---|---|
| **Auto-save** | Every 30 seconds to `localStorage` |
| **Manual save** | `Ctrl+S` or 💾 button |
| **Load project** | 📂 button → pick a `.json` file |
| **Export MIDI** | ⬇ `.mid` button → standard MIDI file (loads in any DAW) |

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Esc` | Stop |
| `Ctrl+S` | Save project |
| `Ctrl+R` | Toggle record |
| `Shift+Click` step | Open step editor |
| `Right-click` step | Open step editor |

---

## 📁 Project Structure

```
musicbox/
├── index.html          # App shell — all panels and modals
├── css/
│   └── style.css       # Full design system (dark LED aesthetic)
└── js/
    ├── presets.js      # 7 genre presets with complete 8-track patterns
    ├── audio.js        # Web Audio synthesis engine (drums + synths)
    ├── midi.js         # Web MIDI API — device detection, send/receive, clock
    ├── sequencer.js    # Step sequencer engine (AudioContext timing, swing)
    ├── storage.js      # LocalStorage, JSON export/import, MIDI file export
    ├── ui.js           # UI rendering, step grid, mixer, keyboard visualizer
    └── app.js          # Main entry point — wires all modules together
```

**Tech stack**: Vanilla HTML · CSS · JavaScript (ES2020) · Web MIDI API · Web Audio API  
**Dependencies**: Zero (Google Fonts loaded via CDN for typography only)

---

## 🗺️ Roadmap

- [ ] CC Automation lanes (draw filter cutoff curves per track)
- [ ] LFO modulation engine mapped to any CC
- [ ] Piano Roll editor (free-draw note arrangement)
- [ ] Pattern / Song arranger (chain patterns A→B→C)
- [ ] MIDI Learn (click a knob, move hardware knob → auto-map)
- [ ] Mobile touch UI
- [ ] Cloud sync (Firebase)

---

## 🤝 Contributing

Pull requests welcome. For major changes, please open an issue first.

```bash
git clone https://github.com/markdo27/musicbox.git
# make changes to index.html / css/ / js/
# no build step required — open index.html to test
```

---

## 📄 License

MIT © 2026 MusicBox Contributors
