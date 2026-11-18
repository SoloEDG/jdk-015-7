import { createTimeline, ANALYSIS_MARGIN } from "../lib/timeline";
import { createSliceReader, type SliceReader } from "../lib/window";
import {
  createAudioWriter,
  createMuxer,
  pickVideoCodec,
  type AudioWriter,
  type MuxWriter,
} from "../lib/encode";
import { createExportSink, type ExportSink } from "../lib/sink";
import { ExportCancelledError, ExportIntervalError } from "../lib/errors";
import type {
  AudioSlice,
  RenderRequest,
  WorkerMessage,
  WorkerRequest,
} from "../lib/protocol";

const scope = self as unknown as {
  postMessage: (message: WorkerMessage, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

interface Pending {
  resolve: (slice: AudioSlice) => void;
  reject: (error: Error) => void;
}

const pendingAudio = new Map<number, Pending>();
let audioTicket = 0;
let cancelled = false;
// Only the currently running export may delete files: a stale worker that is
// still unwinding must never touch the output of a newer run.
let generation = 0;
let activeSink: ExportSink | undefined;

function post(message: WorkerMessage, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function requestAudio(outputStart: number, outputCount: number) {
  const id = ++audioTicket;
  return new Promise<AudioSlice>((resolve, reject) => {
    pendingAudio.set(id, { resolve, reject });
    post({ type: "audio-request", id, outputStart, outputCount });
  });
}

function checkCancelled() {
  if (cancelled) throw new ExportCancelledError();
}

/** FNV-1a over quantised analysis values and a small pixel sample. */
function createDigest() {
  let value = 0x811c9dc5;
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  function mix(data: ArrayBufferView | Uint8ClampedArray) {
    const array = new Uint8Array(
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength,
    );
    for (let i = 0; i < array.length; i++) {
      value ^= array[i];
      value = Math.imul(value, 0x01000193) >>> 0;
    }
  }
  function number(n: number) {
    view.setUint32(0, Math.round(n * 1e5) >>> 0, true);
    mix(bytes);
  }
  return {
    number,
    bytes: mix,
    finish: () => value.toString(16).padStart(8, "0"),
  };
}

async function run(request: RenderRequest) {
  if (!Number.isInteger(request.width) || request.width < 16)
    throw new Error("导出宽度无效");
  if (!Number.isInteger(request.height) || request.height < 16)
    throw new Error("导出高度无效");
  if (!(request.fps > 0)) throw new Error("帧率无效");
  if (!(request.sampleRate > 0)) throw new Error("采样率无效");
  if (request.rangeSamples <= 0) throw new Error("所选区间为空");
  if (request.startSample < 0) {
    throw new ExportIntervalError("所选起点早于音频开头，缺少可重放素材", [
      { start: 0, end: -request.startSample / request.sampleRate },
    ]);
  }
  if (request.startSample + request.rangeSamples > request.trackSamples) {
    throw new ExportIntervalError("所选区间超出音频长度，缺少可重放素材", [
      {
        start: request.trackSamples / request.sampleRate,
        end: (request.startSample + request.rangeSamples) / request.sampleRate,
      },
    ]);
  }
  if (
    typeof VideoEncoder === "undefined" ||
    typeof AudioEncoder === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    throw new Error("当前浏览器缺少 WebCodecs / OffscreenCanvas，无法离线导出");
  }

  const codec = await pickVideoCodec(
    request.width,
    request.height,
    request.fps,
  );
  if (!codec) throw new Error("当前浏览器不支持所选分辨率的视频编码");

  const rate = request.sampleRate;
  const duration = request.rangeSamples / rate;
  const frameCount = Math.max(1, Math.round(duration * request.fps));
  const segmentFrames = Math.max(1, Math.round(request.segmentFrames));

  const sink = await createExportSink(request.fileName);
  activeSink = sink;
  const mux: MuxWriter = createMuxer(codec, request, 2, sink.sink);
  const digest = createDigest();
  const preview = new OffscreenCanvas(48, 27);
  const previewContext = preview.getContext("2d", {
    willReadFrequently: true,
  });
  let audioWriter: AudioWriter | undefined;
  let lastPreview = 0;

  let encoderError: Error | undefined;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      mux.addVideo(chunk, meta);
    },
    error: (error) => {
      encoderError = error instanceof Error ? error : new Error(String(error));
    },
  });
  videoEncoder.configure({
    codec,
    width: request.width,
    height: request.height,
    framerate: request.fps,
    bitrate: request.bitrate,
    latencyMode: "quality",
  });

  const timeline = createTimeline({
    intervalOf: (sample) => ({
      start: sample / rate,
      end: (sample + 256) / rate,
    }),
    sampleRate: rate,
    startSample: request.startSample,
    rangeSamples: request.rangeSamples,
    trackSamples: request.trackSamples,
    fps: request.fps,
    scene: request.scene,
    width: request.width,
    height: request.height,
  });

  const audio = createAudioWriter(
    rate,
    2,
    192_000,
    (chunk, meta) => mux.addAudio(chunk, meta),
    (error) => {
      encoderError ??= error;
    },
  );
  audioWriter = audio;

  let rendered = 0;
  let segment = 0;
  // Audio is pushed in fixed 20 ms blocks aligned to the export start, not to
  // the render segmentation. Opus framing depends on how its input is chopped,
  // so tying it to segment size would make the audio bytes (and therefore the
  // muxed layout) differ between otherwise identical exports.
  const audioBlock = Math.round(rate * 0.02);
  let pendingAudio: Float32Array[] = [];
  let pendingFrames = 0;
  let pendingStart = request.startSample;

  /**
   * Emit audio up to `targetSample`, in whole 20 ms blocks. Called between
   * individual frames, so the interleaving of audio and video blocks depends
   * only on the frame index and never on where a segment boundary falls.
   */
  async function advanceAudio(
    targetSample: number,
    readPlanar: (from: number, length: number) => Float32Array[],
  ) {
    let available = targetSample - pendingStart - pendingFrames;
    while (available > 0) {
      const take = Math.min(audioBlock, available);
      const planar = readPlanar(
        pendingStart + pendingFrames,
        take,
      );
      if (!pendingAudio.length) {
        pendingAudio = planar.map((channel) => channel.slice());
      } else {
        for (let c = 0; c < planar.length; c++) {
          const merged = new Float32Array(pendingAudio[c].length + take);
          merged.set(pendingAudio[c], 0);
          merged.set(planar[c], pendingAudio[c].length);
          pendingAudio[c] = merged;
        }
      }
      pendingFrames += take;
      available -= take;
      if (pendingFrames >= audioBlock) {
        const blocks = pendingAudio.map((channel) =>
          channel.subarray(0, audioBlock),
        );
        const timestampUs =
          ((pendingStart - request.startSample) / rate) * 1e6;
        await audio.push(blocks, timestampUs, audioBlock);
        for (let c = 0; c < pendingAudio.length; c++) {
          pendingAudio[c] = pendingAudio[c].slice(audioBlock);
        }
        pendingFrames -= audioBlock;
        pendingStart += audioBlock;
      }
    }
  }

  try {
    while (rendered < frameCount) {
      checkCancelled();
      if (encoderError) throw encoderError;
      const end = Math.min(frameCount, rendered + segmentFrames);
      // Absolute sample range this batch must cover, including the analysis
      // lead-in so the first frame of a segment sees the same window it would
      // have seen in an uninterrupted render.
      const firstSample = timeline.frameSample(rendered);
      // The last batch also carries the selection's tail, which may extend a
      // little past the final frame's sample position (frame rounding).
      const audioEnd = request.startSample + request.rangeSamples;
      const lastSampleExclusive =
        end === frameCount
          ? Math.max(timeline.frameSample(end), audioEnd)
          : timeline.frameSample(end);
      const windowStart = Math.max(0, firstSample - ANALYSIS_MARGIN);
      // Ask for the samples this batch needs plus a little slack, never past
      // the end of the track: padding past the material would look exactly
      // like the missing-input case we must refuse to render as silence.
      const windowCount = Math.max(
        0,
        Math.min(
          lastSampleExclusive - windowStart + 2,
          request.trackSamples - windowStart,
        ),
      );
      let reader: SliceReader;
      try {
        const slice = await requestAudio(windowStart, windowCount);
        reader = createSliceReader(slice, request.trackSamples);
      } catch (error) {
        if (error instanceof ExportIntervalError && !error.frameRange) {
          error.frameRange = {
            start: rendered / request.fps,
            end: end / request.fps,
          };
        }
        throw error;
      }
      timeline.bind(reader.read);

      for (let index = rendered; index < end; index++) {
        checkCancelled();
        if (encoderError) throw encoderError;
        // Audio for exactly the span that this frame covers, emitted before
        // the frame so block interleaving is frame-driven and segment-agnostic.
        // The final frame also flushes the tail of the selection.
        await advanceAudio(
          index + 1 === frameCount
            ? Math.max(timeline.frameSample(index + 1), audioEnd)
            : timeline.frameSample(index + 1),
          reader.planar,
        );
        const analysis = timeline.analysisAt(index);
        timeline.draw(index, analysis);

        const timestamp = Math.round((index * 1e6) / request.fps);
        const next = Math.round(((index + 1) * 1e6) / request.fps);
        const frame = new VideoFrame(timeline.canvas, {
          timestamp,
          duration: next - timestamp,
        });
        videoEncoder.encode(frame, {
          keyFrame: index % Math.max(1, Math.round(request.fps * 2)) === 0,
        });
        frame.close();


        // Deterministic digest: analysis values plus a fixed pixel sample.
        digest.number(analysis.rms);
        digest.number(analysis.bass);
        digest.number(analysis.beat ? 1 : 0);
        for (let k = 0; k < analysis.bins.length; k += 8) {
          digest.number(analysis.bins[k]);
        }
        if (previewContext) {
          previewContext.drawImage(timeline.canvas, 0, 0, preview.width, preview.height);
          const pixels = previewContext.getImageData(
            0,
            0,
            preview.width,
            preview.height,
          ).data;
          digest.bytes(pixels);
          const now = Date.now();
          if (now - lastPreview > 250) {
            lastPreview = now;
            const copy = new Uint8ClampedArray(pixels);
            post(
              {
                type: "preview",
                width: preview.width,
                height: preview.height,
                pixels: copy.buffer,
              },
              [copy.buffer],
            );
          }
        }

        if (videoEncoder.encodeQueueSize > 4) {
          await new Promise<void>((resolve) => {
            const onDequeue = () => {
              if (videoEncoder.encodeQueueSize <= 4) {
                videoEncoder.removeEventListener("dequeue", onDequeue);
                resolve();
              }
            };
            videoEncoder.addEventListener("dequeue", onDequeue);
          });
        }
      }


      rendered = end;
      segment++;
      timeline.release();
      await mux.drain();
      checkCancelled();
      post({
        type: "progress",
        renderedFrames: rendered,
        totalFrames: frameCount,
        bytesWritten: sink.size(),
        segment,
      });
      // Let the message queue run so a cancel is observed promptly.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    checkCancelled();
    if (pendingFrames > 0) {
      const blocks = pendingAudio.map((channel) =>
        channel.subarray(0, pendingFrames),
      );
      const timestampUs = ((pendingStart - request.startSample) / rate) * 1e6;
      await audio.push(blocks, timestampUs, pendingFrames);
      pendingFrames = 0;
    }
    await videoEncoder.flush();
    videoEncoder.close();
    await audio.close();
    await mux.finalize();

    const memory = sink.memory();
    const payload = memory ? memory.slice() : null;
    post(
      {
        type: "done",
        file: sink.handle,
        memory: payload ? payload.buffer : null,
        fileName: request.fileName,
        mime: "video/webm",
        frameCount,
        duration,
        codec,
        digest: digest.finish(),
        size: sink.size(),
      },
      payload ? [payload.buffer] : [],
    );
    activeSink = undefined;
    if (payload) await sink.dispose();
  } catch (error) {
    try {
      videoEncoder.close();
    } catch {
      /* already closed */
    }
    audioWriter?.cancel();
    await mux.fail();
    activeSink = undefined;
    throw error;
  }
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled = true;
    for (const [, entry] of pendingAudio) entry.reject(new ExportCancelledError());
    pendingAudio.clear();
    return;
  }
  if (message.type === "audio") {
    const entry = pendingAudio.get(message.id);
    if (!entry) return;
    pendingAudio.delete(message.id);
    if (message.error || !message.slice) {
      entry.reject(new Error(message.error ?? "音频分片不可用"));
    } else {
      entry.resolve(message.slice);
    }
    return;
  }
  if (message.type !== "start") return;

  cancelled = false;
  const runGeneration = ++generation;
  try {
    await run(message.request);
  } catch (error) {
    const cancelledNow = cancelled || error instanceof ExportCancelledError;
    const intervals =
      error instanceof ExportIntervalError ? error.intervals : [];
    post({
      type: "error",
      message: cancelledNow
        ? "导出已取消"
        : error instanceof Error
          ? error.message
          : String(error ?? "导出失败"),
      intervals,
      frameRange:
        error instanceof ExportIntervalError ? error.frameRange : undefined,
      cancelled: cancelledNow,
    });
    if (runGeneration === generation) {
      await activeSink?.dispose().catch(() => {});
      activeSink = undefined;
    }
  }
};
