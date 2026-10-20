/**
 * sampler.js — Strudel Sample Loader & Player
 * ---------------------------------------------------------------------------
 * Lazily fetches and caches audio files from the Dirt-Samples database.
 *
 * KEY FIX (post-audit): samples are scheduled at an ABSOLUTE AudioContext
 * time, and the buffer is pre-fetched/decoded when a category is selected.
 * The previous implementation awaited the network fetch inside the note
 * callback, so every first hit of a sample was late by a full round trip
 * and the groove never lined up with the beat.
 */

const SamplerEngine = (() => {
  let sampleMap = {};
  let baseUrl = '';
  const audioCache = new Map();    // url → AudioBuffer
  const pendingFetches = new Map(); // url → Promise<AudioBuffer>
  let initialized = false;
  let initPromise = null;
  let categoriesCache = null;

  const FETCH_TIMEOUT = 8000;

  async function init() {
    if (initialized) return true;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        const res = await fetch(
          "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json",
          { signal: controller.signal }
        );
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        baseUrl = data._base || "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/";
        sampleMap = data;
        delete sampleMap._base;
        categoriesCache = null;
        initialized = true;
        console.log(`SamplerEngine: Loaded ${Object.keys(sampleMap).length} sample categories.`);
        return true;
      } catch (err) {
        console.warn("SamplerEngine: sample database unavailable — internal synths only.", err?.message || err);
        return false;
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  }

  function isReady() { return initialized; }

  function getCategories() {
    if (!categoriesCache) categoriesCache = Object.keys(sampleMap).sort();
    return categoriesCache;
  }

  async function getAudioBuffer(ctx, url) {
    if (audioCache.has(url)) return audioCache.get(url);
    if (pendingFetches.has(url)) return pendingFetches.get(url);

    const promise = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => ctx.decodeAudioData(buf))
      .then(audioBuf => {
        audioCache.set(url, audioBuf);
        pendingFetches.delete(url);
        return audioBuf;
      })
      .catch(e => {
        console.error("SamplerEngine: Error decoding sample", url, e);
        pendingFetches.delete(url);
        return null;
      });

    pendingFetches.set(url, promise);
    return promise;
  }

  /** Resolve the file for a (category, note) pair. */
  function resolveFile(category, note) {
    const files = sampleMap[category];
    if (!files || files.length === 0) return null;

    let index = 0;
    let playbackRate = 1;

    if (files.length === 1) {
      // Single-sample category → pitch-shift from middle C.
      index = 0;
      playbackRate = Math.pow(2, (note - 60) / 12);
    } else {
      // Multi-sample category → map the note onto a file index.
      // C2 (36) is the conventional starting point for GM percussion.
      index = Math.max(0, note - 36) % files.length;
    }

    return { relPath: files[index], playbackRate };
  }

  /**
   * Play a sample at an ABSOLUTE AudioContext time.
   * @param {number} when absolute AudioContext time (defaults to now).
   */
  async function playSample(ctx, masterGain, category, note, vel, when = null) {
    if (!sampleMap[category]) return;
    const resolved = resolveFile(category, note);
    if (!resolved) return;

    const url = baseUrl + resolved.relPath;
    const buffer = await getAudioBuffer(ctx, url);
    if (!buffer) return;

    // If the buffer was not ready in time, play it as soon as possible
    // rather than dropping the hit entirely.
    const now = Math.max(when === null ? ctx.currentTime : when, ctx.currentTime);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = resolved.playbackRate;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(vel, now);
    // Smooth decay to avoid clicks
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + buffer.duration);

    src.connect(gainNode);
    gainNode.connect(masterGain);

    src.start(now);
    src.onended = () => {
      try { src.disconnect(); gainNode.disconnect(); } catch (e) {}
    };
  }

  /**
   * Pre-fetch and decode a category so the first hit is in time.
   * Call this when the user selects a sample category.
   */
  async function prefetch(ctx, category) {
    if (!ctx || !sampleMap[category]) return;
    const files = sampleMap[category];
    if (!files.length) return;
    // Prefetch up to 8 files — enough to cover a percussion map.
    const count = Math.min(files.length, 8);
    for (let i = 0; i < count; i++) {
      try {
        await getAudioBuffer(ctx, baseUrl + files[i]);
      } catch (e) { /* individual failure is non-fatal */ }
    }
  }

  function getSampleCount(category) {
    return sampleMap[category]?.length || 0;
  }

  return { init, isReady, getCategories, playSample, prefetch, getSampleCount };
})();

window.SamplerEngine = SamplerEngine;
