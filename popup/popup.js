const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function defaultSettings() {
  return {
    enabled: false,
    gain: 1.0,
    volume: 100,
    eq: { enabled: true, bands: new Array(10).fill(0) },
    compressor: { enabled: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25 },
    limiter: { enabled: false },
    mono: { enabled: false },
    noiseGate: { enabled: false, threshold: -50, attack: 0.003, release: 0.25 }
  };
}

let currentTab = null;
let settings = defaultSettings();
let sendTimeout = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainToDB(linear) {
  return (Math.log10(linear) * 20).toFixed(1);
}

function msLabel(seconds) {
  const ms = Math.round(seconds * 1000);
  return ms < 1000 ? `${ms} ms` : `${(seconds).toFixed(2)} s`;
}

function storageKey(tabId) {
  return `tab_${tabId}`;
}

async function loadSettings(tabId) {
  return new Promise(resolve => {
    chrome.storage.local.get(storageKey(tabId), result => {
      resolve({ ...defaultSettings(), ...(result[storageKey(tabId)] || {}) });
    });
  });
}

function saveSettings(tabId, s) {
  chrome.storage.local.set({ [storageKey(tabId)]: s });
}

function sendSettingsToTab(_tabId, s) {
  clearTimeout(sendTimeout);
  sendTimeout = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: s });
  }, 30);
}

// ── Build EQ bands ────────────────────────────────────────────────────────────

function buildEQBands() {
  const container = document.getElementById('eqBands');
  EQ_FREQS.forEach((_, i) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'eq-band-wrapper';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = -12;
    input.max = 12;
    input.step = 0.5;
    input.value = settings.eq.bands[i];
    input.id = `eq${i}`;
    input.addEventListener('input', () => {
      settings.eq.bands[i] = parseFloat(input.value);
      saveAndSend();
    });
    input.addEventListener('dblclick', () => {
      input.value = 0;
      settings.eq.bands[i] = 0;
      saveAndSend();
    });

    wrapper.appendChild(input);
    container.appendChild(wrapper);
  });
}

// ── UI sync ───────────────────────────────────────────────────────────────────

function syncUI() {
  // Master
  const masterEl = document.getElementById('masterEnabled');
  masterEl.checked = settings.enabled;
  document.getElementById('mainContent').classList.toggle('disabled-overlay', !settings.enabled);

  // Gain
  const gainSlider = document.getElementById('gainSlider');
  gainSlider.value = settings.gain;
  document.getElementById('gainValue').textContent = `${gainToDB(settings.gain)} dB`;

  // Volume
  const volSlider = document.getElementById('volumeSlider');
  volSlider.value = settings.volume;
  document.getElementById('volumeValue').textContent = `${settings.volume}%`;

  // EQ
  document.getElementById('eqEnabled').checked = settings.eq.enabled;
  document.getElementById('eqEnabled-content').classList.toggle('collapsed', false);
  EQ_FREQS.forEach((_, i) => {
    const el = document.getElementById(`eq${i}`);
    if (el) el.value = settings.eq.bands[i];
  });

  // Compressor
  document.getElementById('compEnabled').checked = settings.compressor.enabled;
  document.getElementById('compEnabled-content').classList.toggle('collapsed', !settings.compressor.enabled);
  document.getElementById('compThreshold').value = settings.compressor.threshold;
  document.getElementById('compThresholdValue').textContent = `${settings.compressor.threshold} dB`;
  document.getElementById('compRatio').value = settings.compressor.ratio;
  document.getElementById('compRatioValue').textContent = `${settings.compressor.ratio}:1`;
  document.getElementById('compAttack').value = settings.compressor.attack;
  document.getElementById('compAttackValue').textContent = msLabel(settings.compressor.attack);
  document.getElementById('compRelease').value = settings.compressor.release;
  document.getElementById('compReleaseValue').textContent = msLabel(settings.compressor.release);

  // Limiter
  document.getElementById('limiterEnabled').checked = settings.limiter.enabled;

  // Mono
  document.getElementById('monoEnabled').checked = settings.mono.enabled;

  // Noise Gate
  document.getElementById('ngEnabled').checked = settings.noiseGate.enabled;
  document.getElementById('ngEnabled-content').classList.toggle('collapsed', !settings.noiseGate.enabled);
  document.getElementById('ngThreshold').value = settings.noiseGate.threshold;
  document.getElementById('ngThresholdValue').textContent = `${settings.noiseGate.threshold} dB`;
  document.getElementById('ngAttack').value = settings.noiseGate.attack;
  document.getElementById('ngAttackValue').textContent = msLabel(settings.noiseGate.attack);
  document.getElementById('ngRelease').value = settings.noiseGate.release;
  document.getElementById('ngReleaseValue').textContent = msLabel(settings.noiseGate.release);
}

