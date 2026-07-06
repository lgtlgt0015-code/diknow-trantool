class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._frameSize = options.processorOptions?.frameSize ?? 320;
    this._buffer = new Int16Array(this._frameSize);
    this._writePos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      this._buffer[this._writePos++] = s < -1 ? -32768 : s > 1 ? 32767 : (s * 32767) | 0;
      if (this._writePos >= this._frameSize) {
        this.port.postMessage(this._buffer.slice(0));
        this._writePos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
