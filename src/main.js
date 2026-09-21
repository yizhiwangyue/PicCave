import "./style.css";
import JSZip from "jszip";
import gifsicle from "gifsicle-wasm-browser";
import { createIcons, icons } from "lucide";
import { workerCall, onWorkerProgress, onWorkerError } from "./runtime.js";
import { initBatchModule } from "./batch.js";
import { initSpriteModule } from "./sprite.js";
import { initAlphaModule } from "./alpha.js";

createIcons({ icons });

const $ = (id) => document.getElementById(id);
const ui = {
  status: $("status-text"), progress: $("progress"),
  sequenceInput: $("sequence-input"), sequenceFolderInput: $("sequence-folder-input"), sequenceDrop: $("sequence-drop"), clearFiles: $("clear-files"),
  sequenceSourceMenu: $("sequence-source-menu"), chooseSequenceFiles: $("choose-sequence-files"), chooseSequenceFolder: $("choose-sequence-folder"),
  fileList: $("file-list"), fileCount: $("file-count"), canvas: $("preview-canvas"),
  canvasShell: $("canvas-shell"), canvasEmpty: $("canvas-empty"), prev: $("prev-frame"),
  next: $("next-frame"), play: $("play-toggle"), timeline: $("timeline"),
  previewFps: $("preview-fps"), frameIndicator: $("frame-indicator"),
  start: $("start-frame"), end: $("end-frame"), setStart: $("set-start"), setEnd: $("set-end"),
  cropX: $("crop-x"), cropY: $("crop-y"), cropW: $("crop-width"), cropH: $("crop-height"),
  applyCrop: $("apply-crop-values"), resetCrop: $("reset-crop"),
  fps: $("output-fps"), loop: $("loop-mode"), outputW: $("output-width"), outputH: $("output-height"), resolutionScale: $("resolution-scale"),
  colors: $("color-count"), transparency: $("transparency-mode"), strength: $("dither-strength"),
  compression: $("compression-preset"), rawPreview: $("raw-preview"),
  compressedPreview: $("compressed-preview"), exportGif: $("export-gif"), result: $("sequence-result"),
  gifInput: $("gif-input"), gifDrop: $("gif-drop"), gifClear: $("gif-clear"), gifCount: $("gif-count"), gifList: $("gif-list"),
  extractFormat: $("extract-format"), extractQuality: $("extract-quality"),
  extractNaming: $("extract-naming"), extractNamingList: $("extract-naming-list"),
  extractTiming: $("extract-timing"), extractWhite: $("extract-white"),
  extractButton: $("extract-button"), extractResult: $("extract-result"),
};

const state = {
  files: [], bitmaps: new Map(), current: 0, sourceWidth: 0, sourceHeight: 0,
  crop: { x: 0, y: 0, w: 0, h: 0 }, playing: false, playTimer: null,
  rawCache: null, compressedCache: null, gifFiles: [], busy: false,
  render: { x: 0, y: 0, w: 0, h: 0, scale: 1 }, drag: null,
};

onWorkerProgress((value, label) => setProgress(value, label));
onWorkerError((message) => {
  setStatus(`处理出现错误：${message}`, 0);
});

function setStatus(label, value = ui.progress.value) { ui.status.textContent = label; ui.progress.value = value; }
function setProgress(value, label) { setStatus(label, value); }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}
function naturalCompare(a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

async function initializeRuntime() {
  setStatus("正在初始化，首次加载约需数秒", 3);
  try {
    await workerCall("init");
    setStatus("功能已就绪", 0);
  } catch (error) {
    console.error("运行时初始化失败：", error);
    setStatus("初始化失败，请刷新页面重试", 0);
  }
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === tab));
  const selected = tab.dataset.tab;
  $("sequence-workspace").classList.toggle("is-active", selected === "sequence");
  $("extract-workspace").classList.toggle("is-active", selected === "extract");
  if (selected !== "sequence") stopPlayback();
  requestAnimationFrame(drawPreview);
}));

