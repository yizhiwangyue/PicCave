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

/* 合成与切分是两个方向，素材各自独立存放，切换子标签不会丢失已添加的内容。
   切分方向支持多张精灵图，每张各自持有一套参数（网格 + 输出），与左侧序号一一对应。
   upDefaults 同时承担两个角色：未添加素材时右侧那组「默认参数」的存储，
   以及新增精灵图时的初始值（已有素材时则从上一张继承，免得每加一张都要重填网格）。 */
const state = {
  mode: "pack",
  packFiles: [], // { file, width, height }
  sheets: [],    // { file, width, height, settings }
  upDefaults: { cols: "8", rows: "8", width: "", height: "", format: "png", prefix: "", quality: 92 },
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

/* 空字符串表示「未指定」，返回 value = 0；非法输入返回 error。
   逐张参数是存在内存里的原始字符串，所以入口收字符串而非 input 元素。 */
function readNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { value: 0 };
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) return { error: "数值必须是正整数" };
  return { value };
}

function readCount(input) {
  return readNumber(input.value);
}

function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (char) => map[char]);
}

/* ZIP 内的子目录重名时追加 _2、_3…，避免多张同名精灵图互相覆盖 */
function uniqueName(base, used) {
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(name);
  return name;
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
    upList: $("sprite-up-list"),
    result: $("sprite-result"),
    run: $("sprite-run"),
    runLabel: $("sprite-run-label"),
  };
}

/* ---------------- 素材 ---------------- */

const activeItems = () => (state.mode === "pack" ? state.packFiles : state.sheets);

function renderList() {
  const pack = state.mode === "pack";
  const items = activeItems();
  ui.count.textContent = `${items.length} 张`;
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

/* 前缀默认取精灵图自身的文件名（去扩展名 + 净化）。
   多张精灵图各切一套序列帧，默认同名会互相覆盖，所以按源文件区分。
   结尾的下划线必须一起去掉，否则拼上分隔符会得到 `set__0001`。 */
function sheetPrefix(file) {
  const base = file.name.replace(/\.[^.]+$/, "");
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s_]+$/, "");
  return cleaned || "frame";
}

/* 新增的精灵图从上一张继承参数（同一批素材网格通常一致，避免逐张重填网格），
   列表为空时则用右侧默认参数组作为起点。前缀永远按自身文件名生成，不受继承影响。 */
function makeSheetSettings(file) {
  const source = state.sheets.length ? state.sheets[state.sheets.length - 1].settings : state.upDefaults;
  return { ...source, prefix: sheetPrefix(file) };
}

const FORMAT_OPTIONS = [
  ["png", "PNG（保留透明）"],
  ["jpg", "JPG"],
  ["webp", "WebP"],
  ["bmp", "BMP"],
  ["tiff", "TIFF"],
];

async function addSheets(incoming) {
  const accepted = incoming.filter(isImage);
  if (!accepted.length) {
    setStatus("没有找到可用的图片", 0);
    return;
  }
  const seen = new Set(state.sheets.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  const added = [];
  accepted.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    const item = { file, width: 0, height: 0, settings: makeSheetSettings(file) };
    state.sheets.push(item);
    added.push(item);
  });
  if (!added.length) {
    setStatus("这些图片已在列表中", 0);
    return;
  }
  state.sheets.sort(naturalCompare);
  renderList();
  renderSheetSettings();
  refreshControls();
  setStatus(`已添加 ${added.length} 张精灵图`, 0);
  // 尺寸探测完成后只刷新左侧列表（右栏参数行不含尺寸，重建会打断正在输入的内容）
  Promise.all(added.map(async (item) => Object.assign(item, await probeImage(item.file)))).then(() => renderList());
}

/* ---------------- 每张精灵图的输出参数 ---------------- */

function formatOptionsHtml(selected) {
  return FORMAT_OPTIONS
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
    .join("");
}

/* 一张图一组：网格（列/行）与输出（帧宽/帧高/格式/前缀/质量）同在一张卡片里。
   默认组用虚线边框区分 —— 它还不是一张真实的图，只是新增素材时的套用值。 */
