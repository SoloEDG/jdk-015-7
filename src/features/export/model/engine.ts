import { reactive } from "vue";
import type { StageDocument } from "../../../shared/types";
import type { AudioEngine } from "../../audio";
import type { SceneStore } from "../../scenes";
import {
  captureSceneParams,
  type ExportSceneParams,
} from "../lib/snapshot";
import {
  ExportIntervalError,
  type ExportInterval,
} from "../lib/errors";
import type {
  AudioSlice,
  RenderRequest,
  WorkerMessage,
} from "../lib/protocol";
import { deleteExportFile } from "../lib/sink";

export const RESOLUTIONS = [
  { label: "854 × 480", width: 854, height: 480 },
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "1920 × 1080", width: 1920, height: 1080 },
  { label: "2560 × 1440", width: 2560, height: 1440 },
] as const;

export const FRAME_RATES = [24, 25, 30, 50, 60] as const;

export const EXPORT_RATE = 48_000;
/**
 * Seconds of material rendered between audio-window fetches. Only memory use
 * depends on this: the render itself is a pure function of the frame index, so
 * a longer or shorter segment produces identical output.
 */
const SEGMENT_SECONDS = 4;

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  /** Seconds into the track. */
  start: number;
  /** Seconds. */
  duration: number;
  bitrate: number;
}

export interface ExportTake {
  id: string;
  fileName: string;
  url: string;
  size: number;
  duration: number;
  frameCount: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  digest: string;
  /** File handle in OPFS, kept so the export can be verified later. */
  file: FileSystemFileHandle | null;
}

export interface ExportPreview {
  width: number;
  height: number;
  url: string;
}

interface Captured {
  request: RenderRequest;
  channels: Float32Array[];
  inputRate: number;
  inputSamples: number;
}

