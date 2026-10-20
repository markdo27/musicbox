# MusicBox — Audit & Benchmark

> Four parallel audits were run against the pre-v2 codebase (audio engine,
> MIDI + persistence, UI/UX, and a state-of-the-art research sweep), then the
> findings were fixed and re-measured. A second pass closed the remaining
> gap to the 8.0 bar. This document is the scorecard.

---

## 1. Benchmark scorecard

Scored 1–10 per dimension. **The bar is 8.0.**

| # | Dimension | Before | v2.0 | v2.1 | v2.2 | What moved it |
|---|---|:--:|:--:|:--:|:--:|---|
| D1 | **Musical quality** — does it sound like music? | 4.0 | 7.0 | 7.5 | **8.0** | Sample-accurate scheduling, correct 606 metal-noise circuit, 24 dB/oct 303 ladder, accent envelope depth, humanise, per-track synth parameters, **per-track insert FX (3-band EQ, saturation, sends)** |
| D2 | **Generative depth** — generator or dice button? | 2.0 | 7.5 | 7.5 | **8.5** | Seeded PRNG, Euclidean, grammar, Markov, motif A/A′/A″/B, chord progressions, 7 genres, **16-variation picker**, **song arranger** |
| D3 | **MIDI integration** — is it actually a controller? | 2.0 | 7.0 | **8.5** | **8.5** | Drift-free AudioContext clock, per-track routing, output picker, wired CC profiles, MIDI Learn (bidirectional, persisted), master/slave clock |
| D4 | **Audio engine** — is the synthesis credible? | 4.0 | 7.0 | 7.5 | **8.0** | One AudioContext, absolute-time scheduling, voice-identity rework, real limiter, energy-conserving wet/dry, fixed inverted reverb decay, **per-track channel strips**, documented + unit-tested model |
| D5 | **UX & workflow** — can a person use it? | 4.0 | 8.0 | 8.0 | **8.5** | Live-preview generator panel, seed + share link, non-destructive per-track generation, real master meter, responsive, **choose-from-16 workflow** |
| D6 | **Persistence & projects** — can you keep your work? | 3.0 | 8.0 | 8.0 | **8.5** | Lossless round-trip, versioned format, non-destructive autosave, faithful MIDI export, **8-slot pattern bank**, **song arrangement**, **WAV recording** |
| D7 | **Extensibility & architecture** — can this grow? | 5.0 | 8.0 | 8.0 | **8.0** | Generator registry of pure functions, instrument/effect/device registries, one shared event path, 292 automated tests, no dead exports |
| D8 | **Robustness, docs & verification** — would you trust it? | 3.0 | 7.5 | 8.0 | **8.0** | 4 test suites, engine reference documentation, honest README, unit-tested synthesis model, **byte-level WAV verification** |
| | **Average** | **3.4** | **7.5** | **8.0** | **8.25** | |

**Verdict: 3.4 → 8.25.** The bar is met with margin. What remains is the
*edge* of each dimension — an approximation of a 303 ladder, a CC map for
seven devices rather than every device, and a pattern bank that is not
yet a song editor.

---

## 2. The five findings that mattered most

### 2.1 The app's own audio engine was unreachable

`js/audio.js` routed any instrument whose name matched a Strudel sample
category to the sampler **before** checking the internal engines. The
manifest contains categories literally named `drum`, `bass` and `pad` — the
same strings as the internal instrument types. So the TR-606 kit, the bass
synth and the pad synth never ran, and the kick (note 36) and the closed
hi-hat (note 42) both mapped to the *same* sample file.

*Fix:* sampler categories are now namespaced `strudel:<category>` and the
internal engines take priority. `AudioEngine.isSamplerType()` makes the
boundary explicit and testable.

### 2.2 Swing made the sequencer play at the wrong tempo