function saveAndSend() {
  saveSettings(currentTab.id, settings);
  sendSettingsToTab(currentTab.id, settings);
}

function onReset(id, defaultValue, onUpdate) {
  document.getElementById(id).addEventListener('dblclick', () => {
    const el = document.getElementById(id);
    el.value = defaultValue;
    onUpdate(defaultValue);
  });
}

// ── Event bindings ────────────────────────────────────────────────────────────

function bindEvents() {
  // Master toggle
  document.getElementById('masterEnabled').addEventListener('change', async e => {
    settings.enabled = e.target.checked;
    document.getElementById('mainContent').classList.toggle('disabled-overlay', !settings.enabled);

    if (settings.enabled) {
      chrome.runtime.sendMessage(
        { type: 'ENABLE_TAB', tabId: currentTab.id, settings },
        resp => {
          if (resp && !resp.success) {
            console.error('Auris enable failed:', resp.error);
            // Revert UI on failure
            settings.enabled = false;
            e.target.checked = false;
            document.getElementById('mainContent').classList.add('disabled-overlay');
            saveSettings(currentTab.id, settings);
          }
        }
      );
    } else {
      chrome.runtime.sendMessage({ type: 'DISABLE_TAB', tabId: currentTab.id });
    }
    saveSettings(currentTab.id, settings);
  });

  // Gain
  document.getElementById('gainSlider').addEventListener('input', e => {
    settings.gain = parseFloat(e.target.value);
    document.getElementById('gainValue').textContent = `${gainToDB(settings.gain)} dB`;
    saveAndSend();
  });
  onReset('gainSlider', 1.0, v => {
    settings.gain = v;
    document.getElementById('gainValue').textContent = `${gainToDB(v)} dB`;
    saveAndSend();
  });

  // Volume
  document.getElementById('volumeSlider').addEventListener('input', e => {
    settings.volume = parseInt(e.target.value, 10);
    document.getElementById('volumeValue').textContent = `${settings.volume}%`;
    saveAndSend();
  });
  onReset('volumeSlider', 100, v => {
    settings.volume = v;
    document.getElementById('volumeValue').textContent = `${v}%`;
    saveAndSend();
  });

  // EQ toggle
  document.getElementById('eqEnabled').addEventListener('change', e => {
    settings.eq.enabled = e.target.checked;
    saveAndSend();
  });

  // Compressor toggle & params
  document.getElementById('compEnabled').addEventListener('change', e => {
    settings.compressor.enabled = e.target.checked;
    document.getElementById('compEnabled-content').classList.toggle('collapsed', !e.target.checked);
    saveAndSend();
  });

  document.getElementById('compThreshold').addEventListener('input', e => {
    settings.compressor.threshold = parseInt(e.target.value, 10);
    document.getElementById('compThresholdValue').textContent = `${settings.compressor.threshold} dB`;
    saveAndSend();
  });
  onReset('compThreshold', -24, v => {
    settings.compressor.threshold = v;
    document.getElementById('compThresholdValue').textContent = `${v} dB`;
    saveAndSend();
  });

  document.getElementById('compRatio').addEventListener('input', e => {
    settings.compressor.ratio = parseFloat(e.target.value);
    document.getElementById('compRatioValue').textContent = `${settings.compressor.ratio}:1`;
    saveAndSend();
  });
  onReset('compRatio', 4, v => {
    settings.compressor.ratio = v;
    document.getElementById('compRatioValue').textContent = `${v}:1`;
    saveAndSend();
  });

  document.getElementById('compAttack').addEventListener('input', e => {
    settings.compressor.attack = parseFloat(e.target.value);
    document.getElementById('compAttackValue').textContent = msLabel(settings.compressor.attack);
    saveAndSend();
  });
  onReset('compAttack', 0.003, v => {
    settings.compressor.attack = v;
    document.getElementById('compAttackValue').textContent = msLabel(v);
    saveAndSend();
  });

  document.getElementById('compRelease').addEventListener('input', e => {
    settings.compressor.release = parseFloat(e.target.value);
    document.getElementById('compReleaseValue').textContent = msLabel(settings.compressor.release);
    saveAndSend();
  });
  onReset('compRelease', 0.25, v => {
    settings.compressor.release = v;
    document.getElementById('compReleaseValue').textContent = msLabel(v);
    saveAndSend();
  });

  // Limiter toggle
  document.getElementById('limiterEnabled').addEventListener('change', e => {
    settings.limiter.enabled = e.target.checked;
    saveAndSend();
  });

  // Mono toggle
  document.getElementById('monoEnabled').addEventListener('change', e => {
    settings.mono.enabled = e.target.checked;
    saveAndSend();
  });

  // Noise Gate toggle & params
  document.getElementById('ngEnabled').addEventListener('change', e => {
    settings.noiseGate.enabled = e.target.checked;
    document.getElementById('ngEnabled-content').classList.toggle('collapsed', !e.target.checked);
    saveAndSend();
  });

  document.getElementById('ngThreshold').addEventListener('input', e => {
    settings.noiseGate.threshold = parseInt(e.target.value, 10);
    document.getElementById('ngThresholdValue').textContent = `${settings.noiseGate.threshold} dB`;
    saveAndSend();
  });
  onReset('ngThreshold', -50, v => {
    settings.noiseGate.threshold = v;
    document.getElementById('ngThresholdValue').textContent = `${v} dB`;
    saveAndSend();
  });

  document.getElementById('ngAttack').addEventListener('input', e => {
    settings.noiseGate.attack = parseFloat(e.target.value);
    document.getElementById('ngAttackValue').textContent = msLabel(settings.noiseGate.attack);
    saveAndSend();
  });
  onReset('ngAttack', 0.003, v => {
    settings.noiseGate.attack = v;
    document.getElementById('ngAttackValue').textContent = msLabel(v);
    saveAndSend();
  });

  document.getElementById('ngRelease').addEventListener('input', e => {
    settings.noiseGate.release = parseFloat(e.target.value);
    document.getElementById('ngReleaseValue').textContent = msLabel(settings.noiseGate.release);
    saveAndSend();
  });
  onReset('ngRelease', 0.25, v => {
    settings.noiseGate.release = v;
    document.getElementById('ngReleaseValue').textContent = msLabel(v);
    saveAndSend();
  });

  // Save Preset
  document.getElementById('savePreset').addEventListener('click', () => {
    const json = JSON.stringify(settings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audio-enhance-preset.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Load Preset
  document.getElementById('loadPresetInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const loaded = JSON.parse(ev.target.result);
        settings = { ...defaultSettings(), ...loaded };
        syncUI();
        saveAndSend();
      } catch {
        alert('Invalid preset file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Reset All
  document.getElementById('resetAll').addEventListener('click', () => {
    const wasEnabled = settings.enabled;
    settings = defaultSettings();
    settings.enabled = wasEnabled;
    syncUI();
    saveAndSend();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  // Check if we can access this tab
  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) {
    document.getElementById('mainContent').classList.add('hidden');
    document.getElementById('noPageWarning').classList.remove('hidden');
    return;
  }

  settings = await loadSettings(tab.id);

  buildEQBands();
  bindEvents();
  syncUI();
}

document.addEventListener('DOMContentLoaded', init);
