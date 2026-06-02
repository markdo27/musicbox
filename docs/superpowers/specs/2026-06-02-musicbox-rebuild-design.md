# MusicBox Rebuild — Design Spec
**Date:** 2026-06-02  
**Focus:** Techno + Acid · Authentic synthesis · Hardware-first MIDI  
**Approach:** B — Authentic Emulation + Hardware Sync

---

## Context & Problem Statement

MusicBox is a browser-native step sequencer using Web Audio API and Web MIDI API.  
Current pain points identified:

1. **Audio engine sounds synthetic and unconvincing** — drum and bass synthesis does not authentically represent the target genres
2. **Patterns are musically random** — presets do not encode real genre rhythm/theory, so output does not sound like Techno or Acid
3. **Functions feel disjointed** — modules call each other directly with no clear layer boundaries
4. **7 genres, all mediocre** — too broad, not deep enough

**Decision:** Narrow focus to **Techno + Acid only**. Do them right.

---

## Goals

- Built-in audio engine sounds convincingly like TR-606 (drums) and TB-303 (acid bass)
- Patterns encode correct rhythm theory for Techno and Acid
- MIDI sends correctly to user's hardware: RD-6, TD-3, Crave, Edge
- App works standalone (internal audio) and with hardware (MIDI out) — switchable per track
- Architecture has clear layer separation — no cross-module direct calls

---

## Part 1 — Architecture

Three layers, all communicating through `app.js`:

```
┌─────────────────────────────────────┐
│  UI Layer        ui.js              │  render + user input only
├─────────────────────────────────────┤
│  Engine Layer                       │
│  ├── sequencer.js  (mostly unchanged)│
│  ├── audio.js      (rebuilt)        │
│  └── midi.js       (device profiles)│
├─────────────────────────────────────┤
│  Data Layer                         │
│  ├── presets.js    (rebuilt)        │
│  └── storage.js    (unchanged)      │
└─────────────────────────────────────┘
```

**Rule:** No module imports another module directly. All cross-layer communication goes through `app.js` event wiring. This eliminates the tangled dependency graph.

**Scope:** Targeted refactor + rebuild. `sequencer.js` and `storage.js` preserved. `audio.js`, `presets.js`, `midi.js` rebuilt. `ui.js` reorganized.

---

## Part 2 — Audio Engine Rebuild (`audio.js`)

### TR-606 Drum Engine

Replaces current generic synthesis with 606-authentic character — matching the RD-6 hardware the user owns.

| Sound | Method |
|---|---|
| **Kick** | Sine pitch envelope 180→30Hz over 400ms, soft distortion clip |
| **Snare** | Tuned noise (bandpass 200Hz) + sine body (180Hz), sharp transient |
| **Hi-Hat Closed** | 6 detuned FM operators, highpass 8kHz, tight 40ms gate |
| **Hi-Hat Open** | Same oscillator bank, 300ms exponential decay, filter sweep |
| **Clap** | 4 noise bursts at 0ms / 3ms / 6ms / 10ms offsets, reverb tail |
| **Rim / Cowbell** | FM metallic tone — characteristic 606 sound |

### TB-303 Bass Engine

The core of Acid. Current sawtooth implementation replaced entirely.

- **Oscillator:** Sawtooth and Square (switchable per track), sub-octave option (-1 oct)
- **Filter:** 18dB/oct lowpass with resonance 0–100. Above 80% resonance: self-oscillation (the "squelch")
- **Envelope:** Attack 1ms, Decay sweeps filter cutoff from open→base over 50–400ms (user-adjustable)
- **Accent:** When a step has `accent: true` → filter cutoff opens fully + +6dB volume boost → "wah" transient
- **Slide:** When a step has `slide: true` → previous note is NOT cut; pitch glides to new note over 60ms (portamento). This is implemented by sending note-on before note-off of previous step.

