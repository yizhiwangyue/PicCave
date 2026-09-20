import JSZip from "jszip";
import { workerCall } from "./runtime.js";

const $ = (id) => document.getElementById(id);

const IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|tiff?|gif|tga|ico)$/i;
const LOSSY_FORMATS = new Set(["jpg", "webp"]);
const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

/* 合成与切分是两个方向，素材各自独立存放，切换子标签不会丢失已添加的内容 */
const state = {
  mode: "pack",
  packFiles: [],   // { file, width, height }
  sheetFile: null, // { file, width, height }
  busy: false,
};

let ui = null;

/* ---------------- 通用小工具 ---------------- */

function setStatus(label, value) {
  const text = $("status-text");
  if (text) text.textContent = label;
  const bar = $("progress");
  if (bar && typeof value === "number" && Number.isFinite(value)) bar.value = Math.max(0, Math.min(100, value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const naturalCompare = (a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" });

function isImage(file) {
  return (file.type && file.type.startsWith("image/")) || IMAGE_PATTERN.test(file.name);
}

/* 读素材尺寸用于列表展示。TIFF 等浏览器无法解码的格式会失败，
   这里静默降级为不显示尺寸，不影响后续交给 worker 处理。 */
async function probeImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch (_) {
    return { width: 0, height: 0 };
  }
}

/* 空字符串表示「未指定」，返回 value = 0；非法输入返回 error。 */
function readCount(input) {
  const raw = input.value.trim();
  if (!raw) return { value: 0 };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return { error: "数值必须是正整数" };
  return { value };
}

function collectUi() {
  return {
    workspace: $("sprite-workspace"),
    panelTitle: $("sprite-panel-title"),
    count: $("sprite-count"),
    clear: $("sprite-clear"),
    drop: $("sprite-drop"),
    dropTitle: $("sprite-drop-title"),
    dropHint: $("sprite-drop-hint"),
    input: $("sprite-input"),
    sheetInput: $("sprite-sheet-input"),
    folderInput: $("sprite-folder-input"),
    sourceMenu: $("sprite-source-menu"),
    chooseFiles: $("sprite-choose-files"),
    chooseFolder: $("sprite-choose-folder"),
    list: $("sprite-list"),
    tabs: [...document.querySelectorAll(".sprite-tab")],
    panels: [...document.querySelectorAll(".sprite-panel")],
    autoLayout: $("sprite-auto-layout"),
    cols: $("sprite-cols"),
    rows: $("sprite-rows"),
    canvasW: $("sprite-canvas-w"),
    canvasH: $("sprite-canvas-h"),
    canvasPreset: $("sprite-canvas-preset"),
    format: $("sprite-format"),
    quality: $("sprite-quality"),
    qualityValue: $("sprite-quality-value"),
    qualityRow: $("sprite-quality-row"),
    upCols: $("sprite-up-cols"),
    upRows: $("sprite-up-rows"),
    upW: $("sprite-up-w"),
    upH: $("sprite-up-h"),
    upFormat: $("sprite-up-format"),
    upPrefix: $("sprite-up-prefix"),
    upQuality: $("sprite-up-quality"),
    upQualityValue: $("sprite-up-quality-value"),
    upQualityRow: $("sprite-up-quality-row"),
    result: $("sprite-result"),
    run: $("sprite-run"),
    runLabel: $("sprite-run-label"),
  };
}

/* ---------------- 素材 ---------------- */

const activeItems = () => (state.mode === "pack" ? state.packFiles : (state.sheetFile ? [state.sheetFile] : []));

function renderList() {
  const pack = state.mode === "pack";
  const items = activeItems();
  ui.count.textContent = pack ? `${items.length} 张` : (items.length ? "1 张" : "0 张");
  ui.clear.disabled = !items.length;
  if (!items.length) {
    ui.list.innerHTML = `<div class="empty-list">${pack ? "尚未添加序列帧" : "尚未添加精灵图"}</div>`;
    return;
  }
  // 行样式对齐「序列图与 GIF 转换」的列表：只有序号 + 完整文件名。
  // 尺寸与体积移入 title —— 之前放在行内会把文件名挤成「hu...」。
  ui.list.replaceChildren(...items.map((item, index) => {
    const row = document.createElement("div");
    row.className = "frame-row";
    row.innerHTML = `<span class="frame-index">${index + 1}</span><span class="frame-name"></span>`;
    row.querySelector(".frame-name").textContent = item.file.name;
    const size = item.width && item.height ? `${item.width} × ${item.height} · ` : "";
    row.title = `${item.file.name} · ${size}${formatBytes(item.file.size)}`;
    return row;
  }));
}

async function addPackFiles(incoming) {
  const accepted = incoming.filter(isImage);
  if (!accepted.length) {
    setStatus("没有找到可用的图片", 0);
    return;
  }
  const seen = new Set(state.packFiles.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  const added = [];
  accepted.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    const item = { file, width: 0, height: 0 };
    state.packFiles.push(item);
    added.push(item);
  });
  if (!added.length) {
    setStatus("这些图片已在列表中", 0);
    return;
  }
  state.packFiles.sort(naturalCompare);
  renderList();
  refreshControls();
  setStatus(`已添加 ${added.length} 张图片`, 0);
  Promise.all(added.map(async (item) => Object.assign(item, await probeImage(item.file)))).then(() => {
    renderList();
    refreshControls();
  });
}

async function setSheetFile(incoming) {
  const file = incoming.find(isImage);
  if (!file) {
    setStatus("请选择一张图片", 0);
    return;
  }
  const item = { file, width: 0, height: 0 };
  state.sheetFile = item;
  renderList();
  refreshControls();
  setStatus(`已选择 ${file.name}`, 0);
  Object.assign(item, await probeImage(file));
  renderList();
  refreshControls();
}

/* ---------------- 界面状态 ---------------- */

function syncLayoutInputs() {
  const auto = ui.autoLayout.checked;
  ui.cols.disabled = auto;
  ui.rows.disabled = auto;
}

function refreshControls() {
  const pack = state.mode === "pack";
  const ready = pack ? state.packFiles.length > 0 : Boolean(state.sheetFile);
  ui.run.disabled = state.busy || !ready;
  ui.qualityRow.hidden = !LOSSY_FORMATS.has(ui.format.value);
  ui.upQualityRow.hidden = !LOSSY_FORMATS.has(ui.upFormat.value);
}

function updateChrome() {
  const pack = state.mode === "pack";
  ui.panelTitle.textContent = pack ? "待合成序列帧" : "待切分精灵图";
  ui.dropTitle.textContent = pack ? "添加序列图片" : "添加精灵图";
  ui.dropHint.textContent = pack ? "点击选择，或直接拖放到这里" : "点击选择一张精灵图，或直接拖放";
  ui.runLabel.textContent = pack ? "合成精灵图" : "切分序列帧";
  setSourceMenu(false);
  ui.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.spriteTab === state.mode));
  ui.panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.spritePanel === state.mode));
  ui.result.textContent = pack ? "等待添加序列帧" : "等待添加精灵图";
  renderList();
  refreshControls();
}