The old `_applySwing` pushed the **even** steps later and added the offset to
the *interval*, so the bar grew by up to 25 % — at swing 100 % the sequencer
played 105.6 BPM while the display said 132. The MIDI clock ran on the raw
BPM, so hardware and internal audio diverged every bar.

*Fix:* `T(k) = T₀ + k·S + (k odd ? S·swing/100 : 0)`. The bar length is now
exactly 16 steps at any swing value.

### 2.3 Notes were scheduled with `setTimeout`, not the audio clock

The scheduler computed a correct AudioContext timestamp and then threw it
away, converting it to a millisecond delay. Timer jitter of 10–50 ms is up
to **44 % of a 16th note** at 132 BPM. The README claimed "AudioContext-
accurate scheduling"; the code did not deliver it.

*Fix:* the absolute time is threaded all the way through
`_scheduleStep → triggerNote → noteOn → osc.start(t)`. `setTimeout` now only
drives the UI playhead, which is what it is good for.

### 2.4 The MIDI half sent notes to one device and never released them

`selectOutput` and `sendCC` were exported and **never called**. Per-track
`midiOutputId` was stored but never passed to `noteOn`. And a "slide" step
skipped the MIDI note-off entirely — so on real hardware every slid note
hung forever, accumulating until a Stop. Meanwhile the app *sounded* like it
was sliding, because the internal 303 engine did glide.

*Fix:* per-track routing is live, device cards are clickable, slide is
implemented as true MIDI legato (the held note is released as the next
note-on goes out), and the `DEVICE_PROFILES` CC maps are actually sent.

### 2.5 The UI lied about the state

The step-count `<select>` was never re-synced — load a 32-step project and
the grid drew 32 columns while the header said "16", then touching the
select **truncated your pattern**. The swing slider went stale after every
Randomize. The record LED stayed lit after Esc. `renderDevices()` threw a
TypeError on its *second* call (it deleted its own placeholder, then
dereferenced the null). The Note Picker modal was unreachable — no code
path opened it.

*Fix:* a single `UI.syncControls(state)` is the only place bound controls
are written, and it is called from both the full and the light state
callbacks. `renderDevices()` rebuilds cleanly.

---

## 3. What was added (new functionality)

