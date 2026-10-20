<div align="center">

# ⬡ MusicBox

**Browser-native generative step sequencer and MIDI controller**

*Seeded generative engine · TR-606 drums · TB-303 acid bass · Web MIDI out — no DAW required*

[![Live Demo](https://img.shields.io/badge/Open_in-Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](#getting-started)
[![Web MIDI](https://img.shields.io/badge/Web_MIDI-API-00d4ff?style=for-the-badge)](#midi-hardware)
[![Web Audio](https://img.shields.io/badge/Web_Audio-API-00ff88?style=for-the-badge)](#audio-engine)
[![Tests](https://img.shields.io/badge/tests-292_passing-16a34a?style=for-the-badge&logo=node.js&logoColor=white)](tests/)
[![Benchmark](https://img.shields.io/badge/benchmark-8.25%2F10-16a34a?style=for-the-badge)](docs/AUDIT.md)

</div>

---

## ✨ What It Is

MusicBox is a **pure browser step sequencer** with a real generative engine
and a real MIDI-controller half. Everything runs in Chrome — no install, no
build step, no dependencies, no accounts.

**Three things it does that other browser sequencers don't:**

1. **It generates, and you can steer it.** Genre, root, scale, chord
   progression, density, Euclidean rhythm, probability, accent/slide chance,
   motif length and humanisation are all live controls with a **live
   preview**. Press **16 Variations** and you get sixteen candidate
   patches as thumbnails — *choose* one instead of accepting a dice roll.
   Every result is reproducible from its **seed**; share a link and someone
   else gets the identical pattern.
2. **It drives real hardware properly.** Per-track output routing to
   different MIDI devices, per-track Internal/MIDI/Both switching, a
   **drift-free clock** you can run as master *or* slave, **MIDI Learn**
   (bind any control to a knob, bidirectionally), and device CC profiles
   for the TD-3, Crave, Edge, Model D and Neutron.
3. **It composes, not just loops.** An **8-slot pattern bank** and a
   **song arranger** chain those slots across bars, so the grid can be
   showing slot B while slot A plays. The whole thing records to **WAV**.

The scorecard in [`docs/AUDIT.md`](docs/AUDIT.md) grades the project
3.4 → **8.25** against 8 dimensions and lists exactly what is still missing.

---

## 🎲 The Generator

The centre panel is the product. Press **G** to generate, **R** for a new
seed.

| Control | What it does |
|---|---|
| **Genre** | Techno · Acid · House · Drum & Bass · Lo-Fi · Dub Techno · Ambient — each with its own tempo range, swing, scale, instrument set and pattern vocabulary |
| **Root / Scale** | 25 roots (C2–C4) × 14 scales. The app has a concept of *key* — previously it did not |
| **Chords** | 11 diatonic progressions (i–VI–III–VII, Andalusian, pop, modal…) driving a chord or pad track |
| **Density** | How busy the pattern is, from sparse to relentless |
| **Euclid** | `E(k, n)` with rotation — Bjorklund's maximally-even distribution, the same primitive Strudel and the Elektron Digitakt use |
| **Prob / Accent / Slide** | How often steps are probabilistic, accented, or glided |
| **Motif** | Length of the melodic motif, which is then developed as **A → A′ → A″ → B** (repeat with variation) |
| **Humanise** | Per-track micro-timing (±ms) and velocity variance — the difference between *programmed* and *played* |
| **Seed** | A 6-character code. Same seed + same parameters = byte-identical pattern. The 🔗 button copies a share link |

Generation is **non-destructive**: "Regenerate Track" rewrites one track and
leaves the other seven alone.

### 16 Variations

Press **16 Variations** and you get **sixteen candidate patches**, each
rendered as a thumbnail of the full 8-track pattern — accents in amber,
slides in green. Arrow keys to move, **Enter** to apply, **Esc** to cancel.

The whole set is reproducible from its base seed, so you can share "try
these sixteen" as a single link.

---

## 🗂 Pattern Bank & Song

The left sidebar has a **PATTERN** panel.

- **8 slots (A–H).** Click a slot to edit it; right-click to save the
  current pattern into it. Slots never share step data with the edit
  buffer, so editing one cannot corrupt another.
- **SONG mode** turns on the arrangement strip — an 8/16/32-bar timeline
  where each bar points at a slot. Click a bar to change its slot, drag
  across to paint. While song mode is on, **the arrangement decides what
  sounds**, so the grid can be showing slot B while slot A is playing.
- The playing bar is highlighted in the strip as it goes round.

---

## 🎙 Recording

The **🎙 REC** button in the header captures the master bus and exports a
**16-bit stereo WAV**. The tap is an `AudioWorklet`, so it does not
glitch under load, and the samples are written to a zero-gain sink so the
capture never contributes a sound of its own.

---

## 🔊 Audio Engine

All sounds are synthesized in real-time using the **Web Audio API**, on a
single shared `AudioContext`, scheduled at **absolute** audio-clock times.

### TR-606 Drum Synthesis

| MIDI Note | Sound | Synthesis |
|---|---|---|
| C1 (36) | **Kick** | Sine sweep 180 → 30 Hz over 400 ms · soft-clip waveshaper · 3 kHz click transient |
| D1 (38) | **Snare** | Sine body 220 → 110 Hz (60%) + bandpass noise 2500 Hz (40%) |
| F#1 (42) | **Hi-Hat Closed** | Six **inharmonic** metal oscillators (246.4 / 308.0 / 367.0 / 418.2 / 440.4 / 627.2 Hz) through a 9 kHz band-pass — the 606's metal circuit, not a bright-square buzz |
| A#1 (46) | **Hi-Hat Open** | Same metal bank, 350 ms decay |
| D#2 (39) | **Clap** | 4 noise bursts at 0 / 3 / 6 / 10 ms · bandpass 1800 Hz |
| A#1 (49) | **Crash** | Separate 6-oscillator cymbal bank through a 5.5 kHz band-pass |
| D#2 (51) | **Ride** | 3 bell partials |

### TB-303 Acid Bass (`Acid 303` instrument type)

Per-channel+track voice state enables authentic **slide** (portamento) between
notes:

- **Slide** — 45 ms pitch glide into the next note, no envelope retrigger
- **Accent** — opens the filter envelope to 4.2 kHz, raises resonance to
  Q 14, and boosts the amplitude ~3 dB
- **Filter** — a 4-pole ladder approximation (24 dB/oct), decay-only envelope
- **Articulation** — the amplitude envelope decays to a sustain level, so
  the 303 phrases instead of droning

### Melodic Synths

| Type | Sound | Use |
|---|---|---|
| `Bass` | Sawtooth + sub octave, LP filter envelope | Sub bass, mono lines |
| `Lead` | Dual detuned saw, 2× cascade ladder filter | Melodic sequences |
| `Pad` | 5-voice detuned saw, 500 ms attack | Chords, atmosphere |

### Sampler

Optional Strudel / Dirt-Samples categories are available per track and are
**namespaced** so they can never shadow an internal engine. Buffers are
pre-fetched when a category is selected, and playback is scheduled at an
absolute time so it lands on the beat.

---

## 🥁 Step Sequencer

8-track · 16 or 32 steps · AudioContext-accurate scheduling with swing.

### Step Buttons

| Action | Result |
|---|---|
| **Left-click** | Toggle step on / off |
| **Right-click** or **Shift+click** | Open step editor |

### Step Editor

- **Note** — full MIDI range selector
- **Velocity** — 1–127 slider
- **Gate** — 10% / 25% / 50% / 75% / 100%
- **Probability** — 0–100% (amber dot = probabilistic step)
- **Offset** — ±50 ms micro-timing (the humanise handle)
- **Repeat** — 1–8× ratchet
- **⚡ Accent** — TB-303 accent on this step (amber border)
- **→ Slide** — glide into the next note (green arrow)

### Visual Indicators

| Visual | Meaning |
|---|---|
| Amber top border | Accent active |
| Green `→` pip | Slide active |
| Amber dot | Probability < 100% |
| Velocity fill bar | Bottom fill height = velocity |

---

## 📡 MIDI Hardware

### Supported Devices

Named hardware cards always show your gear — connected (🟢) or offline (⚫).
**Click a connected card to make it the active output.**

| Device | Role | MIDI Clock | CC support |
|---|---|:---:|---|
| **RD-6** | Drum machine | ✅ | — |
| **RD-8** | Drum machine | ✅ | — |
| **TD-3** | Acid bass | — | cutoff · resonance · env mod · accent · decay |
| **Crave** | Analogue monosynth | — | cutoff · resonance · glide |
| **Edge** | Effects synth | — | cutoff |
| **Model D** | Analog synth | — | cutoff · resonance · glide · volume |
| **Neutron** | Analog synth | — | cutoff · resonance · drive · osc mix |

Any class-compliant USB MIDI device works — it just won't get a named card.

### Clock — master or slave

**CLOCK → Internal** (default): MusicBox generates the clock and drives
the hardware. The pulse count is derived from the AudioContext, so the
average tempo is exact and there is no accumulating drift. Changing the
BPM re-times the pulse train instead of restarting the song, so hardware
slaves keep their position.

**CLOCK → External**: MusicBox becomes a **slave**. It stops sending its
own clock, listens for incoming `0xF8` / `0xFA` / `0xFB` / `0xFC`, estimates
the tempo, and schedules every step on the **hardware's own pulse grid** —
so it lands in phase, not merely at the same average tempo.

### MIDI Learn

Any control marked with a **◉** badge can be bound to a hardware control:

1. Click the badge.
2. Move a knob on the device.
3. The control is mapped, and the badge shows the CC number.

The mapping is **bidirectional** — moving the control in the app also moves
the hardware — and it is saved, so it survives a reload. Master volume,
swing, tempo, every track fader, the spatial FX and the synth parameters
are all learnable.

### Accent → Hardware

Steps with **Accent** enabled send MIDI velocity ≥ 100. This triggers the
TD-3's hardware accent circuit directly.

### Slide → Hardware

A slide step is exported as true MIDI **legato**: the held note is released
at the instant the next note-on goes out, which is what triggers the
hardware's glide circuit.

### Audio Routing (per track)

Each track has an `audioMode` property, switchable from the track header:

| Mode | Behaviour |
|---|---|
| `Int+MIDI` (default) | Plays internal synthesis AND sends MIDI |
| `Internal` | Internal audio only, no MIDI output |
| `MIDI only` | MIDI output only, no internal synthesis |

Each track also has a **MIDI output target** dropdown, so a drum machine and
a bass synth can be driven independently.

---

## ⚙️ Channel Strip

Every track has a real channel strip. Select a track in the **CHANNEL**
panel and dial it in.

**Voice**

| Control | What it does |
|---|---|
| **Cutoff** | Base filter frequency |
| **Reso** | Filter resonance (Q) |
| **Env** | Filter envelope **depth** — how far the filter opens. Accent deepens this, it does not just get louder |
| **Decay** | Filter envelope decay time |
| **Drive** | Output saturation (asymmetric, like the 303's output stage) |
| **Glide** | Portamento time for slides |
| **Level** | Output level |
| **Tune** | ±12 semitones — for drums this is the 606's tuning pot |

**Insert FX**

| Control | What it does |
|---|---|
| **EQ low / mid / high** | −12…+12 dB. An 80 Hz shelf, a 900 Hz peak and a 4 kHz shelf |
| **Sat** | Saturation on the track |
| **Dly / Rev** | This track's **own** send to the delay and reverb buses |

The global SPATIAL FX still work — the per-track sends *add* to them, the
same way a DAW's global bus and per-track sends coexist. That means a pad
can sit in a lot of reverb while the kick stays dry.

The voice mapping is a pure function, so it is **unit-tested** rather than
asserted by ear. Full details: [`docs/ENGINE.md`](docs/ENGINE.md).

---

## 🎛️ Presets

| Preset | BPM | Character |
|---|---|---|
| ⚡ **Techno** | 135 | 4-on-the-floor kick, E Phrygian bass, driving 8th hats |
| 🧪 **Acid** | 140 | TB-303 rapid 16th bass with accent + slide, 16th hats |

---

## 💾 Save & Export

| Action | How |
|---|---|
| **Auto-save** | Every 30 s to its own key, with a rotating history (never overwrites your manual save) |
| **Manual save** | `Ctrl+S` or 💾 |
| **Save slots** | A / B / C / D in the header |
| **Load project** | 📂 → pick a `.json` file |
| **Export project** | ⬇ .json → lossless project file |
| **Export MIDI** | ⬇ .mid → standard MIDI file with program changes, track names, accents, swing and legato slides |
| **Share a pattern** | 🔗 in the generator → a URL that reproduces the exact result |

The project format is versioned (`version: 2`) with a migration path from
v1, and a corrupt or future-versioned file is rejected rather than
destroying your work.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Esc` | Stop (and close any modal) |
| `Ctrl+R` | Toggle Record |
| `Ctrl+S` | Save Project |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `G` | Generate a new pattern |
| `R` | New random seed |
| `?` | Show Shortcuts |
| `Shift+Click` step | Open step editor |
| `Right-click` step | Open step editor |

---

## 🚀 Getting Started

MusicBox is a **pure static HTML/CSS/JavaScript app** — zero build step,
zero dependencies.

```bash
git clone https://github.com/markdo27/musicbox.git
cd musicbox

# Serve it over http:// (Web MIDI needs a secure context)
npx --yes http-server -p 8080 -c-1 .
# then open http://localhost:8080
```

> **Browser requirement**: Use **Google Chrome** or **Microsoft Edge** for
> MIDI. Firefox and Safari do not implement the Web MIDI API, but the
> internal audio engine works everywhere.

---

## 🧪 Tests

```bash
npm test              # 218 tests: generator, DOM wiring, headless app smoke
npm run test:browser  #  74 tests: real headless Chrome over DevTools
npm run test:all      # 292 tests
```

| Suite | Tests | Covers |
|---|:--:|---|
| `tests/generate.test.mjs` | 67 | PRNG determinism, Bjorklund correctness, scale theory, the in-scale guarantee, drum-note validity, humanise, 32-step coverage, **16-variation determinism** |
| `tests/dom.test.mjs` | 26 | Every DOM target exists, script load order, generator + MIDI controller + FX + song wiring, CSS coverage, breakpoints |
| `tests/smoke.test.mjs` | 125 | Boot, undo/redo, generator↔sequencer, persistence round-trip, MIDI export bytes, clock behaviour, per-track routing, **MIDI Learn round trip**, **synthesis model monotonicity**, **pattern bank isolation**, **song arrangement** |
| `tests/browser.test.mjs` | 74 | Real Chrome: grid, generator, patch preview, mixer, synth + FX panel, learn flow, clock switch, **16-variation picker**, **pattern bank + song strip**, **byte-level WAV header validation**, **zero uncaught exceptions** |

---

## 📁 Project Structure

```
musicbox/
├── index.html          # App shell — panels and modals
├── css/
│   └── style.css       # Design system (paper/ink, mono, hairline rules)
├── js/
│   ├── generate.js     # ★ Generative engine — seeded, pure, testable
│   ├── presets.js      # Techno + Acid presets
│   ├── audio.js        # TR-606 drums + TB-303 acid + per-track channel strips
│   ├── sampler.js      # Strudel sample loader (namespaced, pre-fetched)
│   ├── midi.js         # Web MIDI — clock, routing, CC profiles
│   ├── midilearn.js    # ★ MIDI Learn — bidirectional, persisted
│   ├── sequencer.js    # Scheduler (absolute-time), undo/redo, bank, song
│   ├── storage.js      # Versioned projects, autosave, MIDI export
│   ├── ui.js           # Rendering — grid, generator, bank, mixer, devices
│   └── app.js          # Entry point — wiring
├── tests/              # 292 automated tests
└── docs/
    ├── AUDIT.md        # ★ Scorecard, findings, roadmap, known limitations
    ├── ENGINE.md       # ★ Synthesis + MIDI reference
    └── superpowers/
```

**Stack**: Vanilla HTML · CSS · JavaScript (ES2020) · Web MIDI API · Web Audio API
**Dependencies**: Zero (Google Fonts via CDN only)

---

## 🗺️ Roadmap

- [x] Seeded generative engine with live preview and shareable seeds
- [x] Euclidean rhythms, chord progressions, motif development, humanise
- [x] **16-variation picker** — choose instead of accept
- [x] **8-slot pattern bank + song arranger**
- [x] **WAV recording** of the master bus
- [x] Per-track MIDI output routing and Internal/MIDI/Both switching
- [x] Drift-free MIDI clock; wired device CC profiles
- [x] **MIDI Learn** — bidirectional, persisted
- [x] **Master / slave clock** — follow an external MIDI clock
- [x] **Per-track channel strip** — voice parameters + 3-band EQ, saturation, sends
- [x] Lossless versioned persistence, redo, faithful MIDI export
- [x] Responsive layout, accessibility pass, automated test suite
- [ ] LFO / modulation matrix
- [ ] NRPN + pitch bend + aftertouch
- [ ] Sidechain ducking driven by the kick pattern
- [ ] 303/606 A/B against reference recordings
- [ ] More device profiles (Elektron, Roland, Moog, Arturia)

See [`docs/AUDIT.md`](docs/AUDIT.md) for the full backlog with effort estimates
and [`docs/ENGINE.md`](docs/ENGINE.md) for the synthesis reference.

---

## 📄 License

MIT © 2026 MusicBox. See the About dialog for the commercial-use terms.
