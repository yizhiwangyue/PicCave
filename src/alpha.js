import JSZip from "jszip";

const $ = (id) => document.getElementById(id);

const IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|tiff?|gif|tga|ico|psd|dds)$/i;
const LOSSY_FORMATS = new Set(["jpg"]);
const MIME = { png: "image/png", jpg: "image/jpeg" };

/* 转换与预览共用一块离屏画布。
   willReadFrequently 必须开：逐图 getImageData 属于高频读回，
   不开的话浏览器会把画布搬到 GPU 上，每次读回都要同步拷贝一遍，批量时明显变慢。 */
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const state = {
  items: [], // { file, width, height, error, srcBitmap, result, resultBitmap }
  current: 0,
  previewMode: "result",
  busy: false,
};

let ui = null;
let previewToken = 0;
/* 键名与 <select id="alpha-naming"> 的取值保持一致（suffix / index），
   别写成 suffix / prefix —— 两边对不上时会静默取到 undefined，
   表现是输入框里字面显示 "undefined"、且前缀改动完全传不到导出。 */
let namingMode = "suffix";
const namingDraft = { suffix: "_alpha", index: "Alpha" };

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

/* 让出一帧再继续。转换本身是同步的，不主动让出的话进度条与「正在转换（3/40）」
   这类文字要等整批跑完才刷得出来，看着像卡死。 */
const nextFrame = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/* 非法字符替换为下划线；去掉首尾的点与空格（Windows 不允许以点或空格结尾），
   末尾的下划线也一起去掉，否则会和后面的分隔符叠成 set__0001。 */
function sanitizeName(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[_.\s]+$/, "");
  return cleaned || fallback;
}