document.querySelectorAll(".module-nav").forEach((item) => item.addEventListener("click", () => {
  const module = item.dataset.module;
  document.querySelectorAll(".module-nav").forEach((navItem) => {
    const active = navItem === item;
    navItem.classList.toggle("is-active", active);
    if (active) navItem.setAttribute("aria-current", "page");
    else navItem.removeAttribute("aria-current");
  });
  // 各独立模块各自一个类。必须**逐个显式双向 toggle**：
  // 只 toggle 自己那个会让上一个模块的类残留，结果两个工作区同时显示。
  // 新增模块时：这里补一行 toggle，CSS 侧把 .is-xxx 加进成组选择器（两处都要改）。
  const shell = document.querySelector(".content-shell");
  shell.classList.toggle("is-batch", module === "batch");
  shell.classList.toggle("is-sprite", module === "sprite");
  shell.classList.toggle("is-alpha", module === "alpha");
  shell.classList.toggle("is-enhance", module === "enhance");
  if (module === "converter") {
    setStatus("序列图与 GIF 转换", 0);
    requestAnimationFrame(drawPreview);
  } else {
    stopPlayback();
    // batch 分支历史上不写 setStatus，保持原样别动
    if (module === "sprite") setStatus("序列图与精灵图转换", 0);
    if (module === "alpha") setStatus("Alpha 图批量转换", 0);
    if (module === "enhance") setStatus("AI 图片画质增强", 0);
  }
}));

function bindDropZone(zone, input, callback) {
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault(); zone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault(); zone.classList.remove("is-dragging");
  }));
  zone.addEventListener("drop", (event) => callback([...event.dataTransfer.files]));
  input.addEventListener("change", () => { callback([...input.files]); input.value = ""; });
}

bindDropZone(ui.sequenceDrop, ui.sequenceInput, loadSequence);
bindDropZone(ui.gifDrop, ui.gifInput, addGifs);
ui.sequenceFolderInput.addEventListener("change", () => {
  loadSequence([...ui.sequenceFolderInput.files]);
  ui.sequenceFolderInput.value = "";
});
[ui.sequenceInput, ui.sequenceFolderInput].forEach((input) => input.addEventListener("click", (event) => event.stopPropagation()));

function setSequenceMenu(open) {
  ui.sequenceSourceMenu.hidden = !open;
  ui.sequenceDrop.setAttribute("aria-expanded", String(open));
}
ui.sequenceDrop.addEventListener("click", (event) => {
  if (event.target.closest(".source-menu")) return;
  setSequenceMenu(ui.sequenceSourceMenu.hidden);
});
ui.sequenceDrop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setSequenceMenu(ui.sequenceSourceMenu.hidden);
  }
  if (event.key === "Escape") setSequenceMenu(false);
});
ui.chooseSequenceFiles.addEventListener("click", (event) => {
  event.stopPropagation();
  setSequenceMenu(false);
  ui.sequenceInput.click();
});
ui.chooseSequenceFolder.addEventListener("click", (event) => {
  event.stopPropagation();
  setSequenceMenu(false);
  ui.sequenceFolderInput.click();
});
document.addEventListener("click", (event) => {
  if (!ui.sequenceDrop.contains(event.target)) setSequenceMenu(false);
});

async function loadSequence(files) {
  const accepted = files.filter((file) => file.type.startsWith("image/") && file.type !== "image/gif").sort(naturalCompare);
  if (!accepted.length) return setStatus("没有找到可用的序列图片", 0);
  stopPlayback();
  releaseBitmaps();
  state.files = accepted;
  state.current = 0;
  invalidateCaches();
  setStatus("正在读取第一帧", 5);
  try {
    const first = await getBitmap(0);
    state.sourceWidth = first.width;
    state.sourceHeight = first.height;
    state.crop = { x: 0, y: 0, w: first.width, h: first.height };
    ui.outputW.value = first.width;
    ui.outputH.value = first.height;
    updateResolutionSummary();
    ui.start.value = 1;
    ui.end.value = accepted.length;
    ui.start.max = accepted.length;
    ui.end.max = accepted.length;
    ui.timeline.min = 1;
    ui.timeline.max = accepted.length;
    ui.timeline.value = 1;
    updateCropInputs();
    updateOutputFrameRange();
    setSequenceControls(true);
    renderFileList();
    updateFrameUI();
    ui.canvasEmpty.classList.add("is-hidden");
    ui.result.textContent = `${accepted.length} 帧 · 原始尺寸 ${first.width} × ${first.height}`;
    const folderName = accepted[0].webkitRelativePath?.split("/")[0];
    setStatus(folderName ? `已从文件夹 ${folderName} 载入 ${accepted.length} 帧` : "序列已载入，可播放或拖动裁剪框", 0);
    drawPreview();
  } catch (error) { setStatus(`读取图片失败：${error.message}`, 0); }
}