| Area | Addition | Why |
|---|---|---|
| **Generator** | `js/generate.js` — seeded PRNG (mulberry32), 14 scales, 25 roots, 11 chord progressions, Bjorklund/Euclidean rhythms with 2-voice OR/XOR, probability-weighted grammar, Markov melody over scale degrees, motif development (A/A′/A″/B), 9 track roles, 7 genre templates, humanisation | The product is "a tool that helps create music **generatively**". Before, that was one hard-coded techno/acid template with no parameters and no reproducibility. |
| **Generator UI** | Centre-column panel with live 16-cell preview that updates as you move a slider, seed field, reroll, share-link copy, per-track "Regenerate Track" | Fills the ~400 px of dead space under the grid, and gives the user *control* instead of a black box. |
| **Reproducibility** | Same seed + same parameters ⇒ byte-identical pattern. `#seed=…&genre=…&root=…&scale=…` in the URL reproduces a shared result | Reproducibility is the definition of a generative tool. It also makes bugs reportable. |
| **Step schema** | `offset` (ms micro-timing) and `repeats` (ratchet) added | Humanise and ratchets are impossible without a schema change, and the schema is now persisted in users' browsers — better to add it now. |
| **MIDI routing** | Clickable device cards, per-track output dropdown, per-track Internal/MIDI/Both switch | The "MIDI controller" half of the vision. Without it, every track sent to whichever port happened to be enumerated first. |
| **MIDI clock** | Derived from the AudioContext with count-based pulse emission; tempo changes no longer send Stop+Start | A `setInterval` clock drifts without bound and collapses to 2.5 BPM in a background tab. |
| **MIDI CC** | Device profile registry with per-parameter curves; volume, program change and accent are actually sent | The CC table existed as decoration. Now it drives hardware. |
| **MIDI Learn** | Click the ◉ badge on any control, move a knob, it is mapped. **Bidirectional** — the app also drives the hardware. Persisted to `localStorage`. 12+ controls learnable | This is what makes it a *controller* rather than a player. |
| **Master / slave clock** | A clock-source switch. In slave mode the app stops sending its own clock, listens for `0xF8`/`0xFA`/`0xFB`/`0xFC`, estimates the tempo, and schedules every step on the **hardware's own pulse grid** | A browser tool that can only be the clock master can never truly sit inside someone else's rig. |
| **16 variations picker** | One button generates **16 candidate patches** and renders each as a canvas thumbnail of the full 8-track patch. Arrow keys to move, Enter to apply. The set is reproducible from its base seed | Turns *accepting* a dice roll into *choosing*. The best generative UX in the market (Ableton *Generate*, Elektron). |
| **Pattern bank** | 8 named slots. Click to edit a slot, right-click to save the current pattern into it. Slots never share step objects with the edit buffer | The prerequisite for composing anything longer than a bar. |
| **Song arranger** | An 8/16/32-bar timeline that chains the slots. In song mode the **arrangement** decides what sounds, so the grid can show slot B while slot A plays. Click a bar to change its slot, drag to paint | This is what turns a loop generator into something that makes *music*. |
| **WAV recording** | A **🎙 REC** button taps the master bus through an `AudioWorklet` and exports a 16-bit stereo WAV. The worklet needs a zero-gain path to the destination or the browser will not pull it | The app could make music but could not capture it. |
| **Per-track insert FX** | Every track gets a real channel strip: 3-band EQ (80 Hz shelf / 900 Hz peak / 4 kHz shelf), saturation, and its **own** delay and reverb send. The global buses still work — the per-track sends add to them | The FX bus was global, so a pad's reverb also spaced the kick. |
| **Synth parameters** | Per-track cutoff, resonance, env depth, decay, drive, glide, level and tune. The mapping is a **pure function** (`AudioEngine.voiceDesign`) so it is unit-tested rather than asserted by ear | Turns the synths from presets into instruments. |
| **Persistence** | Lossless round-trip, `version: 2` with a v1 migration path, autosave on its own key with rotating history, `beforeunload` save | 6 state properties were silently lost; a version bump would have wiped every user's project within 30 s. |
| **MIDI export** | Program changes, track names, time signature, accent velocity, volume scaling, swing offsets, legato slides, muted tracks skipped | The export was structurally valid but musically wrong — an acid line exported as a piano line. |
| **UX** | Redo, real master level meter, 4 responsive breakpoints, non-destructive per-track generation, first-run seeded pattern, a11y labels and roles | |
| **Verification** | 222 automated tests: generator determinism + musical constraints, DOM wiring, headless app smoke, real headless-Chrome | |

---

## 4. Test suite

```bash
npm test              # 218 tests: generator + DOM wiring + headless app smoke
npm run test:browser  #  74 tests: real headless Chrome over the DevTools protocol
npm run test:all      # 292 tests
```

| Suite | Tests | Covers |
|---|:--:|---|
| `tests/generate.test.mjs` | 67 | PRNG determinism, Bjorklund correctness, scale theory, in-scale guarantee, drum-note validity, step schema, humanise, 32-step coverage, param clamping, chord diatonicity, **16-variation determinism and distinctness** |
| `tests/dom.test.mjs` | 26 | Every `getElementById`/`querySelector` target exists, script load order, generator + MIDI controller + FX + song wiring, CSS class coverage, breakpoint count, no debug spam |
| `tests/smoke.test.mjs` | 125 | Module boot, undo/redo, generator↔sequencer, persistence round-trip, corrupt-file rejection, MIDI export bytes, clock behaviour, per-track routing, sampler namespacing, MIDI Learn round trip, synthesis model monotonicity, **pattern bank isolation**, **song arrangement** |
| `tests/browser.test.mjs` | 74 | Real Chrome: grid, generator, patch preview, device cards, mixer, keyboard, synth + FX panel, learn badges + learn flow, clock source switch, **16-variation picker + keyboard nav**, **pattern bank + song strip**, **byte-level WAV header validation**, zero uncaught exceptions |

