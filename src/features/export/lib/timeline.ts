import type { Analysis, Theme } from "../../../shared/types";
import { drawScene } from "../../visuals/lib/geometry";
import { getTheme } from "../../visuals/model/themes";
import { clamp } from "../../../shared/math";
import {
  createOfflineAnalyser,
  FFT_SIZE,
  type MonoReader,
  type OfflineAnalyser,
} from "./analysis";
import { ExportIntervalError } from "./errors";
import type { ExportSceneParams } from "./snapshot";

/** Samples of lead-in the analysis window needs before the first frame. */
export const ANALYSIS_MARGIN = FFT_SIZE - 1;

export interface TimelineOptions {
  /** Convert an absolute export-rate sample to a track time interval. */
  intervalOf: (sample: number) => { start: number; end: number };
  sampleRate: number;
  startSample: number;
  rangeSamples: number;
  trackSamples: number;
  fps: number;
  scene: ExportSceneParams;
  width: number;
  height: number;
}

/**
 * One render state for the entire export. Frame `i` is a pure function of `i`,
 * so splitting the render into segments never restarts audio smoothing, the
 * scene crossfade or the motion phase.
 */
export function createTimeline(options: TimelineOptions) {
  const {
    intervalOf,
    sampleRate,
    startSample,
    rangeSamples,
    trackSamples,
    fps,
    scene,
    width,
    height,
  } = options;

  if (!(fps > 0) || !Number.isFinite(fps)) throw new Error("帧率无效");
  if (!(sampleRate > 0)) throw new Error("采样率无效");
  if (startSample < 0) {
    throw new ExportIntervalError("所选起点早于音频开头，缺少可重放素材", [
      { start: -startSample / sampleRate, end: 0 },
    ]);
  }
  if (rangeSamples <= 0) throw new Error("所选区间为空");
  if (startSample + rangeSamples > trackSamples) {
    throw new ExportIntervalError("所选区间超出音频长度，缺少可重放素材", [
      {
        start: trackSamples / sampleRate,
        end: (startSample + rangeSamples) / sampleRate,
      },
    ]);
  }

  const analyser: OfflineAnalyser = createOfflineAnalyser(
    sampleRate,
    scene.smoothing,
    intervalOf,
  );
  const active =
    scene.scenes.find((s) => s.id === scene.activeId) ?? scene.scenes[0];
  if (!active) throw new Error("缺少可导出的场景");
  const previous = scene.previousId
    ? scene.scenes.find((s) => s.id === scene.previousId)
    : undefined;
  const theme: Theme = getTheme(active.theme);
  const previousTheme: Theme | undefined = previous
    ? getTheme(previous.theme)
    : undefined;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建离屏画布");
  const context = ctx;
  let scratch: OffscreenCanvas | undefined;
  let scratchContext: OffscreenCanvasRenderingContext2D | undefined;
  if (previous) {
    scratch = new OffscreenCanvas(width, height);
    scratchContext = scratch.getContext("2d") ?? undefined;
  }

  const duration = rangeSamples / sampleRate;
  const frameCount = Math.max(1, Math.round(duration * fps));
  const transition = Math.max(0, scene.transition);

  /** Absolute export-rate sample analysed for a frame. */
  function frameSample(index: number) {
    return startSample + Math.round((index / fps) * sampleRate);
  }

  function analysisAt(index: number): Analysis {
    const sample = frameSample(index);
    if (sample >= trackSamples) {
      throw new ExportIntervalError("音频分析窗口超出可重放素材", [
        intervalOf(sample),
      ]);
    }
    return analyser.at(sample);
  }

  function draw(index: number, analysis: Analysis) {
    const t = index / fps;
    // Phase is derived from the export clock, so it never restarts per segment.
    const phase = scene.frozen ? 0 : t * active.speed;
    // The crossfade continues from where the live stage already was when the
    // export was confirmed, and is likewise a function of the export clock.
    const mix = previous
      ? clamp(transition ? (t + scene.transitionElapsed) / transition : 1)
      : 1;
    drawScene(
      context,
      width,
      height,
      active,
      analysis,
      theme,
      phase,
      scene.sensitivity,
    );
    if (previous && mix < 1 && scratch && scratchContext) {
      drawScene(
        scratchContext,
        width,
        height,
        previous,
        analysis,
        previousTheme!,
        phase,
        scene.sensitivity,
      );
      context.globalAlpha = 1 - mix;
      context.drawImage(scratch, 0, 0);
      context.globalAlpha = 1;
    }
    if (scene.strobe && analysis.beat) {
      context.fillStyle = "#ffffff66";
      context.fillRect(0, 0, width, height);
    }
    context.fillStyle = `rgba(0,0,0,${scene.blackout ? 1 : 1 - scene.master})`;
    context.fillRect(0, 0, width, height);
  }

  return {
    canvas,
    frameCount,
    fps,
    duration,
    sampleRate,
    activeSceneId: active.id,
    frameSample,
    analysisAt,
    draw,
    /** Point analysis at the audio slice for the next batch of frames. */
    bind: (reader: MonoReader) => analyser.bind(reader),
    release: () => analyser.bind(() => null),
  };
}

export type ExportTimeline = ReturnType<typeof createTimeline>;
