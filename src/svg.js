import JSZip from "jszip";
import * as vtracerGlue from "vtracer-webapp/vtracer_webapp_bg.js";
import vtracerWasmUrl from "vtracer-webapp/vtracer_webapp_bg.wasm?url";

const $ = (id) => document.getElementById(id);
const IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|gif)$/i;
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: PicCave + visioncortex VTracer -->\n';

const state = {
  items: [],
  current: -1,
  busy: false,
  runToken: 0,
  converter: null,
  wasm: null,
  wasmPromise: null,
  views: {
    source: { scale: 1, x: 0, y: 0, drag: null },
    result: { scale: 1, x: 0, y: 0, drag: null },
  },
};

let ui;

function setStatus(label, value = 0) {
  $("status-text").textContent = label;
  $("progress").value = Math.max(0, Math.min(100, value));
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function isImage(file) {
  return (file.type && file.type.startsWith("image/")) || IMAGE_PATTERN.test(file.name);
}

function naturalCompare(a, b) {
  return a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" });
}

function sanitizeName(value, fallback = "vector") {
  const cleaned = String(value || "").replace(/[\\/:*?"<>|]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned || fallback;
}

function baseName(name) {
  return sanitizeName(name.replace(/\.[^.]+$/, ""));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function loadVTracer() {
  if (state.wasm) return state.wasm;
  if (!state.wasmPromise) {
    state.wasmPromise = (async () => {
      setStatus("正在加载 VTracer 转换引擎", 2);
      const response = await fetch(vtracerWasmUrl);
      if (!response.ok) throw new Error(`VTracer WASM ${response.status}`);
      const bytes = await response.arrayBuffer();
      const imports = { "./vtracer_webapp_bg.js": vtracerGlue };
      const { instance } = await WebAssembly.instantiate(bytes, imports);
      vtracerGlue.__wbg_set_wasm(instance.exports);
      instance.exports.__wbindgen_start();
      state.wasm = vtracerGlue;
      return state.wasm;
    })().catch((error) => {
      state.wasmPromise = null;
      throw error;
    });
  }
  return state.wasmPromise;
}

function previewParts(kind) {
  return {
    content: kind === "source" ? ui.sourcePreview : ui.resultPreview,
    stage: kind === "source" ? ui.sourceStage : ui.resultStage,
    view: state.views[kind],
  };
}

function renderView(kind) {
  const { content, stage, view } = previewParts(kind);
  content.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
  stage.classList.toggle("is-zoomed", view.scale > 1);
}

function constrainView(kind) {
  const { stage, view } = previewParts(kind);
  view.x = Math.min(0, Math.max(-stage.clientWidth * (view.scale - 1), view.x));
  view.y = Math.min(0, Math.max(-stage.clientHeight * (view.scale - 1), view.y));
}

function resetView(kind) {
  Object.assign(state.views[kind], { scale: 1, x: 0, y: 0, drag: null });
  renderView(kind);
}

function bindView(kind) {
  const { content, stage, view } = previewParts(kind);
  stage.addEventListener("wheel", (event) => {
    if (content.hidden) return;
    const nextScale = Math.min(10, Math.max(1, view.scale * (event.deltaY < 0 ? 1.14 : 1 / 1.14)));
    if (nextScale === view.scale) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const ratio = nextScale / view.scale;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    view.scale = nextScale;
    constrainView(kind);
    renderView(kind);
  }, { passive: false });
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.scale <= 1 || content.hidden) return;
    view.drag = { id: event.pointerId, px: event.clientX, py: event.clientY, x: view.x, y: view.y };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!view.drag || view.drag.id !== event.pointerId) return;
    view.x = view.drag.x + event.clientX - view.drag.px;
    view.y = view.drag.y + event.clientY - view.drag.py;
    constrainView(kind);
    renderView(kind);
  });
  const endDrag = (event) => {
    if (!view.drag || view.drag.id !== event.pointerId) return;
    view.drag = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("dblclick", () => resetView(kind));
}

function renderList() {
  ui.count.textContent = `${state.items.length} 张`;
  ui.clear.disabled = !state.items.length || state.busy;
  if (!state.items.length) {
    ui.list.innerHTML = '<div class="empty-list">尚未添加图片</div>';
    return;
  }
  ui.list.replaceChildren(...state.items.map((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `frame-row${index === state.current ? " is-active" : ""}`;
    row.innerHTML = '<span class="frame-index"></span><span class="frame-name"></span><span class="svg-file-state"></span>';
    row.querySelector(".frame-index").textContent = index + 1;
    row.querySelector(".frame-name").textContent = item.file.name;
    const marker = row.querySelector(".svg-file-state");
    marker.textContent = item.error ? "!" : item.svgText ? "SVG" : "";
    marker.classList.toggle("is-error", Boolean(item.error));
    row.title = `${item.file.name} · ${item.width} × ${item.height} · ${formatBytes(item.file.size)}`;
    if (item.error) row.title += ` · ${item.error}`;
    row.addEventListener("click", () => selectItem(index));
    return row;
  }));
}

function showResult(item) {
  ui.resultPreview.replaceChildren();
  if (!item?.svgText) {
    ui.resultPreview.setAttribute("hidden", "");
    ui.resultEmpty.hidden = false;
    ui.resultSize.textContent = "-";
    ui.resultEmpty.querySelector("span").textContent = item?.error ? "这张图片转换失败" : "等待开始转换";
    return;
  }
  const parsed = new DOMParser().parseFromString(item.svgText, "image/svg+xml").documentElement;
  [...parsed.childNodes].forEach((node) => ui.resultPreview.append(document.importNode(node, true)));
  ui.resultPreview.setAttribute("viewBox", `0 0 ${item.width} ${item.height}`);
  ui.resultPreview.removeAttribute("hidden");
  ui.resultEmpty.hidden = true;
  ui.resultSize.textContent = `${item.width} × ${item.height} · ${formatBytes(item.svgBlob.size)}`;
}

function selectItem(index) {
  if (index < 0 || index >= state.items.length) return;
  state.current = index;
  const item = state.items[index];
  ui.sourcePreview.src = item.url;
  ui.sourcePreview.hidden = false;
  ui.sourceEmpty.hidden = true;
  ui.sourceSize.textContent = `${item.width} × ${item.height} · ${formatBytes(item.file.size)}`;
  showResult(item);
  resetView("source");
  resetView("result");
  renderList();
}

function updateSummary() {
  const completed = state.items.filter((item) => item.svgText).length;
  const failed = state.items.filter((item) => item.error).length;
  ui.export.disabled = !completed || state.busy;
  if (!state.items.length) ui.result.textContent = "等待添加图片";
  else if (state.busy) ui.result.textContent = `正在转换（${completed}/${state.items.length}）`;
  else if (completed) ui.result.textContent = `转换完成：${completed} 张${failed ? `，失败 ${failed} 张` : ""}`;
  else ui.result.textContent = `${state.items.length} 张待转换`;
}

function invalidateResults() {
  state.items.forEach((item) => { item.svgText = ""; item.svgBlob = null; item.error = ""; });
  if (state.current >= 0) showResult(state.items[state.current]);
  renderList();
  updateSummary();
}

async function probeImage(file) {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

async function addFiles(incoming) {
  const accepted = incoming.filter(isImage);
  if (!accepted.length) {
    setStatus("没有找到浏览器支持的位图图片", 0);
    return;
  }
  const additions = [];
  for (const file of accepted) {
    try {
      const size = await probeImage(file);
      additions.push({ file, ...size, url: URL.createObjectURL(file), svgText: "", svgBlob: null, error: "" });
    } catch {
      // 浏览器不能解码的文件不进入队列，避免批处理中途才失败。
    }
  }
  state.items.push(...additions);
  state.items.sort(naturalCompare);
  if (state.current < 0 && state.items.length) selectItem(0);
  else renderList();
  ui.run.disabled = !state.items.length;
  updateSummary();
  setStatus(`已添加 ${additions.length} 张图片，共 ${state.items.length} 张`, 0);
}

function clearFiles() {
  stopConversion();
  state.items.forEach((item) => URL.revokeObjectURL(item.url));
  state.items = [];
  state.current = -1;
  ui.sourcePreview.removeAttribute("src");
  ui.sourcePreview.hidden = true;
  ui.sourceEmpty.hidden = false;
  ui.sourceSize.textContent = "-";
  showResult(null);
  ui.run.disabled = true;
  renderList();
  updateSummary();
  setStatus("已清空矢量转换素材", 0);
}

function bindDrop() {
  ["dragenter", "dragover"].forEach((name) => ui.drop.addEventListener(name, (event) => {
    event.preventDefault();
    ui.drop.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => ui.drop.addEventListener(name, (event) => {
    event.preventDefault();
    ui.drop.classList.remove("is-dragging");
  }));
  ui.drop.addEventListener("drop", (event) => addFiles([...event.dataTransfer.files]));
  ui.drop.addEventListener("click", () => ui.input.click());
  ui.drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); ui.input.click(); }
  });
  ui.input.addEventListener("click", (event) => event.stopPropagation());
  ui.input.addEventListener("change", () => { addFiles([...ui.input.files]); ui.input.value = ""; });
}

