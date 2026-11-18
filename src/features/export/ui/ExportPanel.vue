<script setup lang="ts">
import { computed } from "vue";
import {
  Download,
  CircleStop,
  AlertTriangle,
  Check,
  LoaderCircle,
  ListVideo,
} from "lucide-vue-next";
import type { Exporter } from "../model/engine";
import { RESOLUTIONS, FRAME_RATES } from "../model/engine";
import { bytesLabel, precise } from "../lib/format";
import { clock } from "../../../shared/math";

const props = defineProps<{ exporter: Exporter }>();
const emit = defineEmits<{ locate: [{ start: number; end: number } | null] }>();

const available = computed(() => props.exporter.available());
const ready = computed(
  () =>
    available.value.ok &&
    props.exporter.settings.duration > 0 &&
    props.exporter.state.status === "idle",
);
const progress = computed(() => {
  const { renderedFrames, totalFrames } = props.exporter.state;
  return totalFrames ? Math.min(1, renderedFrames / totalFrames) : 0;
});
const errorLabel = computed(() => {
  const { errorFrames } = props.exporter.state;
  if (!errorFrames) return "";
  return `${precise(errorFrames.start)} – ${precise(errorFrames.end)}`;
});

function applyDuration(seconds: number) {
  const source = available.value;
  if (!source.ok) return;
  props.exporter.setRange(props.exporter.settings.start, seconds);
  emit("locate", null);
}

function useStart() {
  const source = available.value;
  if (!source.ok) return;
  props.exporter.setRange(0, source.duration);
  emit("locate", null);
}

function locate(interval: { start: number; end: number }) {
  emit("locate", interval);
}
</script>
<template>
  <section class="panel export-panel">
    <div class="panel-heading">
      <span>06 / OFFLINE EXPORT</span
      ><span>{{ exporter.settings.width }} × {{ exporter.settings.height }}</span>
    </div>
    <h3>把选段，逐帧渲染。</h3>

    <template v-if="available.ok">
      <p class="muted export-source">
        {{ available.name }} · 可导出 {{ clock(available.duration) }}
      </p>

      <div class="export-row">
        <label>
          <span>起始</span>
          <input
            type="number"
            min="0"
            :max="Math.max(0, available.duration)"
            step="0.1"
            :value="exporter.settings.start"
            @input="
              exporter.setRange(
                Number(($event.target as HTMLInputElement).value),
                exporter.settings.duration,
              )
            "
          />
        </label>
        <label>
          <span>时长</span>
          <input
            type="number"
            min="0.1"
            :max="Math.max(0, available.duration - exporter.settings.start)"
            step="0.1"
            :value="exporter.settings.duration"
            @input="
              exporter.setRange(
                exporter.settings.start,
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </label>
      </div>
      <div class="export-quick">
        <button type="button" @click="useStart">整段</button>
        <button type="button" @click="applyDuration(15)">15s</button>
        <button type="button" @click="applyDuration(30)">30s</button>
        <button type="button" @click="applyDuration(60)">60s</button>
      </div>

      <div class="export-row">
        <label>
          <span>分辨率</span>
          <select v-model.number="exporter.settings.width" @change="
            exporter.settings.height =
              RESOLUTIONS.find((r) => r.width === exporter.settings.width)
                ?.height ?? exporter.settings.height
          ">
            <option v-for="r in RESOLUTIONS" :key="r.label" :value="r.width">
              {{ r.label }}
            </option>
          </select>
        </label>
        <label>
          <span>帧率</span>
          <select v-model.number="exporter.settings.fps">
            <option v-for="f in FRAME_RATES" :key="f" :value="f">
              {{ f }} FPS
            </option>
          </select>
        </label>
      </div>

      <label class="control export-bitrate"
        >码率 <b>{{ (exporter.settings.bitrate / 1e6).toFixed(0) }} Mbps</b
        ><input
          type="range"
          min="2000000"
          max="30000000"
          step="1000000"
          v-model.number="exporter.settings.bitrate"
      /></label>

      <div v-if="exporter.state.status === 'running'" class="export-progress">
        <div class="bar"><i :style="{ width: `${progress * 100}%` }"></i></div>
        <small
          >渲染 {{ exporter.state.renderedFrames }} /
          {{ exporter.state.totalFrames }} 帧 ·
          {{ bytesLabel(exporter.state.bytesWritten) }} ·
          第 {{ exporter.state.segment }} 段</small
        >
      </div>

      <button
        class="record-button export-button"
        :disabled="!ready && exporter.state.status === 'idle'"
        @click="
          exporter.state.status === 'running'
            ? exporter.cancel()
            : exporter.start()
        "
      >
        <LoaderCircle
          v-if="exporter.state.status === 'running'"
          :size="14"
          class="spin"
        /><CircleStop v-else :size="14" />
        {{
          exporter.state.status === "running"
            ? "取消导出"
            : exporter.state.status === "saving"
              ? "正在保存…"
              : "开始导出"
        }}
      </button>
      <small class="muted export-hint"
        >离线逐帧渲染，不受窗口切换或卡顿影响；同素材同设置结果一致。</small
      >
    </template>

    <template v-else>
      <div class="export-blocked">
        <AlertTriangle :size="16" />
        <p>
          当前输入是麦克风，无法离线导出。<small
            >请先录制或载入一段可重放的本地音频，再选择区间导出；缺少素材的区间不会被渲染成静音。</small
          >
        </p>
      </div>
    </template>

    <p v-if="exporter.state.error" role="alert">
      {{ exporter.state.error }}
      <span v-if="errorLabel" class="export-frames">未完成帧：{{ errorLabel }}</span>
      <span v-for="i in exporter.state.errorIntervals" :key="i.start" class="export-gap">
        <button type="button" class="link" @click="locate(i)">
          定位 {{ precise(i.start) }} – {{ precise(i.end) }}
        </button>
      </span>
    </p>
    <p v-else-if="exporter.state.notice" class="export-notice">
      <Check :size="13" />{{ exporter.state.notice }}
    </p>

    <div v-if="exporter.preview.current" class="export-preview">
      <img :src="exporter.preview.current.url" alt="导出预览帧" />
      <small>渲染预览（最新帧）</small>
    </div>

    <div v-if="exporter.takes.length" class="export-takes">
      <div class="panel-heading"><span>EXPORTS</span><span>{{ exporter.takes.length.toString().padStart(2, "0") }}</span></div>
      <div v-for="take in exporter.takes" :key="take.id" class="take export-take">
        <ListVideo :size="14" />
        <div>
          <strong
            >{{ take.width }}×{{ take.height }} · {{ take.fps }} FPS</strong
          ><small
            >{{ clock(take.duration) }} · {{ bytesLabel(take.size) }} ·
            {{ take.codec.replace("vp09", "VP9").replace("vp8", "VP8") }}</small
          >
        </div>
        <button @click="exporter.download(take)"><Download :size="13" /></button>
        <button @click="exporter.remove(take.id)" aria-label="删除导出">×</button>
      </div>
    </div>
  </section>
</template>