**Per-step data additions:** Two new boolean fields on each step object:
```js
{ on: true, note: 'A2', velocity: 80, gate: 0.5, probability: 1.0, accent: false, slide: false }
```

### Monosynth Engine (Lead / Crave / Edge style)

- Sawtooth primary oscillator with slight pulse-width modulation (±5%)
- 24dB/oct lowpass filter approximation (Moog ladder style)
- Glide/portamento: 0–200ms
- ADSR: Attack 5ms, Decay 200ms, Sustain 60%, Release 300ms (defaults)
- Sufficient for Techno lead lines and ambient pad layers

---

## Part 3 — Preset Rebuild (`presets.js`)

Presets reduced from 7 genres to **2 core genres** with musically correct patterns.

### ⚡ Techno — BPM 135

```
Track 1 · Kick    [x . . . x . . . x . . . x . . .]
Track 2 · Snare   [. . . . x . . . . . . . x . . .]
Track 3 · Clap    [. . . . x . . . . . . . x . . x]  ← ghost 16th
Track 4 · HH Cls  [x . x . x . x . x . x . x . x .]  ← 8th note drive
Track 5 · HH Opn  [. . . . . . . . . . . . . . x .]  ← bar-end breath
Track 6 · 303 Bass[x . . x . . x . . . x . . . . .]  ← syncopated
Track 7 · Lead    [. . . . . . . . x . . . . x . .]  ← sparse
Track 8 · Pad     [x . . . . . . . x . . . . . . .]  ← long gate
```

- **Scale:** E Phrygian (E F G A B C D) — dark, industrial character
- **Bass notes:** Root, b2, b7 — avoids major intervals
- **Rule:** Kick and bass accent never share the same step (avoids mud)

### 🧪 Acid — BPM 140

```
Track 1 · Kick    [x . . . x . . . x . . . x . . .]
Track 2 · Snare   [. . . . x . . . . . . . x . . .]
Track 3 · HH Cls  [x x x x x x x x x x x x x x x x]  ← 16th driving
Track 4 · HH Opn  [. . . . . . . x . . . . . . . x]  ← off-beat
Track 5 · 303 #1  [x x . x x . x . x x . x . x x .]  ← classic acid rhythm, accent+slide
Track 6 · 303 #2  [. . x . . x . x . . x . x . . x]  ← counter-line
Track 7 · Lead    [. . . . . . . . . . x . . . x .]
Track 8 · Pad     [x . . . . . . . . . . . . . . .]
```

- **Scale:** A minor / A Phrygian
- **303 tracks:** accent on downbeats, slide between consecutive active steps
- **Characteristic density:** 303 uses more 16th notes than Techno bass — this is intentional

### Randomize — Genre-Aware

Replaces current pure-random logic:
1. Kick pattern is preserved (rhythm backbone)
2. New notes drawn only from the genre's scale — no out-of-scale random notes
3. Hi-hat and clap get probability variation (70–100%) — adds feel without breaking groove
4. 303 accent/slide flags randomized with weighted bias (accent: 30%, slide: 25%)

---

## Part 4 — MIDI Hardware Profiles (`midi.js`)

### Default Routing

| Track | Internal Engine | Hardware Target | MIDI Ch |
|---|---|---|---|
| Kick / Snare / Hat / Clap | TR-606 drums | **RD-6** | 10 |
| 303 Bass #1 | TB-303 engine | **TD-3** | 1 |
| 303 Bass #2 | TB-303 engine | **TD-3** | 1 |
| Lead | Monosynth | **Crave** | 2 |
| Pad | Monosynth | **Edge** | 3 |

User can override routing via dropdown per track in the Device Panel.

### Device Profiles

**RD-6**
- Auto-detected by device name string match
- Receives: MIDI Clock, Start, Stop
- Drum note mapping: Kick=36, Snare=38, HH Closed=42, HH Open=46, Clap=39, Rim=37, Cowbell=56

