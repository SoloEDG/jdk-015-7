import { ExportIntervalError } from "./errors";
import { createResampler } from "./resample";

/**
 * Renderer-facing view of one audio slice, addressed in export-rate samples.
 *
 * Resampling is derived from the absolute output position, so a slice edge
 * never shifts the audio: the same sample has the same value no matter which
 * segment asked for it.
 */
export function createSliceReader(
  slice: {
    channels: Float32Array[];
    inputRate: number;
    inputStart: number;
    inputCount: number;
    outputStart: number;
    outputCount: number;
    outputRate: number;
  },
  trackSamples: number,
) {
  const { channels, inputRate, inputStart, inputCount, outputStart, outputCount, outputRate } =
    slice;
  if (!channels.length) throw new Error("音频分片缺少声道");
  if (!(inputRate > 0) || !(outputRate > 0)) throw new Error("采样率无效");
  if (!(outputCount >= 0)) throw new Error("音频分片长度无效");

  const step = inputRate / outputRate;
  // Absolute input position of the first requested output sample.
  const absolute = outputStart * step;
  const offset = absolute - inputStart;
  const resampler =
    outputCount > 0
      ? createResampler(channels, inputRate, outputRate, offset, outputCount)
      : undefined;

  const end = Math.min(outputStart + outputCount, trackSamples);

  function read(index: number): number | null {
    if (!Number.isInteger(index)) return null;
    // Before the track starts the live analyser also sees nothing but zeros.
    if (index < 0) return 0;
    if (index >= end) return null;
    const local = index - outputStart;
    if (!resampler || local < 0 || local >= outputCount) return null;
    const [left, right] = resampler.read(local, 1);
    return ((left?.[0] ?? 0) + (right?.[0] ?? 0)) / 2;
  }

  /** Planar export-rate samples for [from, from + length). */
  function planar(from: number, length: number): Float32Array[] {
    const local = from - outputStart;
    if (!resampler || local < 0 || local + length > outputCount) {
      throw new ExportIntervalError("音频分片缺少可重放素材", [
        { start: from / outputRate, end: (from + length) / outputRate },
      ]);
    }
    return resampler.read(local, length);
  }

  return { read, planar, outputStart, outputCount, outputRate, end };
}

export type SliceReader = ReturnType<typeof createSliceReader>;