function buildSettingRow({ index, name, title, settings, draft = false }) {
  const row = document.createElement("div");
  row.className = "sheet-setting-row";
  if (draft) row.dataset.draft = "1";
  else row.dataset.index = String(index);

  const meta = document.createElement("div");
  meta.className = "sheet-setting-meta";
  const badge = document.createElement("span");
  badge.className = "frame-index";
  badge.textContent = String(index + 1);
  const label = document.createElement("span");
  label.className = "sheet-setting-name";
  label.textContent = name;
  label.title = title;
  meta.append(badge, label);

  const fields = document.createElement("div");
  fields.className = "batch-grid sheet-setting-fields";
  // 前缀名默认由各图文件名生成，默认组不产出文件，该字段保留占位但隐藏
  fields.innerHTML = `
    <label class="batch-field"><span>列数</span><input data-field="cols" type="number" min="1" max="128" value="${escapeHtml(settings.cols)}" /></label>
    <label class="batch-field"><span>行数</span><input data-field="rows" type="number" min="1" max="128" value="${escapeHtml(settings.rows)}" /></label>
    <label class="batch-field"><span>帧宽</span><input data-field="width" type="number" min="1" max="16384" placeholder="保持原尺寸" value="${escapeHtml(settings.width)}" /></label>
    <label class="batch-field"><span>帧高</span><input data-field="height" type="number" min="1" max="16384" placeholder="保持原尺寸" value="${escapeHtml(settings.height)}" /></label>
    <label class="batch-field"><span>图片格式</span><select data-field="format">${formatOptionsHtml(settings.format)}</select></label>
    <label class="batch-field" ${draft ? "hidden" : ""}><span>前缀名</span><input data-field="prefix" type="text" value="${escapeHtml(settings.prefix)}" /></label>
    <label class="batch-field" data-lossy ${LOSSY_FORMATS.has(settings.format) ? "" : "hidden"}><span>有损质量</span><input data-field="quality" type="number" min="1" max="100" value="${escapeHtml(settings.quality)}" /></label>
  `;
  row.append(meta, fields);
  return row;
}

function renderSheetSettings() {
  const rows = state.sheets.length
    ? state.sheets.map((item, index) => {
      const size = item.width && item.height ? `${item.width} × ${item.height} · ` : "";
      return buildSettingRow({
        index,
        name: item.file.name,
        title: `${item.file.name} · ${size}${formatBytes(item.file.size)}`,
        settings: item.settings,
      });
    })
    // 尚未添加素材时也保留一组可编辑的默认参数，界面不留空
    : [buildSettingRow({
      index: 0,
      name: "默认参数 · 添加精灵图后自动套用",
      title: "尚未添加精灵图：这里的设置会作为新增素材的初始值",
      settings: state.upDefaults,
      draft: true,
    })];
  ui.upList.replaceChildren(...rows);
}

/* 参数行是动态生成的，统一用事件委托写回 state，避免逐行绑定与重建后失效 */
function onSheetField(event) {
  const field = event.target.dataset?.field;
  if (!field) return;
  const row = event.target.closest(".sheet-setting-row");
  if (!row) return;
  const settings = row.dataset.draft === "1"
    ? state.upDefaults
    : state.sheets[Number(row.dataset.index)]?.settings;
  if (!settings) return;
  const value = event.target.value;
  if (field === "format") {
    settings.format = value;
    const lossy = row.querySelector("[data-lossy]");
    if (lossy) lossy.hidden = !LOSSY_FORMATS.has(value);
  } else {
    settings[field] = value;
  }
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
  const ready = pack ? state.packFiles.length > 0 : state.sheets.length > 0;
  ui.run.disabled = state.busy || !ready;
  ui.qualityRow.hidden = !LOSSY_FORMATS.has(ui.format.value);
}

function updateChrome() {
  const pack = state.mode === "pack";
  ui.panelTitle.textContent = pack ? "待合成序列帧" : "待切分精灵图";
  ui.dropTitle.textContent = pack ? "添加序列图片" : "添加精灵图";
  ui.dropHint.textContent = pack ? "点击选择，或直接拖放到这里" : "点击选择一张或多张精灵图，或直接拖放";
  ui.runLabel.textContent = pack ? "合成精灵图" : "切分序列帧";
  setSourceMenu(false);
  ui.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.spriteTab === state.mode));
  ui.panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.spritePanel === state.mode));
  ui.result.textContent = pack ? "等待添加序列帧" : "等待添加精灵图";
  renderList();
  renderSheetSettings();
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

/* 逐张收集参数并校验。网格已按图独立，列/行也在这里一并校验；
   报错必须指明是第几张，否则多图时用户找不到问题行。 */