export function createExporter(audio: AudioEngine, scenes: SceneStore, doc: StageDocument) {
  const settings = reactive<ExportSettings>({
    width: 1280,
    height: 720,
    fps: 30,
    start: 0,
    duration: 0,
    bitrate: 12_000_000,
  });
  const state = reactive({
    status: "idle" as "idle" | "running" | "saving",
    renderedFrames: 0,
    totalFrames: 0,
    bytesWritten: 0,
    segment: 0,
    error: "" as string,
    errorIntervals: [] as ExportInterval[],
    errorFrames: undefined as { start: number; end: number } | undefined,
    notice: "",
  });
  // Plain reactive field, not a nested ref: templates do not unwrap refs that
  // are reached through another object.
  const preview = reactive<{ current: ExportPreview | null }>({ current: null });
  const takes = reactive<ExportTake[]>([]);

  let worker: Worker | undefined;
  let captured: Captured | null = null;
  let startStamp = "";
  // Each run gets a generation. A worker that is cancelled or replaced may
  // still deliver a message while it cleans up; those are ignored so they can
  // never write into the state of a newer export.
  let generation = 0;

  function track() {
    return audio.capture();
  }

  /** Seconds of replayable material that can be exported right now. */
  function available() {
    const source = track();
    if (!source) return { ok: false as const, reason: "mic" as const };
    return {
      ok: true as const,
      duration: source.duration,
      name: source.name,
      sourceKind: source.source,
    };
  }

  function clampSettings() {
    const source = track();
    const limit = source?.duration ?? 0;
    settings.start = Math.min(Math.max(0, settings.start), Math.max(0, limit));
    settings.duration = Math.min(
      Math.max(0, settings.duration),
      Math.max(0, limit - settings.start),
    );
  }

  function setRange(start: number, duration: number) {
    settings.start = Math.max(0, start);
    settings.duration = Math.max(0, duration);
    clampSettings();
  }

  function detachWorker(target: Worker | undefined) {
    if (!target) return;
    target.onmessage = null;
    target.onerror = null;
    target.terminate();
  }

  /** Detach now, terminate after a grace period so the worker can clean up. */
  function retire(target: Worker) {
    target.onmessage = null;
    target.onerror = null;
    setTimeout(() => target.terminate(), 10_000);
  }

  function stopWorker() {
    detachWorker(worker);
    worker = undefined;
    captured = null;
  }

  function reset() {
    state.renderedFrames = 0;
    state.totalFrames = 0;
    state.bytesWritten = 0;
    state.segment = 0;
    state.errorIntervals = [];
    state.errorFrames = undefined;
  }

  function start() {
    if (state.status !== "idle") return;
    // A worker cancelled a moment ago may still be finishing its cleanup;
    // starting a new run must not leave two workers writing to the same state.
    if (worker) {
      const stale = worker;
      stale.postMessage({ type: "cancel" });
      worker = undefined;
      retire(stale);
    }
    reset();
    state.error = "";
    state.notice = "";
    const source = track();
    if (!source) {
      state.error =
        audio.state.source === "mic"
          ? "麦克风是实时输入，不能直接离线导出。请先录制或载入一段可重放的本地音频。"
          : "当前没有可导出的音频，请先载入本地音频。";
      return;
    }
    if (source.loading) {
      state.error = "音频仍在解码，请稍后再导出。";
      return;
    }
    if (!(settings.duration > 0)) {
      state.error = "导出区间为空，请先选择起始时间与时长。";
      return;
    }
    if (
      settings.start + settings.duration >
      // A few samples of rounding are harmless; a real overrun is not.
      source.duration + 1 / EXPORT_RATE
    ) {
      state.error = "导出区间超出音频长度，请调整起始时间或时长。";
      return;
    }

    const width = settings.width;
    const height = settings.height;
    const fps = settings.fps;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      state.error = "分辨率无效。";
      return;
    }
    if (!(fps > 0)) {
      state.error = "帧率无效。";
      return;
    }

    const inputRate = source.sampleRate;
    const inputSamples = source.channels[0]?.length ?? 0;
    // Derive the export-rate length from the decoded samples themselves so the
    // worker's slice arithmetic and its bounds agree exactly.
    const trackSamples = Math.max(
      1,
      Math.round((inputSamples * EXPORT_RATE) / inputRate),
    );
    const startSample = Math.min(
      trackSamples,
      Math.round((settings.start * EXPORT_RATE)),
    );
    const rangeSamples = Math.max(
      1,
      Math.min(
        trackSamples - startSample,
        Math.round(settings.duration * EXPORT_RATE),
      ),
    );

    let scene: ExportSceneParams;
    try {
      scene = captureSceneParams(doc, scenes.fadingAt(performance.now()));
    } catch (error) {
      state.error = error instanceof Error ? error.message : "场景快照失败";
      return;
    }

    startStamp = new Date().toISOString();
    const fileName = `${startStamp.replace(/[:.]/g, "-")}-${width}x${height}-${fps}fps.webm`;
    const request: RenderRequest = {
      width,
      height,
      fps,
      sampleRate: EXPORT_RATE,
      inputRate,
      startSample,
      rangeSamples,
      trackSamples,
      inputSamples,
      scene,
      bitrate: settings.bitrate,
      fileName,
      segmentFrames: Math.max(1, Math.round(fps * SEGMENT_SECONDS)),
    };
    state.totalFrames = Math.max(
      1,
      Math.round((rangeSamples / EXPORT_RATE) * fps),
    );
    state.status = "running";
    const gen = ++generation;
    captured = {
      request,
      channels: source.channels,
      inputRate,
      inputSamples,
    };
    const spawned = new Worker(new URL("./render.worker.ts", import.meta.url), {
      type: "module",
    });
    worker = spawned;
    spawned.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (gen !== generation) {
        if (event.data.type === "done" || event.data.type === "error") {
          detachWorker(spawned);
        }
        return;
      }
      handle(event.data);
    };
    spawned.onerror = (event) => {
      if (gen !== generation) return;
      state.error = event.message || "导出线程异常退出";
      state.status = "idle";
      stopWorker();
    };
    spawned.postMessage({ type: "start", request });
  }

  function sliceFor(outputStart: number, outputCount: number): AudioSlice {
    if (!captured) throw new Error("导出任务已结束");
    const { channels, inputRate, inputSamples } = captured;
    const step = inputRate / EXPORT_RATE;
    // Padding covers the widest resampling kernel footprint (16 taps) plus the
    // cubic interpolator's two samples, so a segment edge is sample-identical
    // to a single uninterrupted pass while its phase stays tied to the
    // absolute output position.
    const pad = Math.ceil(16 * step) + 2;
    const inputStart = Math.max(
      0,
      Math.floor(outputStart * step) - pad,
    );
    const neededEnd = Math.ceil((outputStart + outputCount) * step);
    const inputEnd = Math.min(inputSamples, neededEnd + pad);
    // If the decoded material stops before the samples this window needs, the
    // window would otherwise be padded with silence. Fail instead, with a
    // range the UI can point at. One sample of rounding is tolerated: a
    // fractional step can land a hair past the final decoded sample.
    if (neededEnd > inputSamples + 1) {
      // Report the missing span in track seconds: from the end of the decoded
      // material to the end of the requested window.
      throw new ExportIntervalError("缺少可重放素材", [
        {
          start: inputSamples / inputRate,
          end: (outputStart + outputCount) / EXPORT_RATE,
        },
      ]);
    }
    return {
      channels: channels.map((channel) =>
        channel.subarray(inputStart, inputEnd),
      ),
      inputRate,
      inputStart,
      inputCount: Math.max(0, inputEnd - inputStart),
      outputStart,
      outputCount,
      outputRate: EXPORT_RATE,
    };
  }

  function handle(message: WorkerMessage) {
    switch (message.type) {
      case "audio-request": {
        try {
          const slice = sliceFor(message.outputStart, message.outputCount);
          worker?.postMessage({ type: "audio", id: message.id, slice });
        } catch (error) {
          worker?.postMessage({
            type: "audio",
            id: message.id,
            slice: null,
            error: error instanceof Error ? error.message : "音频分片失败",
          });
        }
        return;
      }
      case "progress":
        state.renderedFrames = message.renderedFrames;
        state.totalFrames = message.totalFrames;
        state.bytesWritten = message.bytesWritten;
        state.segment = message.segment;
        return;
      case "preview": {
        const pixels = new Uint8ClampedArray(message.pixels);
        const canvas = document.createElement("canvas");
        canvas.width = message.width;
        canvas.height = message.height;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.putImageData(
          new ImageData(pixels, message.width, message.height),
          0,
          0,
        );
        void canvas.toBlob((blob) => {
          if (!blob) return;
          const previous = preview.current;
          preview.current = {
            width: message.width,
            height: message.height,
            url: URL.createObjectURL(blob),
          };
          if (previous) URL.revokeObjectURL(previous.url);
        }, "image/png");
        return;
      }
      case "done": {
        state.status = "idle";
        stopWorker();
        const blob = message.memory
          ? new Blob([message.memory], { type: message.mime })
          : null;
        const take: ExportTake = {
          id: crypto.randomUUID(),
          fileName: message.fileName,
          url: blob ? URL.createObjectURL(blob) : "",
          size: message.size,
          duration: message.duration,
          frameCount: message.frameCount,
          codec: message.codec,
          width: settings.width,
          height: settings.height,
          fps: settings.fps,
          digest: message.digest,
          file: message.file,
        };
        takes.unshift(take);
        state.notice = message.file
          ? "导出完成，文件保存在浏览器本地存储。"
          : "导出完成（当前浏览器不支持本地文件存储，仅保留在本次会话）。";
        state.renderedFrames = message.frameCount;
        return;
      }
      case "error": {
        state.status = "idle";
        stopWorker();
        state.errorIntervals = message.intervals;
        state.errorFrames = message.frameRange;
        if (message.cancelled) {
          state.error = "";
          state.notice = "导出已取消，现场演出未受影响。";
        } else {
          state.error = message.message;
        }
        return;
      }
    }
  }

  function cancel() {
    if (state.status === "idle" || !worker) return;
    // The worker aborts at its next checkpoint and deletes its partial file.
    // The live stage is untouched: audio keeps playing and recording continues.
    // Keep the captured audio available until the worker has actually stopped:
    // it may still be mid-segment and ask for one more window while unwinding.
    worker.postMessage({ type: "cancel" });
    state.status = "idle";
    state.notice = "导出已取消，现场演出未受影响。";
  }

  async function download(take: ExportTake) {
    if (take.file) {
      const file = await take.file.getFile();
      const url = URL.createObjectURL(file);
      triggerDownload(url, take.fileName);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    if (take.url) triggerDownload(take.url, take.fileName);
  }

  function remove(id: string) {
    const index = takes.findIndex((t) => t.id === id);
    if (index < 0) return;
    const take = takes[index];
    if (take.url) URL.revokeObjectURL(take.url);
    if (take.file) void deleteExportFile(take.file);
    takes.splice(index, 1);
  }

  function dispose() {
    if (preview.current) URL.revokeObjectURL(preview.current.url);
    preview.current = null;
    takes.forEach((take) => take.url && URL.revokeObjectURL(take.url));
    stopWorker();
  }

  return {
    settings,
    state,
    preview,
    takes,
    available,
    setRange,
    start,
    cancel,
    download,
    remove,
    dispose,
  };
}

function triggerDownload(url: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

export type Exporter = ReturnType<typeof createExporter>;
export { ExportIntervalError };