function setSequenceControls(enabled) {
  [ui.clearFiles, ui.prev, ui.next, ui.play, ui.timeline, ui.start, ui.end, ui.setStart, ui.setEnd,
   ui.cropX, ui.cropY, ui.cropW, ui.cropH, ui.applyCrop, ui.resetCrop,
   ui.rawPreview, ui.compressedPreview, ui.exportGif].forEach((control) => { control.disabled = !enabled; });
}
function releaseBitmaps() { state.bitmaps.forEach((bitmap) => bitmap.close()); state.bitmaps.clear(); }
async function getBitmap(index) {
  if (!state.bitmaps.has(index)) state.bitmaps.set(index, await createImageBitmap(state.files[index]));
  return state.bitmaps.get(index);
}
function renderFileList() {
  ui.fileCount.textContent = `${state.files.length} 帧`;
  ui.fileList.replaceChildren(...state.files.map((file, index) => {
    const button = document.createElement("button");
    button.className = `frame-row${index === state.current ? " is-active" : ""}`;
    button.title = file.name;
    button.innerHTML = `<span class="frame-index">${index + 1}</span><span class="frame-name"></span>`;
    button.querySelector(".frame-name").textContent = file.name;
    button.addEventListener("click", () => showFrame(index));
    return button;
  }));
}
function updateFrameUI() {
  const total = state.files.length;
  ui.timeline.value = total ? state.current + 1 : 1;
  ui.frameIndicator.textContent = total ? `${state.current + 1} / ${total}` : "0 / 0";
  ui.fileList.querySelectorAll(".frame-row").forEach((row, index) => row.classList.toggle("is-active", index === state.current));
}
async function showFrame(index) {
  if (!state.files.length) return;
  state.current = (index + state.files.length) % state.files.length;
  updateFrameUI();
  await getBitmap(state.current);
  drawPreview();
}

ui.prev.addEventListener("click", () => showFrame(state.current - 1));
ui.next.addEventListener("click", () => showFrame(state.current + 1));
ui.timeline.addEventListener("input", () => showFrame(Number(ui.timeline.value) - 1));
ui.play.addEventListener("click", () => state.playing ? stopPlayback() : startPlayback());
ui.previewFps.addEventListener("change", () => { if (state.playing) { stopPlayback(); startPlayback(); } });
function startPlayback() {
  if (!state.files.length) return;
  state.playing = true;
  ui.play.querySelector("span").textContent = "暂停";
  ui.play.querySelector("svg").outerHTML = '<i data-lucide="pause"></i>';
  createIcons({ icons });
  const tick = () => {
    if (!state.playing) return;
    showFrame(state.current + 1);
    state.playTimer = window.setTimeout(tick, 1000 / clamp(Number(ui.previewFps.value) || 24, 1, 120));
  };
  state.playTimer = window.setTimeout(tick, 1000 / clamp(Number(ui.previewFps.value) || 24, 1, 120));
}
function stopPlayback() {
  state.playing = false;
  clearTimeout(state.playTimer);
  if (ui.play.querySelector("span")) ui.play.querySelector("span").textContent = "播放";
  const svg = ui.play.querySelector("svg");
  if (svg) svg.outerHTML = '<i data-lucide="play"></i>';
  createIcons({ icons });
}

ui.setStart.addEventListener("click", () => { ui.start.value = state.current + 1; validateRange(); invalidateCaches(); });
ui.setEnd.addEventListener("click", () => { ui.end.value = state.current + 1; validateRange(); invalidateCaches(); });
[ui.start, ui.end].forEach((input) => input.addEventListener("change", () => { validateRange(); invalidateCaches(); }));
function validateRange() {
  const total = state.files.length;
  let start = clamp(Number(ui.start.value) || 1, 1, total);
  let end = clamp(Number(ui.end.value) || total, 1, total);
  if (start > end) [start, end] = [end, start];
  ui.start.value = start; ui.end.value = end;
  updateOutputFrameRange();
}