function setBusy(busy) {
  state.busy = busy;
  refreshControls();
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  updateChrome();
  setStatus(mode === "pack" ? "合成精灵图" : "切分序列帧", 0);
}

function setSourceMenu(open) {
  const visible = open && state.mode === "pack";
  ui.sourceMenu.hidden = !visible;
  ui.drop.setAttribute("aria-expanded", String(visible));
}

/* ---------------- 合成精灵图 ---------------- */

async function runPack() {
  if (!state.packFiles.length) return;
  const auto = ui.autoLayout.checked;
  const cols = auto ? { value: 0 } : readCount(ui.cols);
  const rows = auto ? { value: 0 } : readCount(ui.rows);
  const canvasW = readCount(ui.canvasW);
  const canvasH = readCount(ui.canvasH);
  const invalid = [cols, rows, canvasW, canvasH].find((item) => item.error);
  if (invalid) {
    setStatus(invalid.error, 0);
    return;
  }
  if (Boolean(canvasW.value) !== Boolean(canvasH.value)) {
    setStatus("画布宽和高需同时填写，或同时留空", 0);
    return;
  }

  const settings = {
    cols: cols.value,
    rows: rows.value,
    canvasW: canvasW.value,
    canvasH: canvasH.value,
    format: ui.format.value,
    quality: Number(ui.quality.value) || 92,
  };

  setBusy(true);
  setStatus("正在合成精灵图", 6);
  try {
    const payload = [];
    for (const item of state.packFiles) {
      payload.push({ name: item.file.name, buffer: await item.file.arrayBuffer() });
    }
    const response = await workerCall("pack", { files: payload, settings }, payload.map((item) => item.buffer));
    const blob = new Blob([response.buffer], { type: MIME[response.extension] || "application/octet-stream" });
    downloadBlob(blob, `sprite_${timestamp()}.${response.extension}`);
    ui.result.textContent = `${state.packFiles.length} 帧 → ${response.cols} 列 × ${response.rows} 行 · 画布 ${response.width}×${response.height} · 单格 ${response.cellW}×${response.cellH} · ${formatBytes(blob.size)}`;
    setStatus(`精灵图已导出：${response.width}×${response.height}`, 100);
  } catch (error) {
    ui.result.textContent = `合成失败：${error.message}`;
    setStatus("合成失败，请检查素材后重试", 0);
    console.error("精灵图合成失败：", error);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 切分序列帧 ---------------- */

async function runUnpack() {
  if (!state.sheetFile) return;
  const cols = readCount(ui.upCols);
  const rows = readCount(ui.upRows);
  if (!cols.value) {
    setStatus(cols.error || "请填写列数", 0);
    return;
  }
  if (!rows.value) {
    setStatus(rows.error || "请填写行数", 0);
    return;
  }
  const outW = readCount(ui.upW);
  const outH = readCount(ui.upH);
  const invalid = [outW, outH].find((item) => item.error);
  if (invalid) {
    setStatus(invalid.error, 0);
    return;
  }
  if (Boolean(outW.value) !== Boolean(outH.value)) {
    setStatus("帧宽和帧高需同时填写，或同时留空", 0);
    return;
  }

  const settings = {
    cols: cols.value,
    rows: rows.value,
    width: outW.value,
    height: outH.value,
    format: ui.upFormat.value,
    prefix: ui.upPrefix.value,
    quality: Number(ui.upQuality.value) || 92,
  };

  setBusy(true);
  setStatus("正在切分序列帧", 8);
  try {
    const buffer = await state.sheetFile.file.arrayBuffer();
    const response = await workerCall("unpack", { buffer, settings }, [buffer]);
    setStatus("正在打包 ZIP", 70);
    const zip = new JSZip();
    response.files.forEach((file) => zip.file(file.name, file.buffer));
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
      (meta) => setStatus("正在打包 ZIP", 70 + meta.percent * 0.28),
    );
    const base = state.sheetFile.file.name.replace(/\.[^.]+$/, "") || "sprite";
    downloadBlob(blob, `${base}_frames.zip`);
    ui.result.textContent = `切分完成：${response.cols} 列 × ${response.rows} 行 → ${response.frame_count} 帧 · 单帧 ${response.frameW}×${response.frameH} · ZIP ${formatBytes(blob.size)}`;
    setStatus(`序列帧已导出：${response.frame_count} 张`, 100);
  } catch (error) {
    ui.result.textContent = `切分失败：${error.message}`;
    setStatus("切分失败，请检查参数后重试", 0);
    console.error("序列帧切分失败：", error);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 初始化 ---------------- */

function bindDropZone(zone, callback) {
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragging");
  }));
  zone.addEventListener("drop", (event) => callback([...event.dataTransfer.files]));
}