> **Note on headless audio.** The browser suite launches Chrome with
> `--autoplay-policy=no-user-gesture-required`. Without it the
> `AudioContext` stays *suspended* (no user gesture), nothing renders, and
> the capture worklet never runs — the WAV test would silently pass
> against an empty file.

---

## 5. What is still missing

Ordered by impact per hour. The bar is met; this is the *edge* of each
dimension.

| Priority | Item | Dimension | Effort | Notes |
|:--:|---|---|:--:|---|
| 1 | **Reference-recording A/B** for the 303/606 — a page that plays the emulation and a reference clip side by side | D1, D4 | M | The synthesis model is now documented ([`ENGINE.md`](ENGINE.md)) and unit-tested. What it is not is *validated* against the hardware. |
| 2 | **LFO / modulation matrix** — any parameter driven by any LFO, per track | D1 | L | The README roadmap item. The per-track channel strip is the right place to hang it. |
| 3 | **NRPN + pitch bend + aftertouch** for devices with >128 parameters | D3 | M | The profile registry already has the structure; the message types are not sent. |
| 4 | **Song editor** — section markers, per-bar slot editing, a song length that is not a power of two | D2, D6 | M | The arranger plays an arrangement; it does not yet *edit* one like a DAW timeline. |
| 5 | **Sidechain ducking** driven by the known kick pattern | D1, D4 | M | The kick pattern is known, so the ducking envelope can be derived from it. |
| 6 | **More device profiles** — Elektron, Roland, Moog, Arturia | D3 | M | The registry is a table; adding a device is editing a table. |
| 7 | **Plugin-style instrument modules / wavetable editor** | D7 | L | Extensibility. The current synths cover Techno/Acid well. |
| 8 | **Mobile / touch layout** — collapsible drawers, snap-scrolling step grid | D5 | L | The breakpoints exist; the drawers are not wired. |
| 9 | **Cloud sync / multi-device projects** | D6 | L | Low value for a single-user tool. |

**Delivered since the first pass:** MIDI Learn, external/slave clock,
per-track synth parameters, per-track insert FX, the 16-variation picker,
the pattern bank, the song arranger, WAV recording, the engine reference
documentation, and the unit-tested synthesis model.

---

## 6. Known limitations (honest list)

- **Chrome/Edge only for MIDI.** Firefox and Safari do not implement the
  Web MIDI API. The app still works for internal audio there.
- **`MIDIOutput.send(data, timestamp)` is unreliable.** The spec allows an
  absolute timestamp; Chromium is widely reported to send immediately
  instead. MIDI note timing is therefore still timer-accurate, not
  sample-accurate, even though the internal audio is sample-accurate.
- **Background tabs.** Chrome clamps page timers to ≥1 s in hidden tabs.
  The clock derives its pulse *count* from the AudioContext, so the average
  tempo stays correct, but a hidden tab will burst the backlog on return
  rather than play cleanly in the background.
- **Sample latency on first hit.** Sampler categories are pre-fetched when
  selected, but a sample chosen and played within the same second can still
  arrive late.
- **Probability and humanise cannot be represented in a Standard MIDI
  File.** The export writes the pattern, not the generative parameters —
  the `.json` project file is the lossless format.
- **The 303 filter is an approximation.** A cascaded-biquad ladder, not a
  transistor-level Moog ladder. It is audibly closer than a single biquad,
  but it is not the real thing.
- **The generator is rule-based, not a learned model.** That is a
  deliberate choice: it is reproducible, inspectable and free of a model
  download. Magenta RealTime 2 (June 2026) shows where the ceiling is, but
  it generates *audio*, not MIDI, so it cannot drive a TD-3.
