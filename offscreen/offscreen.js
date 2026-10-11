const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const RAMP = 0.005;

let audioCtx = null;
let sourceNode = null;
let chain = null;
let audioEl = null;
let currentSettings = null;

// ── Audio chain builder ───────────────────────────────────────────────────────

function createBypassPair(ctx) {
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = 1;
  wet.gain.value = 0;
  return { dry, wet };
}

function setBypass(dry, wet, bypass, ctx) {
  const now = ctx.currentTime;
  dry.gain.setTargetAtTime(bypass ? 1 : 0, now, RAMP);
  wet.gain.setTargetAtTime(bypass ? 0 : 1, now, RAMP);
}

async function buildChain(ctx, destination, settings) {
  // Input gain (boost)
  const inputGain = ctx.createGain();
  inputGain.gain.value = settings.gain;

  // ── Noise Gate ──────────────────────────────────────
  const ngBypass = createBypassPair(ctx);
  const ngMixer = ctx.createGain();
  let noiseGateNode = null;

  try {
    const workletUrl = chrome.runtime.getURL('worklets/noise-gate-processor.js');
    await ctx.audioWorklet.addModule(workletUrl);
    const ng = settings.noiseGate;
    noiseGateNode = new AudioWorkletNode(ctx, 'noise-gate-processor', {
      processorOptions: { threshold: ng.threshold, attack: ng.attack, release: ng.release }
    });
    ngBypass.wet.connect(noiseGateNode);
    noiseGateNode.connect(ngMixer);
  } catch {
    ngBypass.wet.connect(ngMixer);
  }

  inputGain.connect(ngBypass.dry);
  inputGain.connect(ngBypass.wet);
  ngBypass.dry.connect(ngMixer);
  setBypass(ngBypass.dry, ngBypass.wet, !settings.noiseGate.enabled, ctx);

  // ── EQ ──────────────────────────────────────────────
  const eqFilters = EQ_FREQS.map((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    f.frequency.value = freq;
    f.gain.value = settings.eq.bands[i];
    f.Q.value = 1.41;
    return f;
  });

  const eqBypass = createBypassPair(ctx);
  const eqMixer = ctx.createGain();

  ngMixer.connect(eqBypass.dry);
  ngMixer.connect(eqBypass.wet);
  eqBypass.wet.connect(eqFilters[0]);
  eqFilters.reduce((a, b) => { a.connect(b); return b; });
  eqFilters[eqFilters.length - 1].connect(eqMixer);
  eqBypass.dry.connect(eqMixer);
  setBypass(eqBypass.dry, eqBypass.wet, !settings.eq.enabled, ctx);

  // ── Compressor ──────────────────────────────────────
  const compNode = ctx.createDynamicsCompressor();
  const cs = settings.compressor;
  compNode.threshold.value = cs.threshold;
  compNode.ratio.value = cs.ratio;
  compNode.attack.value = cs.attack;
  compNode.release.value = cs.release;
  compNode.knee.value = 6;

  const compBypass = createBypassPair(ctx);
  const compMixer = ctx.createGain();

  eqMixer.connect(compBypass.dry);
  eqMixer.connect(compBypass.wet);
  compBypass.wet.connect(compNode);
  compNode.connect(compMixer);
  compBypass.dry.connect(compMixer);
  setBypass(compBypass.dry, compBypass.wet, !cs.enabled, ctx);

  // ── Limiter ──────────────────────────────────────────
  const limiterNode = ctx.createDynamicsCompressor();
  limiterNode.threshold.value = -1;
  limiterNode.ratio.value = 20;
  limiterNode.attack.value = 0.001;
  limiterNode.release.value = 0.05;
  limiterNode.knee.value = 0;

  const limBypass = createBypassPair(ctx);
  const limMixer = ctx.createGain();

  compMixer.connect(limBypass.dry);
  compMixer.connect(limBypass.wet);
  limBypass.wet.connect(limiterNode);
  limiterNode.connect(limMixer);
  limBypass.dry.connect(limMixer);
  setBypass(limBypass.dry, limBypass.wet, !settings.limiter.enabled, ctx);

  // ── Mono (downmix stereo → L=R=0.5*(L+R)) ────────────
  const monoSplitter = ctx.createChannelSplitter(2);
  const monoSum = ctx.createGain();
  monoSum.gain.value = 0.5;
  const monoMerger = ctx.createChannelMerger(2);
  monoSplitter.connect(monoSum, 0);
  monoSplitter.connect(monoSum, 1);
  monoSum.connect(monoMerger, 0, 0);
  monoSum.connect(monoMerger, 0, 1);

  const monoBypass = createBypassPair(ctx);
  const monoMixer = ctx.createGain();

  limMixer.connect(monoBypass.dry);
  limMixer.connect(monoBypass.wet);
  monoBypass.wet.connect(monoSplitter);
  monoMerger.connect(monoMixer);
  monoBypass.dry.connect(monoMixer);
  setBypass(monoBypass.dry, monoBypass.wet, !settings.mono?.enabled, ctx);

  // ── Output Volume ────────────────────────────────────
  const outputGain = ctx.createGain();
  outputGain.gain.value = settings.volume / 100;
  monoMixer.connect(outputGain);
  outputGain.connect(destination);

  return {
    ctx,
    input: inputGain,
    inputGain,
    outputGain,
    eqFilters,
    eqBypass,
    compNode,
    compBypass,
    limiterNode,
    limBypass,
    monoBypass,
    ngBypass,
    noiseGateNode
  };
}

