import { Muxer, StreamTarget } from "webm-muxer";

export interface EncoderConfig {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

const VP9_CODECS = ["vp09.00.10.08", "vp09.00.40.08", "vp09.00.50.08"];

export async function pickVideoCodec(width: number, height: number, fps: number) {
  for (const codec of VP9_CODECS) {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
        bitrate: 1,
      });
      if (result.supported) return codec;
    } catch {
      /* try the next one */
    }
  }
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: "vp8",
      width,
      height,
      framerate: fps,
      bitrate: 1,
    });
    if (result.supported) return "vp8";
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * WebM writer that streams to disk as encoding progresses.
 *
 * The muxer writes a fixed header up front and then clusters; `onData` may
 * revisit earlier byte positions, so the sink must support positioned writes
 * (OPFS does). Nothing is accumulated in memory once flushed.
 *
 * Encoders deliver chunks asynchronously, so the order two *different*
 * encoders' callbacks fire is not guaranteed. Each encoder, however, emits its
 * own chunks strictly in submission order. The writer therefore keeps one
 * FIFO per track and merges them by timestamp (video first on ties). The
 * emitted sequence is thus the deterministic merge of the two deterministic
 * per-track sequences, and cannot depend on callback timing, machine load, tab
 * backgrounding, or how the render was split into segments. Memory is bounded
 * by how far ahead one track runs of the other.
 */
export interface MuxSink {
  write(position: number, data: Uint8Array): Promise<void>;
  finalize(): Promise<void>;
  abort(): Promise<void>;
}

interface Slot {
  timestamp: number;
  push: () => void;
}

function muxerCodec(codec: string) {
  return codec.startsWith("vp09") ? "V_VP9" : "V_VP8";
}

export function createMuxer(
  codec: string,
  config: EncoderConfig,
  audioChannels: number,
  sink: MuxSink,
) {
  const writes: Promise<void>[] = [];
  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, position) => {
        writes.push(sink.write(position, data));
      },
      chunked: true,
      chunkSize: 1 << 18,
    }),
    video: {
      codec: muxerCodec(codec),
      width: config.width,
      height: config.height,
      frameRate: config.fps,
    },
    audio: {
      codec: "A_OPUS",
      numberOfChannels: audioChannels,
      sampleRate: 48000,
    },
    firstTimestampBehavior: "strict",
  });

  const videoQueue: Slot[] = [];
  const audioQueue: Slot[] = [];

  /**
   * Merge the two per-track FIFOs. A head is written only when both heads are
   * present: the other track could still produce an earlier chunk. `final`
   * means both encoders are closed and nothing more can arrive.
   *
   * Because each encoder emits its chunks in submission order and this merge
   * is deterministic, the written sequence depends only on the timeline.
   */
  function merge(final: boolean) {
    for (;;) {
      const video = videoQueue[0];
      const audio = audioQueue[0];
      if (!video || !audio) {
        if (!final) return;
        if (!video && !audio) return;
        // Closed encoders: take whichever head is earlier.
        if (!video || (audio && audio.timestamp < video.timestamp)) {
          audioQueue.shift()!.push();
        } else {
          videoQueue.shift()!.push();
        }
        continue;
      }
      if (video.timestamp <= audio.timestamp) videoQueue.shift()!.push();
      else audioQueue.shift()!.push();
    }
  }

  async function drainWrites() {
    while (writes.length) await writes.shift();
  }

  return {
    /** Buffer an encoded video chunk; ordering is decided by the merge. */
    addVideo(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
      videoQueue.push({
        timestamp: chunk.timestamp,
        push: () => muxer.addVideoChunk(chunk, meta),
      });
      merge(false);
    },
    addAudio(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
      audioQueue.push({
        timestamp: chunk.timestamp,
        push: () => muxer.addAudioChunk(chunk, meta),
      });
      merge(false);
    },
    async drain() {
      await drainWrites();
    },
    async finalize() {
      // Both encoders are closed, so every chunk has arrived.
      merge(true);
      muxer.finalize();
      await drainWrites();
      await sink.finalize();
    },
    async fail() {
      videoQueue.length = 0;
      audioQueue.length = 0;
      await Promise.allSettled(writes);
      writes.length = 0;
      await sink.abort();
    },
  };
}

export type MuxWriter = ReturnType<typeof createMuxer>;

/**
 * Audio encoder at a fixed 48 kHz. Opus frame sizes are taken from the encoder
 * itself so chunk timestamps remain exact regardless of block sizes.
 */
export function createAudioWriter(
  sampleRate: number,
  channels: number,
  bitrate: number,
  onChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void,
  onError: (error: Error) => void,
) {
  const encoder = new AudioEncoder({
    output: onChunk,
    error: (error) => onError(error instanceof Error ? error : Error(String(error))),
  });
  encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: channels,
    bitrate,
  });
  let lastEnd = 0;
  return {
    encoder,
    /** Encode planar audio that starts at `timestampUs`. */
    async push(planar: Float32Array[], timestampUs: number, frames: number) {
      if (!frames) return;
      const data = new Float32Array(frames * planar.length);
      for (let c = 0; c < planar.length; c++) {
        data.set(planar[c].subarray(0, frames), c * frames);
      }
      const audio = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: planar.length,
        timestamp: Math.round(timestampUs),
        data,
      });
      encoder.encode(audio);
      audio.close();
      lastEnd = Math.max(lastEnd, Math.round(timestampUs) + (frames / sampleRate) * 1e6);
      while (encoder.encodeQueueSize > 8) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    /**
     * Wait until every submitted block has been output, without flushing the
     * encoder: `flush()` changes how Opus frames its tail, which would make
     * the encoded bytes depend on the render segmentation. Queue emptiness is
     * a pure scheduling barrier.
     */
    async idle() {
      if (encoder.encodeQueueSize === 0) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          if (encoder.encodeQueueSize !== 0) return;
          encoder.removeEventListener("dequeue", done);
          resolve();
        };
        encoder.addEventListener("dequeue", done);
      });
    },
    async close() {
      await encoder.flush();
      encoder.close();
    },
    cancel() {
      try {
        encoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export type AudioWriter = ReturnType<typeof createAudioWriter>;
