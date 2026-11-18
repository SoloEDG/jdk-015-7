import { computed, shallowRef } from "vue";
import type { StageDocument } from "../../../shared/types";
export function createScenes(doc: StageDocument) {
  const active = computed(
    () => doc.scenes.find((s) => s.id === doc.activeId) ?? doc.scenes[0],
  );
  // Wall-clock record of the latest cue. An export captures it so a crossfade
  // already running on the live stage is reproduced from that same point.
  const change = shallowRef<{ from: string | null; at: number }>({
    from: null,
    at: 0,
  });
  function select(id: string) {
    if (!doc.scenes.some((s) => s.id === id)) return;
    if (doc.activeId !== id) {
      change.value = { from: doc.activeId, at: performance.now() };
    }
    doc.activeId = id;
  }
  function next() {
    select(
      doc.scenes[
        (doc.scenes.findIndex((s) => s.id === doc.activeId) + 1) %
          doc.scenes.length
      ].id,
    );
  }
  /** Crossfade progress at `now`, or null when no fade is still running. */
  function fadingAt(now: number) {
    const { from, at } = change.value;
    if (!from) return null;
    const elapsed = (now - at) / 1000;
    if (!(elapsed >= 0) || elapsed >= doc.transition) return null;
    return { from, elapsed };
  }
  return { active, change, select, next, fadingAt };
}
export type SceneStore = ReturnType<typeof createScenes>;
