import type { ExportInterval } from "./errors";
import type { ExportSceneParams } from "./snapshot";

/** Native-rate audio for one segment, sliced from the captured track. */
export interface AudioSlice {
  /** Planar channels; channel 0's first sample is `inputStart`. */
  channels: Float32Array[];
  /** Native rate of the decoded track. */
  inputRate: number;
  /** Absolute native-rate sample index of channels[0][0]. */
  inputStart: number;
  /** Native-rate samples available in this slice. */
  inputCount: number;
  /** Absolute export-rate position of the first sample this slice must produce. */
  outputStart: number;
  /** Export-rate samples this slice must produce. */
  outputCount: number;
  /** Export rate (analysis and encoding rate). */
  outputRate: number;
}

/** Everything the offline render is pinned to when the user confirms. */
export interface RenderRequest {
  width: number;
  height: number;
  fps: number;
  /** Export rate: analysis and Opus encoding both run at this rate. */
  sampleRate: number;
  /** Native sample rate of the captured track. */
  inputRate: number;
  /** Absolute export-rate sample of the first exported sample. */
  startSample: number;
  /** Export-rate samples in the selection. */
  rangeSamples: number;
  /** Export-rate samples in the whole captured track. */
  trackSamples: number;
  /** Native-rate samples in the whole captured track. */
  inputSamples: number;
  scene: ExportSceneParams;
  bitrate: number;
  fileName: string;
  /** Frames rendered between two audio-slice fetches. */
  segmentFrames: number;
}

export type WorkerRequest =
  | { type: "start"; request: RenderRequest }
  | { type: "cancel" }
  | { type: "audio"; id: number; slice: AudioSlice | null; error?: string };

export type WorkerMessage =
  | {
      type: "audio-request";
      id: number;
      /** Export-rate range the worker needs. */
      outputStart: number;
      outputCount: number;
    }
  | {
      type: "progress";
      renderedFrames: number;
      totalFrames: number;
      bytesWritten: number;
      segment: number;
    }
  | {
      type: "preview";
      width: number;
      height: number;
      /** RGBA pixels of a small preview frame. */
      pixels: ArrayBuffer;
    }
  | {
      type: "done";
      file: FileSystemFileHandle | null;
      memory: ArrayBuffer | null;
      fileName: string;
      mime: string;
      frameCount: number;
      duration: number;
      codec: string;
      /** Digest of the deterministic analysis timeline (not of encoder bytes). */
      digest: string;
      size: number;
    }
  | {
      type: "error";
      message: string;
      intervals: ExportInterval[];
      frameRange?: { start: number; end: number };
      cancelled?: boolean;
    };