function updateOutputFrameRange() {
  const summary = $("output-frame-range");
  if (!state.files.length) {
    summary.textContent = "未设置";
    return;
  }
  const start = Number(ui.start.value) || 1;
  const end = Number(ui.end.value) || state.files.length;
  summary.textContent = `${start} - ${end}（共 ${end - start + 1} 帧）`;
}

function resizeCanvas() {
  const rect = ui.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (ui.canvas.width !== width || ui.canvas.height !== height) { ui.canvas.width = width; ui.canvas.height = height; }
  return { width, height, dpr };
}
async function drawPreview() {
  const { width, height } = resizeCanvas();
  const ctx = ui.canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  if (!state.files.length) return;
  const bitmap = await getBitmap(state.current);
  const padding = 24 * Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min((width - padding * 2) / bitmap.width, (height - padding * 2) / bitmap.height);
  const drawW = bitmap.width * scale, drawH = bitmap.height * scale;
  const x = (width - drawW) / 2, y = (height - drawH) / 2;
  state.render = { x, y, w: drawW, h: drawH, scale };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, x, y, drawW, drawH);

  const c = state.crop;
  const rx = x + c.x * scale, ry = y + c.y * scale, rw = c.w * scale, rh = c.h * scale;
  ctx.save();
  ctx.fillStyle = "rgba(12, 20, 16, .55)";
  ctx.beginPath(); ctx.rect(x, y, drawW, drawH); ctx.rect(rx, ry, rw, rh); ctx.fill("evenodd");
  ctx.strokeStyle = "#ff9a4a"; ctx.lineWidth = Math.max(2, window.devicePixelRatio || 1);
  ctx.strokeRect(rx, ry, rw, rh);
  const handle = 8 * Math.min(window.devicePixelRatio || 1, 2);
  ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#d75b15"; ctx.lineWidth = 1.5;
  for (const [hx, hy] of [[rx,ry],[rx+rw,ry],[rx,ry+rh],[rx+rw,ry+rh]]) {
    ctx.fillRect(hx-handle/2, hy-handle/2, handle, handle); ctx.strokeRect(hx-handle/2, hy-handle/2, handle, handle);
  }
  ctx.fillStyle = "rgba(48, 29, 18, .82)";
  const scaled = getScaledDimensions();
  const label = `${c.w} × ${c.h} · ${ui.resolutionScale.value}% → ${scaled.width} × ${scaled.height}`;
  ctx.font = `${12 * Math.min(window.devicePixelRatio || 1, 2)}px "Microsoft YaHei"`;
  const labelW = ctx.measureText(label).width + 14;
  const labelY = Math.max(y, ry - 24 * Math.min(window.devicePixelRatio || 1, 2));
  ctx.fillRect(rx, labelY, labelW, 21 * Math.min(window.devicePixelRatio || 1, 2));
  ctx.fillStyle = "white"; ctx.fillText(label, rx + 7, labelY + 15 * Math.min(window.devicePixelRatio || 1, 2));
  ctx.restore();
}

