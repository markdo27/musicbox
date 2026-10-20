# MusicBox — Engine Reference

How the internal synthesis maps to the hardware it emulates, and how the
MIDI controller half talks to external gear.

---

## 1. TB-303 Acid Bass

### Signal path

```
saw (1×)  ──┐
             ├─► mix 70/30 ─► LP1 ─► LP2 ─► drive ─► VCA ─► track gain
square (1×) ─┘ (sub, -1 oct)   24 dB/oct       (asym)
```

### Parameter mapping

The parameters are **per track** and exposed in the SYNTH panel. The
mapping is a pure function — `AudioEngine.voiceDesign(params, accent,
kind)` — so it is unit-tested (`tests/smoke.test.mjs`) rather than
asserted by ear.

| Control | Range | Maps to | Formula |
|---|---|---|---|
| **Cutoff** | 0–1 | base filter frequency | `180 + cutoff × 1400` Hz (acid) · `200 + cutoff × 1800` Hz (bass/lead) · `200 + cutoff × 2600` Hz (pad) |
| **Env** | 0–1 | filter **envelope depth** (the 303's ENV AMOUNT) | `peak = base × (1 + env × 8)` |
| **Accent** | — | envelope depth **and** level | `peak × 1.6` · amplitude `× 1.45` (+3 dB) |
| **Reso** | 0–1 | filter Q | `0.7 + resonance × 16` (≈ Q 8 at the default 0.45) |
| **Decay** | 0–1 | filter envelope decay time | `0.04 + decay × 1.2` s time constant |
| **Drive** | 0–1 | output saturation | `tanh(x × (1 + drive × 14))`, asymmetric (×0.7 on the negative half) — the 303's output stage is not symmetric |
| **Glide** | 0–1 | portamento time | `0.008 + glide × 0.12` s time constant |
| **Level** | 0–1 | output gain | direct |
| **Tune** | −12…+12 | pitch offset | semitones, applied to every oscillator |

### Behaviours

- **Slide** is a *source* property: a step flagged `slide` glides into the
  **next** note on the same channel+track. The voice's oscillators glide
  with `setTargetAtTime` and the amplitude envelope is **not** retriggered,
  so there is no click and no re-attack.
- **Accent** opens the filter envelope *deeper*, not just louder. This is
  the difference between a 303 accent and a volume bump.
- The amplitude envelope has a **decay to sustain** (62 % of the peak), so
  the 303 articulates instead of droning at full level.
- The filter envelope is **decay-only** — there is no sustain stage, which
  is how a 303 behaves.

### Where it is approximate

The real 303 filter is a four-pole transistor ladder with per-stage
nonlinearity and self-oscillation at high resonance. This implementation
cascades two 12 dB/oct biquads (24 dB/oct total), which is close to the
303's 18 dB/oct and far steeper than a single biquad, but it is not the
real circuit. At `Reso` above 0.85 the emulation will not self-oscillate
the way the hardware does.

---

## 2. TR-606 Drum Kit

### The metal circuit

The 606's hi-hat and cymbal share a six-oscillator metal-noise chip. The
oscillators are **inharmonic and low** — the "bright squares" in most
emulations are what give you an 808 buzz instead of a 606 hum.

| Oscillator | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Frequency (Hz) | 246.4 | 308.0 | 367.0 | 418.2 | 440.4 | 627.2 |

The bank feeds a **9 kHz band-pass** (hi-hat) or a **5.5 kHz band-pass**
(cymbal), plus a 7 kHz high-pass on the hat.

### Voices

| Note | Voice | Synthesis | Decay control |
|---|---|---|---|
| 36 | Kick | sine 180 → 30 Hz over 400 ms, soft-clip waveshaper, 3 kHz click transient | `0.5 s × decayScale` |
| 38 | Snare | sine 220 → 110 Hz body (60 %) + 2.5 kHz band-passed noise (40 %) | `0.18 s × decayScale` |
| 42 | HH closed | 6 inharmonic oscillators → 9 kHz band-pass | `0.06 s × decayScale` |
| 46 | HH open | same bank, long decay | `0.35 s × decayScale` |
| 39 | Clap | 4 noise bursts at 0 / 3 / 6 / 10 ms, 1.8 kHz band-pass | fixed |
| 49 | Crash | separate 6-oscillator cymbal bank → 5.5 kHz band-pass | 1.2 s |
| 51 | Ride | 3 bell partials (4 / 6.2 / 8.8 kHz) | 0.5 s |
| 37 | Rim | 1.6 kHz square, 50 ms | fixed |
| 41–50 | Toms | sine with a pitch drop | 0.35 s |

**Tune** (±12 semitones) transposes the whole voice — the 606's tuning
pots. **Decay** scales the decay time of the kick, snare and hats.

---

## 3. Master Bus

```
track gain[0..7] ──► master gain ──┬──► dry ──────────────┐
                                    ├──► ping-pong delay ──┤
                                    └──► reverb ──────────┤
                                                              ▼
                        DC block (18 Hz HP) ─► limiter ─► soft clip ─► out
```

- **Limiter**: `DynamicsCompressor`, threshold −1.5 dB, ratio 20, knee 0,
  attack 1 ms, release 50 ms. The previous −18 dB / 4:1 setting did not
  actually limit — eight tracks could exceed 0 dBFS and clip.
- **Soft clip**: a `tanh` waveshaper at 2× oversampling as a safety net.
- **DC block**: an 18 Hz high-pass keeps the sub bass from drifting the
  master.
- **Wet/dry is energy-conserving**: `dry = 1 − (reverb + delay) × 0.5`,
  `wet = mix × 0.9`. Turning reverb up does not make the bus louder.
- **Reverb decay maps monotonically** to comb feedback:
  `0.55 + 0.41 × (t − 0.3) / 9.7`, clamped to 0.96. The previous mapping
  was inverted — a *longer* "decay" produced a *shorter* tail.

### Reverb topology

Free-feedback comb filters (29 / 37 / 41 / 43 ms) summed into two true
Schroeder allpasses (5 / 1.7 ms), built from delay + feedback +
feedforward — not biquads, which cannot produce true allpass phase.

---

## 3a. Per-track channel strips

Every track has its own strip. The global delay and reverb are still fed
by the master, so the master send behaves as before; the per-track sends
**add** to them, the way a DAW's global bus and per-track sends coexist.

```
voice ──► EQ low ──► EQ mid ──► EQ high ──► saturation ──► track gain ──┬──► master
                                                                       ├──► delay send  ──► delay bus
                                                                       └──► reverb send ──► reverb bus
```

| Control | Range | Filter | Frequency |
|---|---|---|---|
| **EQ low** | −12…+12 dB | low shelf | 80 Hz |
| **EQ mid** | −12…+12 dB | peaking, Q 0.9 | 900 Hz |
| **EQ high** | −12…+12 dB | high shelf | 4 kHz |
| **Sat** | 0–1 | `tanh(x × (1 + drive × 18))` waveshaper, 2× oversampled | — |
| **Dly / Rev** | 0–1 | send level to the shared buses | — |

The **track gain** (the mixer fader) sits *after* the strip, so the
insert FX are pre-fader — which is what a hardware channel strip does.

The saturation curve is rebuilt only when the amount changes, not per
note, so a busy pattern does not allocate a `Float32Array` per hit.

---

## 3b. Recording to WAV

The **🎙 REC** button taps the master bus and exports a 16-bit stereo WAV.

- The tap is an **`AudioWorklet`**, not a `ScriptProcessor` — the latter
  runs on the main thread and glitters under load.
- The worklet is connected to a **zero-gain sink** that reaches the
  destination. This is required: a node that is not connected to the
  destination is not pulled by the rendering thread, and the worklet would
  never be called. The sink contributes nothing audible.
- The worklet's input is `channelCount: 2`, `channelCountMode: 'explicit'`,
  so the file is a standard stereo WAV.
- Samples are collected per render quantum and merged on stop, then
  encoded to a 44-byte RIFF header plus 16-bit interleaved PCM.

The header is verified byte-for-byte in `tests/browser.test.mjs`:
`RIFF`/`WAVE`/`fmt ` magic, the channel count, the sample rate, the bit
depth, the data-chunk size, and that the file length matches the header.

> **Headless testing note.** The browser suite launches Chrome with
> `--autoplay-policy=no-user-gesture-required`. Without it the
> `AudioContext` stays *suspended* (no user gesture), nothing renders, and
> the capture worklet never runs — the WAV test would silently pass
> against an empty file.

---

## 4. MIDI Controller Half

### Clock

The outgoing clock is derived from the **AudioContext**, not a page timer.

```
pulseCount = floor(elapsedAudioTime × bpm/60 × 24)
```

The scheduler emits `pulseCount − pulsesSent` pulses on each tick, so the
*pulse count* is a function of elapsed audio time. The average tempo is
therefore exact over any window — there is no accumulating drift.

This matters because a `setInterval` clock drifts without bound (1 ms of
timer lateness at 132 BPM is a permanent 5 % tempo error) and collapses to
2.5 BPM in a background tab, where Chrome clamps page timers to ≥1 s.

A tempo change re-times the pulse train. It does **not** send Stop+Start,
which would reset the song position on every hardware slave.

### Slave mode (external clock)

Select **CLOCK → External** in the MIDI panel. MusicBox then:

1. stops sending its own clock,
2. listens for incoming `0xF8` (clock), `0xFA` (start), `0xFB` (continue)
   and `0xFC` (stop),
3. estimates the tempo from the mean pulse interval over a 48-pulse window,
4. schedules each step on the **hardware's own pulse grid**:

```
t(k) = lastPulseTime − (pulses − k) × pulseDuration
```

Step *j* starts at pulse *j × 6* (24 PPQN → 6 pulses per 16th note), so
the app lands on the same grid as the hardware rather than merely at the
same average tempo.

Swing is **not** applied in slave mode — the hardware owns the timing.

### MIDI Learn

Any control marked `data-learn` in the markup can be bound to a hardware
control:

1. Click the ◉ badge next to the control.
2. Move a knob on the device.
3. The control is mapped. The badge shows the CC number.

The mapping is **bidirectional** — moving the control in the app also
moves the hardware — and is persisted to `localStorage`.

The value range comes from the element itself, so a `<input type="range">`
and a `<select>` both work with no extra wiring. A `<select>` maps the CC
onto the option index.

### Device profiles

`js/midi.js` holds a profile registry. Each profile declares how to
identify the device, and which CCs map to which internal parameters.

| Device | Match | Clock | CC map |
|---|---|:---:|---|
| **TD-3** | `/td-?3/i` | — | cutoff 74, resonance 71, envMod 79, accent 65, decay 80 |
| **Crave** | `/crave/i` | — | cutoff 74, resonance 71, glide 5 |
| **Edge** | `/edge/i` | — | cutoff 74 |
| **Model D** | `/model\s?d/i` | — | cutoff 74, resonance 71, glide 5, volume 7 |
| **Neutron** | `/neutron/i` | — | cutoff 74, resonance 71, drive 30, oscMix 31 |
| **RD-6** | `/rd-?6/i` | ✅ | — |
| **RD-8** | `/rd-?8/i` | ✅ | — |

CC values are shaped per parameter: `exp` curve (squared) for frequency
parameters, `lin` for everything else — a linear cutoff sweep sounds
wrong, a linear resonance sweep does not.

### Per-track routing

Each track carries an `audioMode` (`both` / `internal` / `midi`) and a
`midiOutputId` (which device it talks to). A track can therefore drive a
drum machine while another drives a bass synth, and a track can be
muted from the internal synth without touching the MIDI output.

### Slide as legato

A slide step does **not** suppress the MIDI note-off. Instead the held
note is released at the instant the next note-on goes out — the standard
MIDI legato encoding, and the thing that actually triggers a hardware
glide circuit. (The previous implementation skipped the note-off
entirely, so every slid note hung on the hardware forever.)

---

## 5. Timing model

| Layer | Clock | Accuracy |
|---|---|---|
| Internal audio | `AudioContext.currentTime` | Sample-accurate — notes are scheduled at absolute times, never via `setTimeout` |
| MIDI notes | Page timer | Timer-accurate (Chrome ignores the timestamped `send()`) |
| MIDI clock out | `AudioContext.currentTime` | Exact pulse count — no drift |
| MIDI clock in | `performance.now()` + event timestamp | Sub-millisecond phase |

### Swing

```
T(k) = T₀ + k·S + (k odd ? S·swing/100 : 0)
```

The bar is always exactly 16 steps, at any swing value. The previous
implementation applied *reverse* swing and lengthened the bar by up to
25 %, so the sequencer played 105.6 BPM while the display said 132 — and
the MIDI clock, running on the raw BPM, diverged from the internal audio
every bar.

### Ratchet and micro-timing

- **Repeats** (1–8) split a step into that many evenly spaced hits.
- **Offset** (±50 ms) shifts a step off the grid. It is applied in the
  scheduler, before the note is scheduled, so it is sample-accurate
  rather than a jitter applied after the fact.

---

## 7. Pattern bank & song arranger

The bank holds **8 slots**. Each slot is a full 8-track pattern.

- Slots and the edit buffer are **deep-copied** in both directions, so
  editing one can never mutate another. (A shared-reference bug here
  would silently corrupt a saved pattern.)
- The edit buffer is `state.tracks`; the scheduler reads
  `_activeTracks(absIndex)`:
  - song mode **off** → the edit buffer plays;
  - song mode **on** → the slot the arrangement assigns to that bar plays.

The bar is derived from the **absolute step index being scheduled**, not
from the transport position, so the look-ahead window does not play the
previous bar's slot over the bar line.

The arrangement is a list of slot indices, one per bar, and resizing it
(8 / 16 / 32 bars) preserves the bars that were already there.

---

## 8. Verification

The synthesis model is a pure function, so it can be tested without
rendering audio:

```bash
npm test
```

`tests/smoke.test.mjs` asserts that:

- accent opens the filter further (and does not change the base cutoff
  or the resonance),
- cutoff, resonance, envelope depth, decay time and portamento time are
  all monotonic in their parameter,
- the filter peak stays bounded,
- the pad and lead voices use their own cutoff spans,
- the MIDI Learn round trip is lossless,
- the clock source switch stops the outgoing clock.

`tests/browser.test.mjs` additionally drives the real app in headless
Chrome and asserts the parameter panel, the learn badges and the clock
switch behave as documented above — and validates the WAV header byte
for byte.
