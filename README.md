# Auris

一個 Chrome / Edge 瀏覽器擴充功能，能對任何分頁的音訊進行即時處理，提供專業級的 EQ、壓縮、限制器與降噪閘控效果。

---

## 目錄

- [功能概覽](#功能概覽)
- [架構總覽](#架構總覽)
- [完整處理流程](#完整處理流程)
- [音訊效果鏈](#音訊效果鏈)
- [訊息協定](#訊息協定)
- [設定與狀態管理](#設定與狀態管理)
- [檔案結構](#檔案結構)
- [安裝方式](#安裝方式)
- [技術重點](#技術重點)

---

## 功能概覽

| 效果 | 說明 |
|------|------|
| 輸入增益 | 提升輸入音量（0.5x ～ 4x） |
| 降噪閘控 | 自訂 Worklet，可設定閾值、啟動與釋放時間 |
| 10 段 EQ | 31 Hz ～ 16 kHz 參數化等化器，±12 dB |
| 壓縮器 | 可調閾值、比例、啟動／釋放時間 |
| 限制器 | 硬限制，防止削波（固定 -1 dBFS、20:1） |
| 輸出音量 | 最終增益控制（0% ～ 100%） |

---

## 架構總覽

Auris 由三個相互分離的執行環境組成，透過 `chrome.runtime` 訊息傳遞互相溝通：

```
┌─────────────────────┐
│   Popup (UI)        │  ← 使用者操作介面
│   popup.js          │
└────────┬────────────┘
         │ chrome.runtime.sendMessage
         ▼
┌─────────────────────┐
│  Background Worker  │  ← 協調者、生命週期管理
│  background.js      │
└────────┬────────────┘
         │ chrome.runtime.sendMessage
         ▼
┌─────────────────────┐
│  Offscreen Document │  ← 音訊 DSP 引擎
│  offscreen.js       │
└─────────────────────┘
```

---

## 完整處理流程

### 第一步：使用者啟用

1. 使用者點擊擴充功能圖示，Popup 開啟並載入目前分頁的已儲存設定（或預設值）。
2. 使用者切換主開關，Popup 向 Background Worker 傳送 `ENABLE_TAB` 訊息，並附上當前設定。

### 第二步：擷取分頁音訊

```
chrome.tabCapture.getMediaStreamId(tabId)
    ↓
取得 streamId（音訊串流識別碼）
    ↓
將分頁原始音訊靜音（避免雙重播放）
```

Background Worker 呼叫 `chrome.tabCapture.getMediaStreamId()` 取得分頁的媒體串流 ID，同時將原始分頁音訊靜音。

### 第三步：建立 Offscreen Document

Chrome 的 Manifest V3 禁止在 Service Worker 中直接使用 Web Audio API，因此需要建立一個隔離的 Offscreen Document 作為音訊處理環境：

```
chrome.offscreen.createDocument()
    ↓
Offscreen Document 載入完成
    ↓
offscreen → background：OFFSCREEN_READY
    ↓
background → offscreen：OFFSCREEN_START（附 streamId + settings）
```

Background Worker 等待 `OFFSCREEN_READY` 確認後，才傳送串流 ID 與設定，確保初始化順序正確。

### 第四步：建立 AudioContext 與取得串流

Offscreen Document 收到 `OFFSCREEN_START` 後：

```javascript
navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
})
    ↓
new AudioContext()
    ↓
context.createMediaStreamSource(stream)
```

### 第五步：建構音訊效果鏈

詳見下一節 [音訊效果鏈](#音訊效果鏈)。

### 第六步：輸出到播放裝置

```
效果鏈末端
    ↓
MediaStreamDestination（context.createMediaStreamDestination()）
    ↓
<audio> element（autoplay）
    ↓
使用者的揚聲器 / 耳機
```

### 第七步：即時參數更新

使用者在 Popup 調整任何滑桿或開關：

```
Popup → background：UPDATE_SETTINGS
    ↓
background → offscreen：OFFSCREEN_UPDATE_SETTINGS
    ↓
offscreen 呼叫 AudioParam.setTargetAtTime() 平滑過渡
```

所有參數變更使用指數漸變（RAMP = 0.005 秒），避免突然切換產生的爆音。

### 第八步：停用

```
Popup → background：DISABLE_TAB
    ↓
background → offscreen：OFFSCREEN_STOP
    ↓
AudioContext.close()、<audio> 停止
    ↓
chrome.offscreen.closeDocument()
    ↓
恢復分頁原始音量
```

---

## 音訊效果鏈

音訊依序通過以下節點，每個效果都有獨立的啟用／停用旁通控制：

```
MediaStreamSource
       │
       ▼
┌─────────────┐
│  輸入增益   │  GainNode  ×0.5 ～ ×4.0
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│          降噪閘控               │
│  AudioWorkletNode               │
│  noise-gate-processor.js        │
│  閾值：-80 ～ 0 dB              │
│  啟動：0.001 ～ 1 秒            │
│  釋放：0.01 ～ 2 秒             │
└──────┬──────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│              10 段 EQ                    │
│  BiquadFilter × 10（串聯）               │
│  31 Hz（lowshelf）                       │
│  62, 125, 250, 500, 1k, 2k, 4k, 8k Hz   │
│  （peaking，Q = 1.41）                   │
│  16 kHz（highshelf）                     │
│  每段 ±12 dB                             │
└──────┬───────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│           壓縮器                │
│  DynamicsCompressorNode         │
│  閾值：-60 ～ 0 dB（預設 -24） │
│  比例：1:1 ～ 20:1（預設 4:1） │
│  啟動：0.001 ～ 1 秒（預設 3ms）│
│  釋放：0.01 ～ 2 秒（預設 250ms）│
│  Knee：6 dB（軟膝）             │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│           限制器                │
│  DynamicsCompressorNode（固定） │
│  閾值：-1 dBFS                  │
│  比例：20:1                     │
│  啟動：1 ms                     │
│  釋放：50 ms                    │
│  Knee：0 dB（硬膝）             │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────┐
│  輸出音量   │  GainNode  0% ～ 100%
└──────┬──────┘
       │
       ▼
MediaStreamDestination → <audio> → 揚聲器
```

### 旁通機制

每個效果使用「乾濕增益對」實現旁通，避免直接斷開節點造成的爆音：

- **啟用**：wetGain → 1，dryGain → 0（平滑漸變）
- **停用**：wetGain → 0，dryGain → 1（平滑漸變）

---

## 訊息協定

| 訊息類型 | 方向 | 內容 | 用途 |
|----------|------|------|------|
| `ENABLE_TAB` | Popup → Background | `{ tabId, settings }` | 啟用指定分頁的音訊處理 |
| `DISABLE_TAB` | Popup → Background | `{ tabId }` | 停止指定分頁的音訊處理 |
| `UPDATE_SETTINGS` | Popup → Background | `{ settings }` | 即時更新效果參數 |
| `OFFSCREEN_READY` | Offscreen → Background | — | 確認 Offscreen Document 已就緒 |
| `OFFSCREEN_START` | Background → Offscreen | `{ streamId, tabId, settings }` | 開始音訊處理 |
| `OFFSCREEN_STOP` | Background → Offscreen | — | 停止音訊處理 |
| `OFFSCREEN_UPDATE_SETTINGS` | Background → Offscreen | `{ settings }` | 即時套用新參數 |

---

## 設定與狀態管理

### 預設設定結構

```javascript
{
  enabled: false,
  gain: 1.0,               // 輸入增益（線性，0.5 ～ 4）
  volume: 100,             // 輸出音量百分比（0 ～ 100）
  eq: {
    enabled: true,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]  // 10 個頻段，-12 ～ +12 dB
  },
  compressor: {
    enabled: false,
    threshold: -24,
    ratio: 4,
    attack: 0.003,
    release: 0.25
  },
  limiter: {
    enabled: false
  },
  noiseGate: {
    enabled: false,
    threshold: -50,
    attack: 0.003,
    release: 0.25
  }
}
```

### 儲存方式

設定以 `tab_{tabId}` 為鍵，儲存於 `chrome.storage.local`，每個分頁獨立管理。

### 預設集（Preset）

- **匯出**：將目前設定序列化為 JSON 並下載
- **匯入**：透過檔案選擇器讀取 JSON 並套用

---

## 檔案結構

```
Auris/
├── manifest.json                  # 擴充功能設定（MV3）
├── background.js                  # Service Worker，協調者
├── popup/
│   ├── popup.html                 # UI 標記
│   ├── popup.js                   # UI 邏輯與狀態管理
│   └── popup.css                  # 樣式
├── offscreen/
│   ├── offscreen.html             # Offscreen Document 容器
│   └── offscreen.js               # Web Audio API DSP 引擎
└── worklets/
    └── noise-gate-processor.js    # 自訂 AudioWorkletProcessor
```

---

## 安裝方式

1. 前往 `chrome://extensions/`（或 `edge://extensions/`）
2. 開啟右上角「開發人員模式」
3. 點擊「載入未封裝項目」，選擇本專案資料夾
4. 擴充功能圖示出現後，前往任意有音訊的分頁即可使用

> **注意：** `chrome://`、`edge://`、`about:` 等系統頁面無法擷取音訊，Auris 會在這些頁面停用。

---

## 技術重點

### 競態條件防護
Background Worker 使用 Promise 佇列序列化分頁的啟用／停用操作，避免快速切換時的競態問題。

### 分頁自動恢復
當分頁重新載入完成後，Background Worker 會偵測到 `tabs.onUpdated` 事件並自動重新啟用 Auris（如果該分頁原本已啟用）。

### 降噪閘控實作
`noise-gate-processor.js` 使用指數衰減係數實作真實的 Attack / Release 包絡，每個音訊區塊（128 個樣本）都會即時計算 RMS 能量並與閾值比較。

### 無外部依賴
純原生 JavaScript，完全依賴瀏覽器內建 API，不需要任何 npm 套件或建置工具。
