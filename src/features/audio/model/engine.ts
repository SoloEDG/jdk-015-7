import { reactive, shallowRef } from "vue";
import type { Analysis, StageDocument } from "../../../shared/types";
import { analyse } from "../lib/analyse";
import { demoBuffer, demoChannels, DEMO_RATE } from "../lib/demo";
export function createAudio(doc: StageDocument) {
  const state = reactive({
    playing: false,
    source: "demo",
    name: "Midnight / 120 BPM",
    duration: 16,
    position: 0,
    error: "",
    loading: false,
  });
  const frame = shallowRef<Analysis>({
    bins: Array(128).fill(0),
    wave: Array(256).fill(0),
    rms: 0,
    bass: 0,
    beat: false,
    time: 0,
  });
  let ctx: AudioContext,
    analyser: AnalyserNode,
    gain: GainNode,
    destination: MediaStreamAudioDestinationNode;
  // Captured at a fixed rate so exports are device-independent: the live graph
  // resamples this on playback, the exporter reads it as-is.
  let buffer: AudioBuffer,
    node: AudioBufferSourceNode | MediaStreamAudioSourceNode | undefined,
    mic: MediaStream | undefined;
  let origin = 0,
    offset = 0,
    epoch = 0,
    raf = 0;
  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    gain = ctx.createGain();
    destination = ctx.createMediaStreamDestination();
    analyser.connect(gain);
    gain.connect(ctx.destination);
    analyser.connect(destination);
    buffer = demoBuffer(ctx);
  }
  function detach() {
    if (node) {
      if (node instanceof AudioBufferSourceNode) {
        node.onended = null;
        try {
          node.stop();
        } catch {}
      }
      node.disconnect();
      node = undefined;
    }
    mic?.getTracks().forEach((t) => t.stop());
    mic = undefined;
  }
  function pump() {
    if (!ctx) return;
    const f = new Uint8Array(analyser.frequencyBinCount),
      w = new Uint8Array(analyser.fftSize);
    analyser.smoothingTimeConstant = doc.smoothing;
    gain.gain.value = state.source === "mic" ? 0 : doc.gain;
    analyser.getByteFrequencyData(f);
    analyser.getByteTimeDomainData(w);
    state.position = state.playing ? offset + ctx.currentTime - origin : offset;
    frame.value = analyse(
      f,
      w,
      state.position,
      doc.sensitivity,
      frame.value.bass,
    );
    raf = requestAnimationFrame(pump);
  }
  async function play() {
    init();
    await ctx.resume();
    if (state.playing) return;
    if (state.source === "mic") {
      await microphone();
      return;
    }
    node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(analyser);
    origin = ctx.currentTime;
    node.start(0, offset % buffer.duration);
    state.playing = true;
    if (!raf) pump();
  }
  function pause() {
    if (!state.playing) return;
    offset = state.position;
    detach();
    state.playing = false;
  }
  async function file(file: File) {
    init();
    const ticket = ++epoch;
    state.loading = true;
    state.error = "";
    try {
      // Decode at a fixed 48 kHz: the live context would resample to the
      // device rate, which would make the same file export differently on
      // different machines. The graph resamples on playback as needed.
      const decoder = new OfflineAudioContext(2, 1, DEMO_RATE);
      const data = await file.arrayBuffer();
      // An OfflineAudioContext's decodeAudioData resamples to its rate, so the
      // buffer is already 48 kHz whatever the file's native rate was.
      const next = await decoder.decodeAudioData(data);
      if (ticket !== epoch) return;
      detach();
      buffer = next;
      offset = 0;
      state.position = 0;
      state.playing = false;
      state.source = "file";
      state.name = file.name;
      state.duration = next.duration;
      await play();
    } catch {
      if (ticket === epoch)
        state.error = "无法解码此音频，请选择有效的音频文件。";
    } finally {
      if (ticket === epoch) state.loading = false;
    }
  }
  async function microphone() {
    init();
    const ticket = ++epoch;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ticket !== epoch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      detach();
      mic = stream;
      node = ctx.createMediaStreamSource(stream);
      node.connect(analyser);
      state.source = "mic";
      state.name = "Live microphone";
      state.playing = true;
      offset = 0;
      origin = ctx.currentTime;
      await ctx.resume();
      if (!raf) pump();
    } catch {
      state.error = "麦克风不可用或未获授权，原有音源已保留。";
    }
  }
  async function demo() {
    init();
    ++epoch;
    detach();
    buffer = demoBuffer(ctx);
    state.source = "demo";
    state.name = "Midnight / 120 BPM";
    offset = 0;
    state.playing = false;
    state.duration = 16;
    await play();
  }
  /**
   * View of the currently loaded, replayable track.
   *
   * A microphone is a live input, not material that can be rendered offline:
   * this returns null so the exporter can refuse instead of encoding silence
   * for input that was never captured. Everything else is held at a fixed
   * 48 kHz, so exports do not depend on the machine's output rate.
   */
  function capture() {
    if (state.source === "mic") return null;
    // Decoded files only exist once `init` has run; the demo is generated from
    // code, so it can be exported without ever creating an AudioContext.
    if (!buffer && state.source === "demo" && !state.loading) {
      const channels = demoChannels(DEMO_RATE);
      return {
        channels,
        sampleRate: DEMO_RATE,
        duration: channels[0].length / DEMO_RATE,
        name: state.name,
        source: state.source,
        loading: state.loading,
      };
    }
    if (!buffer) return null;
    return {
      channels: Array.from({ length: buffer.numberOfChannels }, (_, c) =>
        buffer.getChannelData(c),
      ),
      sampleRate: buffer.sampleRate,
      duration: buffer.duration,
      name: state.name,
      source: state.source,
      loading: state.loading,
    };
  }
  function dispose() {
    ++epoch;
    cancelAnimationFrame(raf);
    detach();
    void ctx?.close();
  }
  return {
    state,
    frame,
    capture,
    play,
    pause,
    file,
    microphone,
    demo,
    dispose,
    stream: () => {
      init();
      return destination.stream;
    },
  };
}
export type AudioEngine = ReturnType<typeof createAudio>;
