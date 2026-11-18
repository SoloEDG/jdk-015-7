import { clamp } from "../../../shared/math";
import type { Analysis } from "../../../shared/types";
import { ExportIntervalError } from "./errors";
import { fft } from "./fft";

/** Mirrors the live engine's AnalyserNode: fftSize 256 -> 128 bins, 256 wave samples. */
export const FFT_SIZE = 256;
export const BIN_COUNT = FFT_SIZE / 2;

/** Reads one mono sample at an absolute output-rate position; null when unavailable. */
export type MonoReader = (index: number) => number | null;

const window = new Float64Array(FFT_SIZE);
let windowGain = 0;
for (let i = 0; i < FFT_SIZE; i++) {
  window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  windowGain += window[i];
}
windowGain /= FFT_SIZE;

/**
 * Deterministic, sample-accurate stand-in for the realtime AnalyserNode.
 *
 * Offline rendering cannot use an AnalyserNode: it only produces data while a
 * realtime AudioContext runs, so the result would depend on how smoothly the
 * machine rendered. This reads decoded samples at each frame's exact position
 * instead. Smoothing state and the previous bass value live on the analyser
 * instance, which is created once per export and never rebuilt at a segment
 * boundary.
 */
export function createOfflineAnalyser(
  sampleRate: number,
  smoothing: number,
  intervalOf: (sample: number) => { start: number; end: number },
) {
  if (!(sampleRate > 0)) throw new Error("采样率无效");
  // Bound per segment so a segment can release its audio window without
  // resetting the smoothing state that spans the whole export.
  let read: MonoReader = () => null;
  const smooth = clamp(smoothing, 0, 0.95);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let previousBins = new Float32Array(BIN_COUNT);
  let previousBass = 0;

  /**
   * @param index absolute output-rate sample analysed for this frame.
   * @throws ExportIntervalError when the window needs material that is not
   *         available, so a range without input never silently becomes silence.
   */
  function at(index: number): Analysis {
    if (!Number.isInteger(index) || index < 0) {
      throw new ExportIntervalError("音频分析位置无效", [intervalOf(index)]);
    }
    const wave = new Float32Array(FFT_SIZE);
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const position = index - FFT_SIZE + 1 + i;
      const value = position < 0 ? 0 : read(position);
      if (value === null) {
        throw new ExportIntervalError("音频分析窗口缺少可重放素材", [
          intervalOf(Math.max(0, position)),
        ]);
      }
      wave[i] = value;
      energy += value * value;
    }
    const rms = Math.sqrt(energy / FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = wave[i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const bins = new Float32Array(BIN_COUNT);
    for (let k = 0; k < BIN_COUNT; k++) {
      // Coherent-gain corrected peak amplitude of a sinusoid in this bin.
      const magnitude =
        (2 * Math.sqrt(re[k] * re[k] + im[k] * im[k])) /
        (FFT_SIZE * windowGain);
      const db = 20 * Math.log10(Math.max(magnitude, 1e-12));
      // AnalyserNode defaults: minDecibels -100, maxDecibels -30.
      bins[k] = smooth * previousBins[k] + (1 - smooth) * clamp((db + 100) / 70);
    }
    let bass = 0;
    for (let k = 0; k < 12; k++) bass += bins[k];
    bass /= 12;
    const beat = bass > 0.23 && bass > previousBass * 1.12;
    previousBins = bins;
    previousBass = bass;
    return {
      bins: Array.from(bins),
      wave: Array.from(wave),
      rms,
      bass,
      beat,
      time: index / sampleRate,
    };
  }

  function bind(reader: MonoReader) {
    read = reader;
  }

  return { at, bind, sampleRate };
}

export type OfflineAnalyser = ReturnType<typeof createOfflineAnalyser>;