export function initSpriteModule() {
  ui = collectUi();
  if (!ui.workspace) return;

  bindDropZone(ui.drop, (files) => {
    if (state.mode === "pack") addPackFiles(files);
    else setSheetFile(files);
  });
  ui.input.addEventListener("change", () => { addPackFiles([...ui.input.files]); ui.input.value = ""; });
  ui.sheetInput.addEventListener("change", () => { setSheetFile([...ui.sheetInput.files]); ui.sheetInput.value = ""; });
  ui.folderInput.addEventListener("change", () => { addPackFiles([...ui.folderInput.files]); ui.folderInput.value = ""; });
  [ui.input, ui.sheetInput, ui.folderInput].forEach((input) => input.addEventListener("click", (event) => event.stopPropagation()));

  ui.drop.addEventListener("click", (event) => {
    if (event.target.closest(".source-menu")) return;
    if (state.mode === "unpack") {
      ui.sheetInput.click();
      return;
    }
    setSourceMenu(ui.sourceMenu.hidden);
  });
  ui.drop.addEventListener("keydown", (event) => {
    if (state.mode !== "pack") return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSourceMenu(ui.sourceMenu.hidden);
    }
    if (event.key === "Escape") setSourceMenu(false);
  });
  ui.chooseFiles.addEventListener("click", (event) => {
    event.stopPropagation();
    setSourceMenu(false);
    ui.input.click();
  });
  ui.chooseFolder.addEventListener("click", (event) => {
    event.stopPropagation();
    setSourceMenu(false);
    ui.folderInput.click();
  });
  document.addEventListener("click", (event) => {
    if (!ui.drop.contains(event.target)) setSourceMenu(false);
  });

  ui.tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.spriteTab)));

  ui.clear.addEventListener("click", () => {
    if (state.mode === "pack") state.packFiles = [];
    else state.sheetFile = null;
    renderList();
    refreshControls();
    setStatus("已清空列表", 0);
  });

  ui.autoLayout.addEventListener("change", () => {
    syncLayoutInputs();
    refreshControls();
  });

  ui.canvasPreset.addEventListener("change", () => {
    const value = ui.canvasPreset.value;
    if (value === "auto") {
      ui.canvasW.value = "";
      ui.canvasH.value = "";
    } else if (value) {
      ui.canvasW.value = value;
      ui.canvasH.value = value;
    }
  });
  // 手动改动画布尺寸后，快捷选择不再代表当前值
  [ui.canvasW, ui.canvasH].forEach((input) => input.addEventListener("input", () => { ui.canvasPreset.value = ""; }));

  [ui.format, ui.upFormat].forEach((select) => select.addEventListener("change", refreshControls));

  const bindRange = (input, output) => input.addEventListener("input", () => { output.textContent = input.value; });
  bindRange(ui.quality, ui.qualityValue);
  bindRange(ui.upQuality, ui.upQualityValue);

  ui.run.addEventListener("click", () => {
    if (state.busy) return;
    if (state.mode === "pack") runPack();
    else runUnpack();
  });

  syncLayoutInputs();
  updateChrome();
}