function readSettings() {
  return {
    clustering: ui.clustering.value,
    hierarchical: ui.hierarchical.value,
    mode: ui.mode.value,
    speckle: Number(ui.speckle.value),
    colorPrecision: Number(ui.colorPrecision.value),
    layerDifference: Number(ui.layerDifference.value),
    corner: Number(ui.corner.value),
    length: Number(ui.length.value),
    splice: Number(ui.splice.value),
    pathPrecision: Number(ui.pathPrecision.value),
  };
}

function updateSettingLabels() {
  $("svg-speckle-value").textContent = ui.speckle.value;
  $("svg-color-value").textContent = ui.colorPrecision.value;
  $("svg-layer-value").textContent = ui.layerDifference.value;
  $("svg-corner-value").textContent = `${ui.corner.value}°`;
  $("svg-length-value").textContent = ui.length.value;
  $("svg-splice-value").textContent = `${ui.splice.value}°`;
  $("svg-path-value").textContent = ui.pathPrecision.value;
  ui.hierarchicalField.hidden = ui.clustering.value !== "color";
  document.querySelectorAll(".svg-color-option").forEach((node) => { node.hidden = ui.clustering.value !== "color"; });
  document.querySelectorAll(".svg-spline-option").forEach((node) => { node.hidden = ui.mode.value !== "spline"; });
}

