const cache = new Map<number, Float32Array<ArrayBuffer>[]>();

/**
 * Deterministic demo material, generated the same way at any sample rate.
 * Cached because the export panel asks for it on every render.
 */
export function demoChannels(rate: number): Float32Array<ArrayBuffer>[] {
  const cached = cache.get(rate);
  if (cached) return cached;
  const generated = generate(rate);
  cache.set(rate, generated);
  return generated;
}

function generate(rate: number): Float32Array<ArrayBuffer>[] {
  const length = Math.round(rate * 16);
  return [0, 1].map((c) => {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / rate,
        beat = t % 0.5,
        bar = Math.floor(t / 2) % 4,
        notes = [110, 130.81, 98, 146.83];
      const kick =
        Math.sin(2 * Math.PI * (48 * beat + 12 * (1 - Math.exp(-beat * 35)))) *
        Math.exp(-beat * 14);
      const pad =
        Math.sin(t * Math.PI * 2 * notes[bar]) * 0.14 +
        Math.sin(t * Math.PI * 2 * notes[bar] * 1.5) * 0.07;
      const hat =
        ((Math.sin(i * 78.233 + c * 2) * 43758.5453) % 1) *
        Math.exp(-(t % 0.25) * 90) *
        0.12;
      d[i] = (kick * 0.65 + pad + hat) * 0.7;
    }
    return d;
  });
}

/** Fixed 48 kHz: the demo sounds and exports identically on every device. */
export const DEMO_RATE = 48_000;

export function demoBuffer(ctx: BaseAudioContext): AudioBuffer {
  const channels = demoChannels(DEMO_RATE);
  const b = ctx.createBuffer(channels.length, channels[0].length, DEMO_RATE);
  channels.forEach((data, c) => b.copyToChannel(data, c));
  return b;
}