function canvasPoint(event) {
  const rect = ui.canvas.getBoundingClientRect();
  const sx = ui.canvas.width / rect.width, sy = ui.canvas.height / rect.height;
  return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy };
}
function imagePoint(point) {
  return { x: (point.x - state.render.x) / state.render.scale, y: (point.y - state.render.y) / state.render.scale };
}
function cropHit(point) {
  const p = imagePoint(point), c = state.crop;
  const threshold = 12 / state.render.scale;
  const corners = { nw:[c.x,c.y], ne:[c.x+c.w,c.y], sw:[c.x,c.y+c.h], se:[c.x+c.w,c.y+c.h] };
  for (const [name, [x,y]] of Object.entries(corners)) if (Math.hypot(p.x-x,p.y-y) <= threshold) return name;
  if (p.x >= c.x && p.x <= c.x+c.w && p.y >= c.y && p.y <= c.y+c.h) return "move";
  return "new";
}
ui.canvas.addEventListener("pointerdown", (event) => {
  if (!state.files.length) return;
  const p = imagePoint(canvasPoint(event));
  state.drag = { mode: cropHit(canvasPoint(event)), start: p, original: { ...state.crop } };
  ui.canvas.setPointerCapture(event.pointerId);
});
ui.canvas.addEventListener("pointermove", (event) => {
  if (!state.drag) return;
  const p = imagePoint(canvasPoint(event));
  const dx = p.x - state.drag.start.x, dy = p.y - state.drag.start.y;
  const original = state.drag.original;
  let { x, y, w, h } = original;
  if (state.drag.mode === "move") {
    x = clamp(original.x + dx, 0, state.sourceWidth - original.w);
    y = clamp(original.y + dy, 0, state.sourceHeight - original.h);
  } else if (state.drag.mode === "new") {
    x = clamp(Math.min(state.drag.start.x, p.x), 0, state.sourceWidth - 1);
    y = clamp(Math.min(state.drag.start.y, p.y), 0, state.sourceHeight - 1);
    w = clamp(Math.abs(p.x - state.drag.start.x), 1, state.sourceWidth - x);
    h = clamp(Math.abs(p.y - state.drag.start.y), 1, state.sourceHeight - y);
  } else {
    if (state.drag.mode.includes("w")) { x = clamp(original.x + dx, 0, original.x + original.w - 1); w = original.w + original.x - x; }
    if (state.drag.mode.includes("e")) w = clamp(original.w + dx, 1, state.sourceWidth - original.x);
    if (state.drag.mode.includes("n")) { y = clamp(original.y + dy, 0, original.y + original.h - 1); h = original.h + original.y - y; }
    if (state.drag.mode.includes("s")) h = clamp(original.h + dy, 1, state.sourceHeight - original.y);
  }
  state.crop = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  updateCropInputs(); invalidateCaches(); drawPreview();
});
ui.canvas.addEventListener("pointerup", () => { state.drag = null; });
ui.canvas.addEventListener("pointercancel", () => { state.drag = null; });

function updateCropInputs() {
  ui.cropX.value = state.crop.x; ui.cropY.value = state.crop.y;
  ui.cropW.value = state.crop.w; ui.cropH.value = state.crop.h;
}
ui.applyCrop.addEventListener("click", () => {
  const x = clamp(Number(ui.cropX.value) || 0, 0, state.sourceWidth - 1);
  const y = clamp(Number(ui.cropY.value) || 0, 0, state.sourceHeight - 1);
  state.crop = { x, y, w: clamp(Number(ui.cropW.value) || 1, 1, state.sourceWidth - x), h: clamp(Number(ui.cropH.value) || 1, 1, state.sourceHeight - y) };
  updateCropInputs();
  applyCropToOutput("裁剪尺寸已应用");
});
ui.resetCrop.addEventListener("click", () => {
  state.crop = { x: 0, y: 0, w: state.sourceWidth, h: state.sourceHeight };
  updateCropInputs();
  applyCropToOutput("已恢复整张图片尺寸");
});

function applyCropToOutput(message) {
  ui.outputW.value = state.crop.w;
  ui.outputH.value = state.crop.h;
  updateResolutionSummary();
  updateOutputFrameRange();
  invalidateCaches();
  drawPreview();
  setStatus(`${message}：${state.crop.w} × ${state.crop.h}`, 0);

  [ui.outputW, ui.outputH].forEach((input) => {
    input.classList.remove("is-updated");
    void input.offsetWidth;
    input.classList.add("is-updated");
    window.setTimeout(() => input.classList.remove("is-updated"), 900);
  });

  const originalText = ui.applyCrop.textContent;
  if (message.startsWith("裁剪")) {
    ui.applyCrop.textContent = "已应用";
    window.setTimeout(() => { ui.applyCrop.textContent = originalText; }, 900);
  }
}

const settingControls = [ui.fps, ui.loop, ui.colors, ui.transparency, ui.strength, ui.resolutionScale];
settingControls.forEach((control) => control.addEventListener("change", () => { invalidateCaches(); drawPreview(); }));
ui.resolutionScale.addEventListener("change", updateResolutionSummary);
ui.strength.addEventListener("input", () => { $("strength-display").textContent = `${ui.strength.value}%`; });
ui.compression.addEventListener("change", () => { state.compressedCache = null; updateResultText(); });
window.addEventListener("resize", drawPreview);