const presets = {
  illustration: { speckle: 4, colorPrecision: 6, layerDifference: 16, corner: 60, length: 4, splice: 45, pathPrecision: 8, mode: "spline" },
  photo: { speckle: 10, colorPrecision: 8, layerDifference: 48, corner: 180, length: 4, splice: 45, pathPrecision: 8, mode: "spline" },
  pixel: { speckle: 0, colorPrecision: 8, layerDifference: 0, corner: 180, length: 4, splice: 45, pathPrecision: 8, mode: "none" },
};

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  Object.entries(preset).forEach(([key, value]) => { ui[key].value = String(value); });
  updateSettingLabels();
  invalidateResults();
}

function markCustom() {
  if (ui.preset.value !== "custom") {
    ui.preset.value = "custom";
    ui.preset.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function stopConversion() {
  if (!state.busy && !state.converter) return;
  state.runToken += 1;
  if (state.converter) {
    state.converter.free();
    state.converter = null;
  }
}

function setBusy(busy) {
  state.busy = busy;
  ui.run.disabled = !busy && !state.items.length;
  ui.run.querySelector("span").textContent = busy ? "取消转换" : "开始转换";
  ui.run.querySelector("svg")?.setAttribute("data-lucide", busy ? "square" : "play");
  ui.clear.disabled = busy || !state.items.length;
  updateSummary();
}

function converterParams(settings) {
  return JSON.stringify({
    canvas_id: ui.workCanvas.id,
    svg_id: ui.workOutput.id,
    mode: settings.mode,
    clustering_mode: settings.clustering,
    hierarchical: settings.hierarchical,
    corner_threshold: settings.corner / 180 * Math.PI,
    length_threshold: settings.length,
    max_iterations: 10,
    splice_threshold: settings.splice / 180 * Math.PI,
    filter_speckle: settings.speckle * settings.speckle,
    color_precision: 8 - settings.colorPrecision,
    layer_difference: settings.layerDifference,
    path_precision: settings.pathPrecision,
  });
}

function prepareTransparentPixels(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const candidates = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
  const used = candidates.map(() => false);
  let hasAlpha = false;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] < 255) hasAlpha = true;
    else {
      candidates.forEach((color, index) => {
        if (!used[index] && Math.max(
          Math.abs(image.data[offset] - color[0]),
          Math.abs(image.data[offset + 1] - color[1]),
          Math.abs(image.data[offset + 2] - color[2]),
        ) <= 8) used[index] = true;
      });
    }
  }
  if (!hasAlpha) return null;
  const key = candidates.find((_, index) => !used[index]) || [1, 254, 1];
  const alpha = new Uint8Array(width * height);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    alpha[offset / 4] = image.data[offset + 3];
    if (image.data[offset + 3] !== 0) continue;
    image.data[offset] = key[0];
    image.data[offset + 1] = key[1];
    image.data[offset + 2] = key[2];
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return {
    alpha,
    keyColor: `#${key.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase(),
  };
}

function removeTransparencyKey(svg, keyColor) {
  if (!keyColor) return;
  const key = [1, 3, 5].map((offset) => Number.parseInt(keyColor.slice(offset, offset + 2), 16));
  svg.querySelectorAll("path").forEach((path) => {
    const fill = /fill:\s*#([0-9a-f]{6})/i.exec(path.getAttribute("style") || "")?.[1];
    if (!fill) return;
    const color = [0, 2, 4].map((offset) => Number.parseInt(fill.slice(offset, offset + 2), 16));
    if (Math.max(...color.map((value, index) => Math.abs(value - key[index]))) <= 8) path.remove();
  });
}

async function applyAlphaClip(alpha, settings, token, index, total, wasm, context, width, height) {
  const colorNodes = [...ui.workOutput.childNodes].map((node) => node.cloneNode(true));
  if (!alpha.some((value) => value >= 8)) {
    ui.workOutput.replaceChildren();
    return;
  }
  const mask = context.createImageData(width, height);
  for (let pixel = 0, offset = 0; pixel < alpha.length; pixel += 1, offset += 4) {
    const value = alpha[pixel] >= 8 ? 0 : 255;
    mask.data[offset] = value;
    mask.data[offset + 1] = value;
    mask.data[offset + 2] = value;
    mask.data[offset + 3] = 255;
  }
  context.putImageData(mask, 0, 0);
  ui.workOutput.replaceChildren();
  const converter = wasm.BinaryImageConverter.new_with_string(converterParams(settings));
  state.converter = converter;
  converter.init();
  await runIncremental(converter, token, (progress) => {
    const itemProgress = 85 + progress * 0.15;
    setStatus(`正在生成透明轮廓（${index + 1}/${total}）`, ((index + itemProgress / 100) / total) * 100);
  });
  converter.free();
  state.converter = null;

  const namespace = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(namespace, "defs");
  const clipPath = document.createElementNS(namespace, "clipPath");
  const clipId = "piccave-alpha-clip";
  clipPath.setAttribute("id", clipId);
  ui.workOutput.querySelectorAll("path").forEach((path) => clipPath.append(path.cloneNode(true)));
  defs.append(clipPath);
  const group = document.createElementNS(namespace, "g");
  group.setAttribute("clip-path", `url(#${clipId})`);
  group.append(...colorNodes);
  ui.workOutput.replaceChildren(defs, group);
}

function runIncremental(converter, token, onProgress) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (token !== state.runToken) { reject(new DOMException("Cancelled", "AbortError")); return; }
      try {
        let done = false;
        const start = performance.now();
        while (!(done = converter.tick()) && performance.now() - start < 25) { /* 增量计算时间片 */ }
        onProgress(converter.progress());
        if (done) resolve();
        else setTimeout(tick, 1);
      } catch (error) { reject(error); }
    };
    setTimeout(tick, 1);
  });
}