**TD-3** *(most important)*
- Receives: Note On/Off on Ch 1 with velocity
- **Slide implementation:** Next note's Note-On sent before current note's Note-Off (overlap triggers internal TD-3 slide)
- **Accent implementation:** Accent steps use velocity ≥ 100; non-accent steps use velocity from step editor (default 64)
- CC 74 = Cutoff, CC 71 = Resonance (available for future automation)

**Crave**
- Monophonic notes on Ch 2
- CC 74 = Cutoff, CC 71 = Resonance, CC 5 = Glide rate

**Edge**
- Notes on Ch 3
- CC 74 = Cutoff (pad sweep)

### Dual Mode (Internal + Hardware)

Per-track toggle: `🔊 Internal` / `📡 MIDI Only` / `🔀 Both`

- Default when no hardware: `Internal`
- Default when hardware detected: `Both`
- Switching does not interrupt playback

---

## Part 5 — UI Reorganization (`ui.js`)

### Layout

```
┌─────────────────────────────────────────────────────┐
│  HEADER: BPM · ▶ Play · ■ Stop · Swing · 💾 · MIDI  │
├──────────┬──────────────────────────────┬────────────┤
│          │                              │            │
│  TRACK   │     STEP GRID (main)         │  DEVICE    │
│  PANEL   │     16 / 32 steps            │  PANEL     │
│          │                              │            │
│  🥁 Kick │  [■][ ][■][ ][ ][■][ ][ ]  │  RD-6  ✓  │
│  🎸 303  │  [■][■][ ][■][■][ ][■][ ]  │  TD-3  ✓  │
│  🎹 Lead │  [ ][ ][ ][■][ ][ ][ ][■]  │  Crave ✓  │
│  🌊 Pad  │  [■][ ][ ][ ][ ][ ][ ][ ]  │  Edge  ✓  │
│          │                              │            │
│  [+ ADD] │                              │            │
├──────────┴──────────────────────────────┴────────────┤
│  BOTTOM: [⚡ Techno] [🧪 Acid] · [🎲 Randomize]      │
└─────────────────────────────────────────────────────┘
```

### Track Panel (left)
- Track name + instrument icon + small volume fader + mute/solo buttons
- Click track name → inline instrument editor (no separate popup)
- Icons: 🥁 Drum · 🎸 303 Bass · 🎹 Lead · 🌊 Pad

### Step Grid (center)
- Steps larger and easier to click (minimum 36px × 36px)
- Accent steps: bright amber color
- Slide steps: small arrow indicator on right edge of step
- Playing step: clear moving highlight, no flicker
- Right-click / Shift+click → step editor with: Note · Velocity · Gate · Probability · **Accent · Slide**

### Device Panel (right)
- Named device cards: RD-6, TD-3, Crave, Edge
- Each card shows: connected status · MIDI channel · audio mode toggle (Internal / MIDI / Both)
- No hardware connected: panel shows "Preview mode — internal audio active" with soft prompt

### Bottom Bar
- Preset selector: 2 buttons only — `⚡ Techno` and `🧪 Acid`
- `🎲 Randomize` — genre-aware (see Part 3)
- Remove: Deep House, Breaks, Minimal, Industrial, Tech House presets (can re-add later)

---

## Out of Scope (Roadmap, not this spec)

- CC Automation lanes
- LFO engine
- Piano Roll
- Song / Pattern arranger
- MIDI Learn
- Mobile touch UI
- Cloud sync

---

## Verification Plan

1. **Audio:** Play Techno preset — kick must be deep and punchy, 303 must squelch on accent steps
2. **Acid slide:** Two consecutive active 303 steps with slide enabled — pitch must glide, not re-trigger
3. **Hardware:** Connect TD-3 → play Acid preset → TD-3 must receive slide and accent correctly
4. **Randomize:** Run 10 randomizations — all notes must stay in scale, kick pattern must be preserved
5. **UI:** All 8 tracks visible simultaneously without horizontal scroll on 1366×768 viewport
