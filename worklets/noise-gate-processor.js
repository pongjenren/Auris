class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this._threshold = opts.threshold ?? -50;
    this._attack = opts.attack ?? 0.003;
    this._release = opts.release ?? 0.25;
    this._gain = 0;

    this.port.onmessage = ({ data }) => {
      if (data.threshold !== undefined) this._threshold = data.threshold;
      if (data.attack !== undefined) this._attack = data.attack;
      if (data.release !== undefined) this._release = data.release;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const attackCoeff = Math.exp(-1 / (this._attack * sampleRate));
    const releaseCoeff = Math.exp(-1 / (this._release * sampleRate));
    const thresholdLinear = Math.pow(10, this._threshold / 20);

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch] || input[0];
      const outCh = output[ch];
      for (let i = 0; i < outCh.length; i++) {
        const level = Math.abs(inCh[i]);
        const target = level > thresholdLinear ? 1 : 0;
        this._gain = target > this._gain
          ? attackCoeff * this._gain + (1 - attackCoeff) * target
          : releaseCoeff * this._gain + (1 - releaseCoeff) * target;
        outCh[i] = inCh[i] * this._gain;
      }
    }
    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