async function convertItem(item, settings, token, index, total, wasm) {
  const bitmap = await createImageBitmap(item.file);
  ui.workCanvas.width = bitmap.width;
  ui.workCanvas.height = bitmap.height;
  const context = ui.workCanvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const transparency = prepareTransparentPixels(context, item.width, item.height);
  ui.workOutput.replaceChildren();
  ui.workOutput.setAttribute("viewBox", `0 0 ${item.width} ${item.height}`);

  const Converter = settings.clustering === "color" ? wasm.ColorImageConverter : wasm.BinaryImageConverter;
  const converter = Converter.new_with_string(converterParams(settings));
  state.converter = converter;
  converter.init();
  await runIncremental(converter, token, (progress) => {
    const itemProgress = transparency ? progress * 0.85 : progress;
    const overall = ((index + itemProgress / 100) / total) * 100;
    setStatus(`正在转换 ${item.file.name}（${index + 1}/${total}）`, overall);
  });
  converter.free();
  state.converter = null;
  if (transparency) {
    removeTransparencyKey(ui.workOutput, transparency.keyColor);
    await applyAlphaClip(transparency.alpha, settings, token, index, total, wasm, context, item.width, item.height);
  }

  const clone = ui.workOutput.cloneNode(true);
  clone.removeAttribute("id");
  clone.removeAttribute("hidden");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `0 0 ${item.width} ${item.height}`);
  clone.setAttribute("width", String(item.width));
  clone.setAttribute("height", String(item.height));
  item.svgText = XML_HEADER + new XMLSerializer().serializeToString(clone);
  item.svgBlob = new Blob([item.svgText], { type: "image/svg+xml;charset=utf-8" });
}

