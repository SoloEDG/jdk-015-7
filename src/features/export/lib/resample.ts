/**
 * Deterministic sample-rate conversion.
 *
 * The export always encodes and analyses at 48 kHz. Doing this by hand, instead
 * of through an OfflineAudioContext, keeps sample positions identical between
 * runs. `inputOffset` is expressed in input samples and may be fractional, so a
 * window that starts mid-track lines up with the global timeline exactly.
 */
export interface Resampler {
  readonly length: number;
  /** Read `count` output samples from `start`, as planar channel arrays. */
  read(start: number, count: number): Float32Array[];
}

function cubic(a: number, b: number, c: number, d: number, t: number) {
  return (
    b +
    0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)))
  );
}

export function createResampler(
  channels: Float32Array[],
  inputRate: number,
  outputRate: number,
  inputOffset: number,
  outputLength: number,
): Resampler {
  if (!channels.length) throw new Error("音轨缺少声道");
  if (!(inputRate > 0) || !(outputRate > 0)) throw new Error("采样率无效");
  if (!Number.isFinite(inputOffset) || inputOffset < 0)
    throw new Error("音频起点无效");
  if (!(outputLength > 0)) throw new Error("音频区间为空");
  const length = Math.round(outputLength);
  const step = inputRate / outputRate;
  const taps = 16;
  const half = taps / 2;
  const cutoff = Math.min(1, outputRate / inputRate) * 0.94;

  function sample(channel: Float32Array, index: number) {
    return index >= 0 && index < channel.length ? channel[index] : 0;
  }

  function read(start: number, count: number): Float32Array[] {
    const out = channels.map(() => new Float32Array(count));
    for (let n = 0; n < count; n++) {
      const k = start + n;
      if (k < 0 || k >= length) continue;
      const pos = inputOffset + k * step;
      for (let c = 0; c < channels.length; c++) {
        const channel = channels[c];
        if (outputRate >= inputRate) {
          const i = Math.floor(pos);
          const f = pos - i;
          out[c][n] = cubic(
            sample(channel, i - 1),
            sample(channel, i),
            sample(channel, i + 1),
            sample(channel, i + 2),
            f,
          );
        } else {
          let sum = 0;
          let weight = 0;
          const centre = Math.floor(pos);
          for (let j = 0; j < taps; j++) {
            const index = centre - (taps >> 1) + 1 + j;
            const x = pos - index;
            if (Math.abs(x) > half) continue;
            const sinc =
              x === 0
                ? 1
                : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
            const w =
              sinc *
              (0.42 +
                0.5 * Math.cos((Math.PI * x) / half) +
                0.08 * Math.cos((2 * Math.PI * x) / half));
            sum += sample(channel, index) * w;
            weight += w;
          }
          out[c][n] = weight ? sum / weight : 0;
        }
      }
    }
    return out;
  }

  return { length, read };
}