function settings() {
  validateRange();
  const { width, height } = getScaledDimensions();
  return {
    start: Number(ui.start.value), end: Number(ui.end.value),
    crop: [state.crop.x, state.crop.y, state.crop.x + state.crop.w, state.crop.y + state.crop.h],
    width, height, resolutionScale: Number(ui.resolutionScale.value), fps: clamp(Number(ui.fps.value) || 30, .1, 120),
    loop: Number(ui.loop.value), colors: Number(ui.colors.value),
    transparencyMode: ui.transparency.value, ditherStrength: Number(ui.strength.value),
  };
}

function getScaledDimensions() {
  const boundaryWidth = clamp(Number(ui.outputW.value) || state.crop.w || 1, 1, 16384);
  const boundaryHeight = clamp(Number(ui.outputH.value) || state.crop.h || 1, 1, 16384);
  const scale = clamp(Number(ui.resolutionScale.value) || 100, 25, 200) / 100;
  return {
    width: clamp(Math.round(boundaryWidth * scale), 1, 16384),
    height: clamp(Math.round(boundaryHeight * scale), 1, 16384),
  };
}

function updateResolutionSummary() {
  if (!state.files.length) {
    $("resolution-result").textContent = "0 × 0 px";
    return;
  }
  const { width, height } = getScaledDimensions();
  $("resolution-result").textContent = `${width} × ${height} px`;
}
function cacheKey() {
  const fileKey = state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
  return `${fileKey}::${JSON.stringify(settings())}`;
}
function invalidateCaches() { state.rawCache = null; state.compressedCache = null; updateResultText(); }
function updateResultText() {
  if (state.compressedCache) {
    const saving = state.rawCache ? (1 - state.compressedCache.blob.size / state.rawCache.blob.size) * 100 : 0;
    ui.result.textContent = `合成 ${formatBytes(state.rawCache.blob.size)} · 压缩 ${formatBytes(state.compressedCache.blob.size)} · 减少 ${Math.max(0,saving).toFixed(1)}%`;
  } else if (state.rawCache) ui.result.textContent = `合成结果 ${formatBytes(state.rawCache.blob.size)} · 可继续压缩预览`;
  else if (state.files.length) ui.result.textContent = `${state.files.length} 帧 · 参数改变后需要重新计算`;
}
function setBusy(busy) {
  state.busy = busy;
  [ui.rawPreview, ui.compressedPreview, ui.exportGif, ui.extractButton].forEach((button) => {
    button.disabled = busy || (button === ui.extractButton ? !state.gifFiles.length : !state.files.length);
  });
}
async function ensureRaw() {
  const key = cacheKey();
  if (state.rawCache?.key === key) return state.rawCache.blob;
  const current = settings();
  const workingPixels = current.width * current.height * (current.end - current.start + 1);
  if (workingPixels > 300_000_000) throw new Error("当前帧数与分辨率需要过多内存，请缩小尺寸或分段导出");
  setBusy(true); setProgress(6, "准备序列帧");
  try {
    const frameFiles = state.files.map((file) => ({ name: file.name, file }));
    const buffers = await Promise.all(frameFiles.map(async ({ name, file }) => ({ name, buffer: await file.arrayBuffer() })));
    const transfers = buffers.map((item) => item.buffer);
    const response = await workerCall("encode", { files: buffers, settings: current }, transfers);
    const blob = new Blob([response.buffer], { type: "image/gif" });
    state.rawCache = { key, blob };
    state.compressedCache = null;
    updateResultText();
    setProgress(100, `合成完成：${formatBytes(blob.size)}`);
    return blob;
  } finally { setBusy(false); }
}
async function ensureCompressed() {
  const raw = await ensureRaw();
  const loss = Number(ui.compression.value);
  const key = `${state.rawCache.key}::loss=${loss}`;
  if (state.compressedCache?.key === key) return state.compressedCache.blob;
  setBusy(true); setProgress(25, loss ? `正在压缩（有损 ${loss}）` : "正在优化");
  try {
    const command = loss ? `-O3 --lossy=${loss} input.gif -o /out/output.gif` : "-O3 input.gif -o /out/output.gif";
    const outputs = await gifsicle.run({ input: [{ file: raw, name: "input.gif" }], command: [command] });
    if (!outputs?.length) throw new Error("压缩失败，未生成输出文件");
    const blob = outputs[0] instanceof Blob ? outputs[0] : new Blob([outputs[0]], { type: "image/gif" });
    state.compressedCache = { key, blob };
    updateResultText();
    setProgress(100, `压缩完成：${formatBytes(blob.size)}`);
    return blob;
  } finally { setBusy(false); }
}