function applySettings(settings, chain) {
  const { ctx } = chain;
  const now = ctx.currentTime;

  chain.inputGain.gain.setTargetAtTime(settings.gain, now, RAMP);
  chain.outputGain.gain.setTargetAtTime(settings.volume / 100, now, RAMP);

  if (settings.eq) {
    setBypass(chain.eqBypass.dry, chain.eqBypass.wet, !settings.eq.enabled, ctx);
    settings.eq.bands.forEach((db, i) => {
      chain.eqFilters[i].gain.setTargetAtTime(db, now, RAMP);
    });
  }

  if (settings.compressor) {
    const cs = settings.compressor;
    setBypass(chain.compBypass.dry, chain.compBypass.wet, !cs.enabled, ctx);
    chain.compNode.threshold.setTargetAtTime(cs.threshold, now, RAMP);
    chain.compNode.ratio.setTargetAtTime(cs.ratio, now, RAMP);
    chain.compNode.attack.setTargetAtTime(cs.attack, now, RAMP);
    chain.compNode.release.setTargetAtTime(cs.release, now, RAMP);
  }

  if (settings.limiter) {
    setBypass(chain.limBypass.dry, chain.limBypass.wet, !settings.limiter.enabled, ctx);
  }

  if (settings.mono) {
    setBypass(chain.monoBypass.dry, chain.monoBypass.wet, !settings.mono.enabled, ctx);
  }

  if (settings.noiseGate) {
    const ng = settings.noiseGate;
    setBypass(chain.ngBypass.dry, chain.ngBypass.wet, !ng.enabled, ctx);
    if (chain.noiseGateNode) {
      chain.noiseGateNode.port.postMessage({
        threshold: ng.threshold,
        attack: ng.attack,
        release: ng.release
      });
    }
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────

async function startProcessing(streamId, settings) {
  stopProcessing();

  currentSettings = settings;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioCtx = new AudioContext();
  await audioCtx.resume();

  // Route to <audio> element for reliable playback
  const dest = audioCtx.createMediaStreamDestination();
  chain = await buildChain(audioCtx, dest, settings);

  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(chain.input);

  audioEl = document.createElement('audio');
  audioEl.srcObject = dest.stream;
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  await audioEl.play().catch(() => {});
}

function stopProcessing() {
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (audioEl) { audioEl.srcObject = null; audioEl.remove(); audioEl = null; }
  chain = null;
}

// ── Message handling ──────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    startProcessing(msg.streamId, msg.settings)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    stopProcessing();
    sendResponse({ success: true });
  }

  if (msg.type === 'OFFSCREEN_UPDATE_SETTINGS') {
    currentSettings = { ...currentSettings, ...msg.settings };
    if (chain) applySettings(currentSettings, chain);
    sendResponse({ success: true });
  }
});
