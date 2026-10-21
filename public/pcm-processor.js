class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel) {
      // Copy out — the underlying buffer is reused.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
