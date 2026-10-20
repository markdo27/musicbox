# MusicBox — Audit & Benchmark

> Four parallel audits were run against the pre-v2 codebase (audio engine,
> MIDI + persistence, UI/UX, and a state-of-the-art research sweep), then the
> findings were fixed and re-measured. This document is the scorecard.

---

## 1. Benchmark scorecard

Scored 1–10 per dimension. **The bar is 8.0.**

| # | Dimension | Before | After | What moved it |
|---|---|:--:|:--:|---|
| D1 | **Musical quality** — does it sound like music? | 4.0 | **7.0** | Sample-accurate scheduling, correct 606 metal-noise circuit, 24 dB/oct 303 ladder, real accent envelope depth, humanise (micro-timing + velocity variance) |
| D2 | **Generative depth** — generator or dice button? | 2.0 | **7.5** | New `js/generate.js`: seeded PRNG, Euclidean rhythms, probability grammar, Markov melody, motif development (A/A′/A″/B), chord progressions, 7 genres, user-controllable root/scale/density |
| D3 | **MIDI integration** — is it actually a controller? | 2.0 | **7.0** | Drift-free AudioContext clock, per-track output routing, output-device picker, per-track Internal/MIDI/Both, wired CC device profiles, program changes, no more stuck notes |
| D4 | **Audio engine** — is the synthesis credible? | 4.0 | **7.0** | One shared AudioContext, absolute-time scheduling, voice-identity rework (no leaks, no stealing), real limiter, energy-conserving wet/dry, fixed inverted reverb decay, 303 slide portamento |
| D5 | **UX & workflow** — can a person use it? | 4.0 | **8.0** | Live-preview generator panel, seed field + share link, non-destructive per-track regeneration, real master level meter, responsive breakpoints, keyboard/a11y fixes |
| D6 | **Persistence & projects** — can you keep your work? | 3.0 | **8.0** | Lossless round-trip (audioMode, solo, MIDI routing, FX, volume, generative params), versioned format with migration, non-destructive autosave + history, faithful MIDI export |
| D7 | **Extensibility & architecture** — can this grow? | 5.0 | **8.0** | Generator registry of pure functions, instrument/effect registries, one shared event path, 150 automated tests, no dead exports |
| D8 | **Robustness, docs & verification** — would you trust it? | 3.0 | **7.5** | 4 test suites (generator, DOM wiring, headless app smoke, real headless-Chrome), honest README, known-limitations section |
| | **Average** | **3.4** | **7.5** | |

**Verdict: 3.4 → 7.5.** The 8.0 bar is not yet met; the remaining 0.5 is
D1/D3/D4 — the 303/606 emulations and the MIDI controller half need another
pass (see §5).

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
| **Persistence** | Lossless round-trip, `version: 2` with a v1 migration path, autosave on its own key with rotating history, `beforeunload` save | 6 state properties were silently lost; a version bump would have wiped every user's project within 30 s. |
| **MIDI export** | Program changes, track names, time signature, accent velocity, volume scaling, swing offsets, legato slides, muted tracks skipped | The export was structurally valid but musically wrong — an acid line exported as a piano line. |
| **UX** | Redo, real master level meter, 4 responsive breakpoints, non-destructive per-track generation, first-run seeded pattern, a11y labels and roles | |
| **Verification** | 150 automated tests: generator determinism + musical constraints, DOM wiring, headless app smoke, real headless-Chrome | |

---

## 4. Test suite

```bash
npm test              # generator + DOM wiring + headless app smoke  (130 tests)
npm run test:browser  # real headless Chrome over the DevTools protocol (20 tests)
npm run test:all      # everything (150 tests)
```

| Suite | Tests | Covers |
|---|:--:|---|
| `tests/generate.test.mjs` | 57 | PRNG determinism, Bjorklund correctness, scale theory, in-scale guarantee, drum-note validity, step schema, humanise, 32-step coverage, param clamping, chord diatonicity |
| `tests/dom.test.mjs` | 19 | Every `getElementById`/`querySelector` target exists, script load order, generator control wiring, CSS class coverage, breakpoint count, no debug spam |
| `tests/smoke.test.mjs` | 54 | Module boot, undo/redo, generator↔sequencer integration, determinism, persistence round-trip, corrupt-file rejection, MIDI export bytes, clock behaviour, per-track routing, sampler namespacing |
| `tests/browser.test.mjs` | 20 | Real Chrome: grid rendered, generator populated, preview cells, device cards, mixer, keyboard, step toggle, determinism, transport start/stop, zero uncaught exceptions |

---

## 5. What is still missing (the remaining 0.5)

Ordered by impact per hour.

| Priority | Item | Dimension | Effort | Notes |
|:--:|---|---|:--:|---|
| 1 | **MIDI Learn** — click a control, move a knob, and it maps | D3 | M | The `sendCC` path now exists; this is the UI on top of it. Persist maps in `localStorage`. |
| 2 | **External clock / slave mode** — follow an incoming `0xF8` clock and derive the tempo | D3 | M | Incoming clock is now parsed, logged and BPM-estimated; the sequencer does not yet follow it. Needs a clock-source switch. |
| 3 | **303/606 reference validation** — A/B the emulations against recordings; expose cutoff, decay, env amount and drive as real controls | D1, D4 | L | The ladder is now 24 dB/oct with a proper accent depth, but "close" is not "verified". |
| 4 | **Generate-16-variations strip** — preview 16 candidate patterns and *pick* one | D2, D5 | M | The best generative UX in the market (Ableton *Generate*, Elektron). Turns accepting into selecting. |
| 5 | **Song / arranger view** — chain patterns A→B→C across bars | D2, D6 | L | The README's own roadmap item. Needs a pattern bank first. |
| 6 | **Per-track insert FX** (EQ, saturation, chorus, sidechain) | D1, D4 | L | The FX bus is still global — a pad reverb also spaces the kick. |
| 7 | **Pattern bank** — multiple named patterns per track | D6 | M | Prerequisite for the arranger. |
| 8 | **Audio recording to WAV** via `MediaStreamDestination` | D6 | M | The app can make music but cannot capture it. |
| 9 | **Per-track LFO / modulation matrix** | D1 | L | The README roadmap item. |
| 10 | **Piano roll** for melodic composition | D5 | L | Only worth it once the generator is the primary workflow. |

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