ui.rawPreview.addEventListener("click", () => runAction(async () => { await ensureRaw(); }));
ui.compressedPreview.addEventListener("click", () => runAction(async () => { await ensureCompressed(); }));
ui.exportGif.addEventListener("click", () => runAction(async () => {
  const blob = await ensureCompressed();
  downloadBlob(blob, `sequence_${new Date().toISOString().replace(/[:.]/g,"-")}.gif`);
  setStatus(`GIF 已生成并下载：${formatBytes(blob.size)}`, 100);
}));
async function runAction(action) {
  try { await action(); }
  catch (error) { setStatus(`处理失败：${error.message}`, 0); console.error(error); }
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function clearSequence() {
  stopPlayback(); releaseBitmaps(); state.files = []; state.current = 0; state.sourceWidth = 0; state.sourceHeight = 0;
  invalidateCaches(); setSequenceControls(false); ui.fileCount.textContent = "0 帧";
  ui.fileList.innerHTML = '<div class="empty-list">尚未添加图片</div>';
  ui.canvasEmpty.classList.remove("is-hidden"); ui.frameIndicator.textContent = "0 / 0";
  ui.result.textContent = "等待添加序列图片"; drawPreview();
  updateOutputFrameRange();
  ui.outputW.value = 0;
  ui.outputH.value = 0;
  updateResolutionSummary();
}
ui.clearFiles.addEventListener("click", clearSequence);

/* ---------------- GIF → 序列图（支持批量） ---------------- */

function isGifFile(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

/* 帧文件命名：非法字符替换为下划线；去掉开头/结尾的点、下划线、空格（Windows 不允许以点或空格结尾），
   否则会和后面的分隔符叠成 set__0001 这种双下划线。为空则回落到 frame。 */
function sanitizePrefix(value) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[_.\s]+$/, "");
  return cleaned || "frame";
}

function defaultPrefix(file) {
  return sanitizePrefix(file.name.replace(/\.gif$/i, ""));
}

/* 「逐个自定义」模式下每个 GIF 一行独立前缀输入。只在文件增删或规则切换时重建，
   避免导出过程中重渲染打断正在输入的内容。 */
function renderNamingList() {
  const custom = ui.extractNaming.value === "custom";
  ui.extractNamingList.hidden = !custom;
  if (!custom) return;
  if (!state.gifFiles.length) {
    ui.extractNamingList.innerHTML = '<div class="empty-list">添加 GIF 后可逐个自定义名称</div>';
    return;
  }
  ui.extractNamingList.replaceChildren(...state.gifFiles.map((item) => {
    const row = document.createElement("div");
    row.className = "naming-row";
    const source = document.createElement("span");
    source.className = "naming-source";
    source.textContent = item.file.name;
    source.title = item.file.name;
    const input = document.createElement("input");
    input.className = "naming-input";
    input.type = "text";
    input.value = item.prefix;
    input.setAttribute("aria-label", `${item.file.name} 的输出前缀`);
    input.addEventListener("input", () => { item.prefix = input.value; });
    row.append(source, input);
    return row;
  }));
}

function resolvePrefix(item) {
  const rule = ui.extractNaming.value;
  if (rule === "custom") return sanitizePrefix(item.prefix);
  if (rule === "source") return defaultPrefix(item.file);
  return "frame";
}

ui.extractNaming.addEventListener("change", renderNamingList);
renderNamingList();

function renderGifList() {
  ui.gifCount.textContent = `${state.gifFiles.length} 个`;
  ui.gifClear.disabled = !state.gifFiles.length;
  ui.gifList.replaceChildren(...state.gifFiles.map((item, index) => {
    const row = document.createElement("div");
    row.className = "frame-row batch-row-item";
    let meta;
    if (item.error) meta = `<span class="batch-row-error">失败</span>`;
    else {
      const size = item.width && item.height ? `${item.width} × ${item.height} · ` : "";
      const frames = item.frames ? ` · ${item.frames} 帧` : "";
      meta = `<span class="batch-row-meta">${size}${formatBytes(item.file.size)}${frames}</span>`;
    }
    row.innerHTML = `<span class="frame-index">${index + 1}</span><span class="frame-name"></span>${meta}`;
    row.querySelector(".frame-name").textContent = item.file.name;
    row.title = item.error || item.file.name;
    return row;
  }));
  if (!state.gifFiles.length) ui.gifList.innerHTML = '<div class="empty-list">尚未添加 GIF</div>';
  ui.extractResult.textContent = state.gifFiles.length
    ? `已选择 ${state.gifFiles.length} 个 GIF，点击下方按钮解码并打包`
    : "等待添加 GIF";
  setBusy(state.busy);
}

