/**
 * sampler.js — Strudel Sample Loader & Player
 * Lazily fetches and caches audio files from the Dirt-Samples database.
 */

const SamplerEngine = (() => {
  let sampleMap = {};
  let baseUrl = '';
  let audioCache = new Map(); // url -> AudioBuffer
  let pendingFetches = new Map(); // url -> Promise<AudioBuffer>
  let initialized = false;

  async function init() {
    if (initialized) return;
    try {
      const res = await fetch("https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json");
      const data = await res.json();
      baseUrl = data._base || "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/";
      sampleMap = data;
      delete sampleMap._base;
      initialized = true;
      console.log(`SamplerEngine: Loaded ${Object.keys(sampleMap).length} sample categories.`);
    } catch (err) {
      console.error("SamplerEngine: Failed to load strudel.json", err);
    }
  }

  function getCategories() {
    return Object.keys(sampleMap).sort();
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

  async function playSample(ctx, masterGain, category, note, vel, delaySec = 0) {
    if (!sampleMap[category]) return;
    const files = sampleMap[category];
    if (files.length === 0) return;

    // Use pitch shifting if there's only 1 sample in the category (like a synth/bass patch)
    // Otherwise, map the MIDI note to an index in the sample array (like a drum machine)
    let index = 0;
    let playbackRate = 1;

    if (files.length === 1) {
      index = 0;
      // Center note is 60 (C4).
      playbackRate = Math.pow(2, (note - 60) / 12);
    } else {
      // For multi-sample categories, map note to index.
      // Note 36 (C2) is a standard starting point for drums.
      index = Math.max(0, note - 36) % files.length;
    }

    const relPath = files[index];
    const url = baseUrl + relPath;

    const buffer = await getAudioBuffer(ctx, url);
    if (!buffer) return;

    // Ensure we don't schedule in the past
    const now = Math.max(ctx.currentTime, ctx.currentTime + delaySec);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(vel, now);
    // Smooth decay to avoid clicks
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + buffer.duration);

    src.connect(gainNode);
    gainNode.connect(masterGain);
    
    src.start(now);
  }

  return { init, getCategories, playSample };
})();

window.SamplerEngine = SamplerEngine;