function collectUnpackJobs() {
  const jobs = [];
  for (const [index, item] of state.sheets.entries()) {
    const label = `第 ${index + 1} 张`;
    const cols = readNumber(item.settings.cols);
    const rows = readNumber(item.settings.rows);
    if (!cols.value) {
      setStatus(`${label}：${cols.error || "请填写列数"}`, 0);
      return { error: true };
    }
    if (!rows.value) {
      setStatus(`${label}：${rows.error || "请填写行数"}`, 0);
      return { error: true };
    }
    const outW = readNumber(item.settings.width);
    const outH = readNumber(item.settings.height);
    const invalid = outW.error || outH.error;
    if (invalid) {
      setStatus(`${label}：${invalid}`, 0);
      return { error: true };
    }
    if (Boolean(outW.value) !== Boolean(outH.value)) {
      setStatus(`${label}：帧宽和帧高需同时填写，或同时留空`, 0);
      return { error: true };
    }
    const quality = Math.floor(Number(item.settings.quality));
    jobs.push({
      item,
      settings: {
        cols: cols.value,
        rows: rows.value,
        width: outW.value,
        height: outH.value,
        format: item.settings.format,
        prefix: item.settings.prefix,
        quality: Number.isFinite(quality) && quality > 0 ? Math.min(100, quality) : 92,
      },
    });
  }
  return { jobs };
}

async function runUnpack() {
  if (!state.sheets.length) return;
  const collected = collectUnpackJobs();
  if (collected.error) return;
  const { jobs } = collected;

  setBusy(true);
  setStatus("正在切分序列帧", 6);
  try {
    // 单张时帧直接放 ZIP 根目录（保持原有行为）；多张时各自一个子目录，避免重名互相覆盖
    const multi = jobs.length > 1;
    const outputs = [];
    let totalFrames = 0;
    for (const [index, job] of jobs.entries()) {
      const buffer = await job.item.file.arrayBuffer();
      const response = await workerCall("unpack", { buffer, settings: job.settings }, [buffer]);
      totalFrames += response.frame_count;
      outputs.push({
        base: job.item.file.name.replace(/\.[^.]+$/, "") || "sprite",
        frames: response.frame_count,
        cols: response.cols,
        rows: response.rows,
        // 指定了输出尺寸时实际帧尺寸是它，而非切分得到的原始块尺寸
        frameW: job.settings.width || response.frameW,
        frameH: job.settings.height || response.frameH,
        files: response.files,
      });
      setStatus(`正在切分序列帧（${index + 1}/${jobs.length}）`, 6 + ((index + 1) / jobs.length) * 54);
    }

    setStatus("正在打包 ZIP", 66);
    const zip = new JSZip();
    const used = new Set();
    outputs.forEach((output) => {
      const folder = multi ? uniqueName(output.base, used) : output.base;
      output.files.forEach((file) => {
        zip.file(multi ? `${folder}/${file.name}` : file.name, file.buffer);
      });
    });
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
      (meta) => setStatus("正在打包 ZIP", 66 + meta.percent * 0.32),
    );

    const first = outputs[0];
    downloadBlob(blob, multi ? `sprite_frames_${timestamp()}.zip` : `${first.base}_frames.zip`);
    ui.result.textContent = multi
      ? `切分完成：${outputs.length} 张精灵图 · 共 ${totalFrames} 帧 · ZIP ${formatBytes(blob.size)}`
      : `切分完成：${first.cols} 列 × ${first.rows} 行 → ${first.frames} 帧 · 单帧 ${first.frameW}×${first.frameH} · ZIP ${formatBytes(blob.size)}`;
    setStatus(`序列帧已导出：${totalFrames} 张`, 100);
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
    else addSheets(files);
  });
  ui.input.addEventListener("change", () => { addPackFiles([...ui.input.files]); ui.input.value = ""; });
  ui.sheetInput.addEventListener("change", () => { addSheets([...ui.sheetInput.files]); ui.sheetInput.value = ""; });
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
    else state.sheets = [];
    renderList();
    renderSheetSettings();
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

  ui.format.addEventListener("change", refreshControls);

  // 逐张参数行的读写走事件委托：行是动态重建的，逐行绑定会在重建后失效
  ui.upList.addEventListener("input", onSheetField);
  ui.upList.addEventListener("change", onSheetField);

  const bindRange = (input, output) => input.addEventListener("input", () => { output.textContent = input.value; });
  bindRange(ui.quality, ui.qualityValue);

  ui.run.addEventListener("click", () => {
    if (state.busy) return;
    if (state.mode === "pack") runPack();
    else runUnpack();
  });

  syncLayoutInputs();
  updateChrome();
}