async function probeGif(item) {
  try {
    const header = new Uint8Array(await item.file.slice(0, 10).arrayBuffer());
    const valid = header.length >= 10 && String.fromCharCode(...header.slice(0, 3)) === "GIF";
    if (!valid) { item.error = "文件内容不是有效的 GIF"; return; }
    item.width = header[6] | (header[7] << 8);
    item.height = header[8] | (header[9] << 8);
  } catch (_) { /* 读文件头失败不阻断后续解码 */ }
}

function addGifs(files) {
  if (!files.length) return;
  const candidates = files.filter(isGifFile);
  const accepted = [];
  candidates.forEach((file) => {
    const duplicate = state.gifFiles.some((item) => item.file.name === file.name && item.file.size === file.size);
    if (!duplicate) accepted.push({ file, prefix: defaultPrefix(file), width: 0, height: 0, frames: 0, error: "" });
  });
  if (!accepted.length) {
    setStatus(candidates.length ? "这些 GIF 已在列表中" : "请选择 GIF 文件", 0);
    return;
  }
  state.gifFiles.push(...accepted);
  renderGifList();
  renderNamingList();
  setStatus(`已添加 ${accepted.length} 个 GIF`, 0);
  Promise.all(accepted.map(probeGif)).then(renderGifList);
}

function clearGifs() {
  state.gifFiles = [];
  renderGifList();
  renderNamingList();
  setStatus("已清空 GIF 列表", 0);
}

ui.gifClear.addEventListener("click", clearGifs);

ui.extractButton.addEventListener("click", () => runAction(async () => {
  if (!state.gifFiles.length) return;
  const settings = {
    format: ui.extractFormat.value,
    quality: Number(ui.extractQuality.value),
    white: ui.extractWhite.checked,
  };
  const multiple = state.gifFiles.length > 1;
  const zip = new JSZip();
  const usedFolders = new Set();
  let totalFrames = 0;

  setBusy(true);
  try {
    for (let index = 0; index < state.gifFiles.length; index += 1) {
      const item = state.gifFiles[index];
      setProgress(4 + (index / state.gifFiles.length) * 74, `正在解码 ${item.file.name}`);
      const buffer = await item.file.arrayBuffer();
      const response = await workerCall("extract", {
        buffer,
        settings: { ...settings, prefix: resolvePrefix(item) },
      }, [buffer]);
      let target = zip;
      if (multiple) {
        const base = item.file.name.replace(/\.gif$/i, "") || `gif_${index + 1}`;
        let name = base;
        let suffix = 2;
        while (usedFolders.has(name)) name = `${base}_${suffix++}`;
        usedFolders.add(name);
        target = zip.folder(name);
      }
      response.files.forEach((file) => target.file(file.name, file.buffer));
      if (ui.extractTiming.checked) target.file("timing.json", response.timing);
      item.error = "";
      item.frames = response.files.length;
      totalFrames += response.files.length;
      renderGifList();
    }

    setProgress(82, "正在打包 ZIP");
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
      (meta) => setProgress(82 + meta.percent * .17, "正在打包 ZIP"),
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = multiple
      ? `gif_frames_${stamp}.zip`
      : `${state.gifFiles[0].file.name.replace(/\.gif$/i, "")}_frames.zip`;
    downloadBlob(blob, filename);
    ui.extractResult.textContent = `${state.gifFiles.length} 个 GIF · ${totalFrames} 帧 · ZIP ${formatBytes(blob.size)}`;
    setProgress(100, `序列图已打包：${totalFrames} 帧`);
  } finally { setBusy(false); }
}));

initializeRuntime();
drawPreview();
initBatchModule();
initSpriteModule();
initAlphaModule();