async function runConversion() {
  if (state.busy) {
    stopConversion();
    setStatus("已取消 SVG 转换", 0);
    return;
  }
  if (!state.items.length) return;
  const token = ++state.runToken;
  const settings = readSettings();
  invalidateResults();
  setBusy(true);
  try {
    const wasm = await loadVTracer();
    for (let index = 0; index < state.items.length; index += 1) {
      if (token !== state.runToken) throw new DOMException("Cancelled", "AbortError");
      const item = state.items[index];
      try {
        await convertItem(item, settings, token, index, state.items.length, wasm);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        item.error = error.message || "转换失败";
        state.converter?.free();
        state.converter = null;
      }
      if (index === state.current) showResult(item);
      renderList();
      updateSummary();
    }
    setStatus(`SVG 转换完成：${state.items.filter((item) => item.svgText).length} 张`, 100);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("VTracer 转换失败：", error);
      setStatus(`SVG 转换失败：${error.message || error}`, 0);
    }
  } finally {
    if (token === state.runToken) state.converter = null;
    setBusy(false);
    if (state.current >= 0) showResult(state.items[state.current]);
    renderList();
  }
}

async function exportResults() {
  const results = state.items.filter((item) => item.svgBlob);
  if (!results.length) return;
  if (results.length === 1) {
    downloadBlob(results[0].svgBlob, `${baseName(results[0].file.name)}.svg`);
    setStatus("已导出 1 个 SVG", 100);
    return;
  }
  setStatus("正在打包 SVG", 5);
  const zip = new JSZip();
  const used = new Set();
  results.forEach((item, index) => {
    const stem = baseName(item.file.name) || `vector_${index + 1}`;
    let name = `${stem}.svg`;
    let suffix = 2;
    while (used.has(name)) name = `${stem}_${suffix++}.svg`;
    used.add(name);
    zip.file(name, item.svgText);
  });
  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => setStatus("正在打包 SVG", 5 + meta.percent * 0.94),
  );
  downloadBlob(blob, `piccave_svg_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
  setStatus(`已导出 ${results.length} 个 SVG`, 100);
}

export function initSvgModule() {
  ui = {
    count: $("svg-count"), clear: $("svg-clear"), drop: $("svg-drop"), input: $("svg-input"), list: $("svg-list"),
    sourceStage: $("svg-source-stage"), sourcePreview: $("svg-source-preview"), sourceEmpty: $("svg-source-empty"), sourceSize: $("svg-source-size"),
    resultStage: $("svg-result-stage"), resultPreview: $("svg-result-preview"), resultEmpty: $("svg-result-empty"), resultSize: $("svg-result-size"),
    clustering: $("svg-clustering"), hierarchical: $("svg-hierarchical"), hierarchicalField: $("svg-hierarchical-field"),
    mode: $("svg-mode"), preset: $("svg-preset"), speckle: $("svg-speckle"), colorPrecision: $("svg-color-precision"),
    layerDifference: $("svg-layer-difference"), corner: $("svg-corner"), length: $("svg-length"), splice: $("svg-splice"), pathPrecision: $("svg-path-precision"),
    workCanvas: $("svg-work-canvas"), workOutput: $("svg-work-output"), result: $("svg-result"), run: $("svg-run"), export: $("svg-export"),
  };
  bindDrop();
  bindView("source");
  bindView("result");
  ui.clear.addEventListener("click", clearFiles);
  ui.run.addEventListener("click", runConversion);
  ui.export.addEventListener("click", exportResults);
  ui.preset.addEventListener("change", () => applyPreset(ui.preset.value));
  [ui.clustering, ui.hierarchical, ui.mode].forEach((control) => control.addEventListener("change", () => {
    if (state.busy) stopConversion();
    updateSettingLabels();
    invalidateResults();
  }));
  [ui.speckle, ui.colorPrecision, ui.layerDifference, ui.corner, ui.length, ui.splice, ui.pathPrecision].forEach((control) => {
    control.addEventListener("input", () => {
      if (state.busy) stopConversion();
      markCustom();
      updateSettingLabels();
      invalidateResults();
    });
  });
  updateSettingLabels();
  renderList();
  updateSummary();
}