/* ZIP 内重名时追加 _2、_3…，避免不同目录下的同名图互相覆盖 */
function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let counter = 2;
  let candidate = `${stem}_${counter}${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}_${counter}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function collectUi() {
  return {
    workspace: $("alpha-workspace"),
    count: $("alpha-count"),
    clear: $("alpha-clear"),
    drop: $("alpha-drop"),
    input: $("alpha-input"),
    folderInput: $("alpha-folder-input"),
    sourceMenu: $("alpha-source-menu"),
    chooseFiles: $("alpha-choose-files"),
    chooseFolder: $("alpha-choose-folder"),
    list: $("alpha-list"),

    preview: $("alpha-preview"),
    previewCanvas: $("alpha-preview-canvas"),
    previewEmpty: $("alpha-preview-empty"),
    previewTitle: $("alpha-preview-title"),
    previewHint: $("alpha-preview-hint"),
    modes: [...document.querySelectorAll(".alpha-mode")],

    keepSize: $("alpha-keep-size"),
    width: $("alpha-width"),
    height: $("alpha-height"),
    sizePreset: $("alpha-size-preset"),
    direction: $("alpha-direction"),
    format: $("alpha-format"),
    quality: $("alpha-quality"),
    qualityValue: $("alpha-quality-value"),
    qualityRow: $("alpha-quality-row"),

    naming: $("alpha-naming"),
    nameLabel: $("alpha-name-label"),
    nameValue: $("alpha-name-value"),
    result: $("alpha-result"),
    run: $("alpha-run"),
    export: $("alpha-export"),
  };
}

/* ---------------- 素材 ---------------- */

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

function describeItem(item) {
  const size = item.width && item.height ? `${item.width} × ${item.height} · ` : "";
  return `${item.file.name} · ${size}${formatBytes(item.file.size)}`;
}

function renderList() {
  ui.count.textContent = `${state.items.length} 张`;
  ui.clear.disabled = !state.items.length;
  if (!state.items.length) {
    ui.list.innerHTML = '<div class="empty-list">尚未添加图片</div>';
    return;
  }
  // 行样式对齐其它模块的素材列表：只有序号 + 完整文件名，尺寸与体积进 title。
  // 点行即切换预览对象，所以用 button 而不是 div。
  ui.list.replaceChildren(...state.items.map((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `frame-row${index === state.current ? " is-active" : ""}`;
    row.innerHTML = `<span class="frame-index">${index + 1}</span><span class="frame-name"></span>`;
    row.querySelector(".frame-name").textContent = item.file.name;
    row.title = item.error ? `${describeItem(item)} · 失败：${item.error}` : describeItem(item);
    row.addEventListener("click", () => selectItem(index));
    return row;
  }));
}

async function addFiles(incoming) {
  const accepted = incoming.filter(isImage);
  if (!accepted.length) {
    setStatus("没有找到可用的图片", 0);
    return;
  }
  const seen = new Set(state.items.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  const added = [];
  accepted.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    const item = { file, width: 0, height: 0, error: "", srcBitmap: null, result: null, resultBitmap: null };
    state.items.push(item);
    added.push(item);
  });
  if (!added.length) {
    setStatus("这些图片已在列表中", 0);
    return;
  }
  state.items.sort(naturalCompare);
  renderList();
  refreshControls();
  setStatus(`已添加 ${added.length} 张图片`, 0);
  // 尺寸探测完成后只需要刷新左侧列表（行内不含尺寸，靠 title 承载），
  // 但 title 也要更新，所以还是重建一次；此时用户不会在列表里输入任何东西。
  Promise.all(added.map(async (item) => Object.assign(item, await probeImage(item.file)))).then(() => {
    renderList();
    updateResultText();
  });
}

function selectItem(index) {
  if (!state.items.length) return;
  state.current = (index + state.items.length) % state.items.length;
  ui.list.querySelectorAll(".frame-row").forEach((row, i) => row.classList.toggle("is-active", i === state.current));
  drawPreview();
}

function clearFiles() {
  state.items.forEach(releaseBitmaps);
  state.items = [];
  state.current = 0;
  renderList();
  refreshControls();
  drawPreview();
  setStatus("已清空列表", 0);
}

/* ---------------- 位图缓存 ---------------- */

/* 同一张图既用于「原图」预览又用于取尺寸与转换，重复 createImageBitmap 会反复解码。
   像素在 close() 之前一直有效，清列表或替换结果时必须显式释放。 */
async function bitmapFor(item, kind) {
  const key = kind === "result" ? "resultBitmap" : "srcBitmap";
  if (item[key]) return item[key];
  const source = kind === "result" ? item.result?.blob : item.file;
  if (!source) return null;
  try {
    const bitmap = await createImageBitmap(source);
    item[key] = bitmap;
    return bitmap;
  } catch (_) {
    // 解码失败不缓存：换格式或重跑后应当重试
    return null;
  }
}

function closeBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
}

function releaseBitmaps(item) {
  closeBitmap(item.srcBitmap);
  closeBitmap(item.resultBitmap);
  item.srcBitmap = null;
  item.resultBitmap = null;
}

function releaseResultBitmap(item) {
  closeBitmap(item.resultBitmap);
  item.resultBitmap = null;
}

/* ---------------- 核心转换 ---------------- */

/* 把 Alpha 通道写成灰度：先取 alpha，再让 R=G=B=alpha，最后把 A 置为 255。
   输出因此是完全不透明的黑白图 —— 透明处黑、不透明处白、半透明处灰。
   必须先读 data[i+3] 再写 RGB：这个循环里 alpha 一旦被写坏就再也还原不回来了。 */
function toMask(imageData, invert) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const value = invert ? 255 - alpha : alpha;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return imageData;
}

function canvasToBlob(format, quality) {
  const mime = MIME[format] || MIME.png;
  const q = Math.max(1, Math.min(100, Number(quality) || 92)) / 100;
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("导出图片失败"))),
      mime,
      LOSSY_FORMATS.has(format) ? q : undefined,
    );
  });
}

function settings() {
  return {
    keepSize: ui.keepSize.checked,
    width: Math.floor(Number(ui.width.value)) || 0,
    height: Math.floor(Number(ui.height.value)) || 0,
    direction: ui.direction.value,
    format: ui.format.value,
    quality: Math.floor(Number(ui.quality.value)) || 92,
  };
}

/* 参数签名。逐张结果都带着自己的签名，导出时就不会混进「上一轮参数」的旧结果。 */
const currentSignature = () => JSON.stringify(settings());

async function convertItem(item, config, signature) {
  const bitmap = await bitmapFor(item, "src");
  if (!bitmap) throw new Error("图片无法解码");
  const width = config.keepSize ? bitmap.width : config.width;
  const height = config.keepSize ? bitmap.height : config.height;
  if (!width || !height) throw new Error("输出尺寸无效");

  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // 先按目标尺寸画、再取像素：缩小产生的半透明边缘要由浏览器重采样出来，
  // 反过来先取像素再缩会把边缘重新混成硬边，蒙版缩小一圈就丢了一圈羽化。
  ctx.drawImage(bitmap, 0, 0, width, height);
  ctx.putImageData(toMask(ctx.getImageData(0, 0, width, height), config.direction === "invert"), 0, 0);

  const blob = await canvasToBlob(config.format, config.quality);
  // 结果换了，缓存的「结果位图」必须一起丢掉，否则预览还停在旧图上
  releaseResultBitmap(item);
  item.result = { blob, width, height, format: config.format, signature };
  return item.result;
}

/* ---------------- 转换与导出 ---------------- */

function syncSizeInputs() {
  const keep = ui.keepSize.checked;
  [ui.width, ui.height, ui.sizePreset].forEach((control) => { control.disabled = keep; });
}

/* 转换参数一变，旧结果就作废 —— 否则导出会得到一半旧参数、一半新参数的混合结果。
   命名规则不属于转换参数，改它不会清空结果。
   清完必须同时刷按钮与文案：只清 result 不刷控制的话，导出按钮会留在「可用」状态，
   点下去只会打包出一个空 ZIP。 */
function invalidateResults() {
  const signature = currentSignature();
  const stale = state.items.filter((item) => item.result && item.result.signature !== signature);
  if (!stale.length) return;
  stale.forEach((item) => {
    releaseResultBitmap(item);
    item.result = null;
  });
  renderList();
  drawPreview();
  refreshControls();
  updateResultText();
  setStatus("参数已改动，请重新转换", 0);
}

function updateResultText() {
  if (!state.items.length) {
    ui.result.textContent = "等待添加图片";
    return;
  }
  const done = state.items.filter((item) => item.result);
  if (!done.length) {
    ui.result.textContent = `已选择 ${state.items.length} 张，点击「开始转换」提取 Alpha 图`;
    return;
  }
  const total = done.reduce((sum, item) => sum + item.result.blob.size, 0);
  const parts = [done.length === state.items.length
    ? `${done.length} 张蒙版`
    : `${done.length}/${state.items.length} 张已转换`];
  parts.push(`合计 ${formatBytes(total)}`);
  const failed = state.items.filter((item) => item.error).length;
  if (failed) parts.push(`失败 ${failed} 张`);
  ui.result.textContent = parts.join(" · ");
}

function refreshControls() {
  const ready = state.items.length > 0;
  ui.run.disabled = state.busy || !ready;
  ui.export.disabled = state.busy || !state.items.some((item) => item.result);
  ui.qualityRow.hidden = !LOSSY_FORMATS.has(ui.format.value);
}

function setBusy(busy) {
  state.busy = busy;
  refreshControls();
}

async function run() {
  if (state.busy || !state.items.length) return;
  const config = settings();
  if (!config.keepSize) {
    if (!config.width || !config.height) {
      setStatus("请填写目标宽和高，或勾选保持原尺寸", 0);
      return;
    }
    if (config.width > 16384 || config.height > 16384) {
      setStatus("目标尺寸过大，单边不要超过 16384", 0);
      return;
    }
  }
  const signature = currentSignature();

  setBusy(true);
  setStatus("正在转换", 4);
  try {
    for (const [index, item] of state.items.entries()) {
      if (item.result?.signature !== signature) {
        try {
          await convertItem(item, config, signature);
          item.error = "";
        } catch (error) {
          releaseResultBitmap(item);
          item.result = null;
          item.error = error.message;
          // 失败要立刻可见，成功则等整批结束后由总量文案统一交代
          renderList();
        }
      }
      setStatus(`正在转换（${index + 1}/${state.items.length}）`, 4 + ((index + 1) / state.items.length) * 88);
      await nextFrame();
    }
    setStatus(`转换完成：${state.items.filter((item) => item.result).length} 张`, 100);
    drawPreview();
  } catch (error) {
    setStatus(`转换失败：${error.message}`, 0);
    console.error("Alpha 转换失败：", error);
  } finally {
    setBusy(false);
    updateResultText();
  }
}

function readNaming() {
  if (namingMode === "index") return { mode: "index", prefix: sanitizeName(namingDraft.index, "Alpha") };
  return { mode: "suffix", suffix: sanitizeName(namingDraft.suffix, "") };
}

function outputName(original, extension, index, naming) {
  const base = original.replace(/\.[^./\\]+$/, "") || original;
  const stem = naming.mode === "index" ? `${naming.prefix}_${String(index + 1).padStart(3, "0")}` : `${base}${naming.suffix}`;
  return `${stem}.${extension}`;
}

async function exportZip() {
  if (state.busy) return;
  const naming = readNaming();
  setBusy(true);
  setStatus("正在打包 ZIP", 88);
  try {
    const zip = new JSZip();
    const used = new Set();
    let count = 0;
    // 用素材序号（而非「成功项序号」）命名，与左侧列表的编号一一对应，
    // 中间有失败项时编号会留空档，反而一眼能看出是第几张出的问题。
    for (const [index, item] of state.items.entries()) {
      if (!item.result) continue;
      // 扩展名取结果自身的格式，不取当前下拉框 —— 参数改过之后导出才不会名实不符
      const name = uniqueName(outputName(item.file.name, item.result.format, index, naming), used);
      zip.file(name, await item.result.blob.arrayBuffer());
      count += 1;
    }
    if (!count) {
      setStatus("还没有可导出的结果", 0);
      return;
    }
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
      (meta) => setStatus("正在打包 ZIP", 88 + meta.percent * 0.11),
    );
    downloadBlob(blob, `alpha_masks_${timestamp()}.zip`);
    ui.result.textContent = `已导出 ${count} 张蒙版 · ZIP ${formatBytes(blob.size)}`;
    setStatus(`已导出 ${count} 张`, 100);
  } catch (error) {
    setStatus(`打包失败：${error.message}`, 0);
    console.error("Alpha 蒙版打包失败：", error);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 预览 ---------------- */

function previewContext() {
  const rect = ui.preview.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (ui.previewCanvas.width !== width || ui.previewCanvas.height !== height) {
    ui.previewCanvas.width = width;
    ui.previewCanvas.height = height;
  }
  const context = ui.previewCanvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function showPreviewEmpty(title, hint) {
  ui.previewTitle.textContent = title;
  ui.previewHint.textContent = hint;
  ui.previewEmpty.hidden = false;
  previewContext(); // 顺手清空画布，免得旧图残留在提示语底下
}

/* 预览按「等比缩放后居中」绘制，不铺满 —— 蒙版一旦被拉变形，预览就失去参考意义。
   异步解码期间用户可能已经切了图或切了模式，用自增 token 丢弃过期结果，
   否则先发起、后返回的旧图会盖掉新图。 */
async function drawPreview() {
  if (!ui) return;
  const token = ++previewToken;
  const item = state.items[state.current];
  const mode = state.previewMode;
  ui.preview.classList.toggle("is-source", mode === "source");

  if (!item) {
    showPreviewEmpty("还没有可预览的图片", "从左侧添加图片后在此查看效果");
    return;
  }
  const bitmap = await bitmapFor(item, mode === "result" ? "result" : "src");
  if (token !== previewToken) return;
  if (!bitmap) {
    if (mode === "result") showPreviewEmpty("还没有转换结果", "点击「开始转换」后在此查看 Alpha 图");
    else showPreviewEmpty("无法显示这张图片", "该格式可能不受支持");
    return;
  }

  ui.previewEmpty.hidden = true;
  const { context, width, height } = previewContext();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const padding = 12 * dpr;
  const scale = Math.min((width - padding * 2) / bitmap.width, (height - padding * 2) / bitmap.height);
  const drawW = Math.max(1, bitmap.width * scale);
  const drawH = Math.max(1, bitmap.height * scale);
  const x = (width - drawW) / 2;
  const y = (height - drawH) / 2;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, x, y, drawW, drawH);
  // 蒙版是不透明的黑白图，白色区域在浅底板上会糊成一片。
  // 沿绘制范围描一圈极细的线，图的边界才一眼可辨 —— 否则容易被当成「预览是空的」。
  context.strokeStyle = "rgba(43, 33, 27, .3)";
  context.lineWidth = dpr;
  context.strokeRect(x, y, drawW, drawH);
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

function setSourceMenu(open) {
  ui.sourceMenu.hidden = !open;
  ui.drop.setAttribute("aria-expanded", String(open));
}

function syncNaming() {
  const indexed = namingMode === "index";
  ui.nameLabel.textContent = indexed ? "前缀" : "后缀";
  ui.nameValue.value = namingDraft[namingMode];
}

export function initAlphaModule() {
  ui = collectUi();
  if (!ui.workspace) return;

  bindDropZone(ui.drop, addFiles);
  ui.input.addEventListener("change", () => { addFiles([...ui.input.files]); ui.input.value = ""; });
  ui.folderInput.addEventListener("change", () => { addFiles([...ui.folderInput.files]); ui.folderInput.value = ""; });
  [ui.input, ui.folderInput].forEach((input) => input.addEventListener("click", (event) => event.stopPropagation()));

  ui.drop.addEventListener("click", (event) => {
    if (event.target.closest(".source-menu")) return;
    setSourceMenu(ui.sourceMenu.hidden);
  });
  ui.drop.addEventListener("keydown", (event) => {
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

  ui.clear.addEventListener("click", clearFiles);

  ui.modes.forEach((button) => button.addEventListener("click", () => {
    state.previewMode = button.dataset.alphaMode;
    ui.modes.forEach((item) => item.classList.toggle("is-active", item === button));
    drawPreview();
  }));

  ui.keepSize.addEventListener("change", () => {
    syncSizeInputs();
    invalidateResults();
  });
  // 手动改动尺寸后「快速选择」不再代表当前值；松手（change）才作废已有结果
  [ui.width, ui.height].forEach((input) => {
    input.addEventListener("input", () => { ui.sizePreset.value = ""; });
    input.addEventListener("change", invalidateResults);
  });
  ui.sizePreset.addEventListener("change", () => {
    const value = ui.sizePreset.value;
    if (value) {
      ui.width.value = value;
      ui.height.value = value;
    }
    invalidateResults();
  });

  [ui.direction, ui.format].forEach((control) => control.addEventListener("change", () => {
    refreshControls();
    invalidateResults();
  }));
  // 滑块拖动中只更新数字，松手（change）才作废已有结果，避免一路拖一路清空
  ui.quality.addEventListener("input", () => { ui.qualityValue.textContent = ui.quality.value; });
  ui.quality.addEventListener("change", invalidateResults);

  ui.naming.addEventListener("change", () => {
    namingDraft[namingMode] = ui.nameValue.value;
    namingMode = ui.naming.value;
    syncNaming();
  });
  ui.nameValue.addEventListener("input", () => { namingDraft[namingMode] = ui.nameValue.value; });

  ui.run.addEventListener("click", run);
  ui.export.addEventListener("click", exportZip);

  /* 工作区是 display:none 时量不到尺寸，切回本模块必须重画。
     ResizeObserver 一并兜住「窗口缩放」与「从别的模块切回来」两种情况 —— 
     只监听 window.resize 的话，切回来看到的会是一块空白预览。
       不会死循环：画布是 width/height:100% 跟随容器的，容器高度又写死 216px，
       所以改画布的 width/height 属性不会反过来改变容器尺寸。 */
  new ResizeObserver(() => {
    if (!ui.preview.clientWidth) return;
    drawPreview();
  }).observe(ui.preview);

  syncSizeInputs();
  syncNaming();
  renderList();
  refreshControls();
  drawPreview();
}
