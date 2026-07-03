class TelegramCallPcmCapture extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const frameMs = options.processorOptions?.frameMs || 20;
    this.targetSampleRateHz = options.processorOptions?.targetSampleRateHz || sampleRate;
    this.frameSamples = Math.max(1, Math.round(this.targetSampleRateHz * frameMs / 1000));
    this.pending = [];
    this.pendingSamples = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) {
      return true;
    }
    const resampled = resampleFloat32(channel, sampleRate, this.targetSampleRateHz);
    this.pending.push(resampled);
    this.pendingSamples += resampled.length;

    while (this.pendingSamples >= this.frameSamples) {
      const frame = this.readFrame(this.frameSamples);
      const pcm16 = new Int16Array(frame.length);
      for (let index = 0; index < frame.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, frame[index]));
        pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage({
        pcm16: pcm16.buffer,
        sampleRateHz: this.targetSampleRateHz,
      }, [pcm16.buffer]);
    }
    return true;
  }

  readFrame(size) {
    const frame = new Float32Array(size);
    let offset = 0;
    while (offset < size && this.pending.length > 0) {
      const head = this.pending[0];
      const take = Math.min(size - offset, head.length);
      frame.set(head.subarray(0, take), offset);
      offset += take;
      this.pendingSamples -= take;
      if (take === head.length) {
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(take);
      }
    }
    return frame;
  }
}

function resampleFloat32(input, inputRate, outputRate) {
  if (!input?.length) {
    return new Float32Array(0);
  }
  if (inputRate === outputRate) {
    return new Float32Array(input);
  }
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

registerProcessor('telegram-call-pcm-capture', TelegramCallPcmCapture);
