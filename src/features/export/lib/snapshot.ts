import type { Scene, StageDocument } from "../../../shared/types";

/**
 * Everything the offline renderer is allowed to look at. It is a deep copy made
 * when the export is confirmed, so theme/scene edits made afterwards on the live
 * stage cannot leak into the frames.
 */
export interface ExportSceneParams {
  scenes: Scene[];
  activeId: string;
  /** Scene that was still fading out on the live stage when export started. */
  previousId: string | null;
  /** Seconds of the live crossfade that had already elapsed. */
  transitionElapsed: number;
  transition: number;
  sensitivity: number;
  smoothing: number;
  blackout: boolean;
  frozen: boolean;
  strobe: boolean;
  master: number;
}

export function captureSceneParams(
  doc: StageDocument,
  fading: { from: string; elapsed: number } | null,
): ExportSceneParams {
  const activeId = doc.scenes.some((s) => s.id === doc.activeId)
    ? doc.activeId
    : doc.scenes[0]?.id;
  if (!activeId) throw new Error("没有可导出的场景");
  return {
    scenes: doc.scenes.map((s) => ({ ...s })),
    activeId,
    previousId:
      fading &&
      fading.from !== activeId &&
      doc.scenes.some((s) => s.id === fading.from)
        ? fading.from
        : null,
    transitionElapsed: fading ? Math.max(0, fading.elapsed) : 0,
    transition: doc.transition,
    sensitivity: doc.sensitivity,
    smoothing: doc.smoothing,
    blackout: doc.blackout,
    frozen: doc.frozen,
    strobe: doc.strobe,
    master: doc.master,
  };
}
