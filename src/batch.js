import JSZip from "jszip";
import { createIcons, icons } from "lucide";
import { workerCall } from "./runtime.js";
import { loadQuantizer, quantizePng } from "./quantizer.js";

const $ = (id) => document.getElementById(id);

const IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|tiff?|tga|gif|ico|psd|dds)$/i;
const LOSSY_FORMATS = new Set(["jpg", "webp"]);

const state = {
  files: [],
  results: [],
  nodes: [],
  mode: "convert",
  busy: false,
  engineReady: false,
  loaded: false,
};

let ui = null;
let nodeSeq = 0;

function paintIcons() {
  try {
    createIcons({ icons });
  } catch (_) {
    /* 图标名缺失不应阻断功能 */
  }
}

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

const num = (element, fallback) => {
  const value = Number(element?.value);
  return Number.isFinite(value) ? value : fallback;
};

function collectUi() {
  return {
    workspace: $("batch-workspace"),
    count: $("batch-count"),
    clear: $("batch-clear"),
    drop: $("batch-drop"),
    input: $("batch-input"),
    folderInput: $("batch-folder-input"),
    sourceMenu: $("batch-source-menu"),
    chooseFiles: $("batch-choose-files"),
    chooseFolder: $("batch-choose-folder"),
    list: $("batch-list"),
    tabs: [...document.querySelectorAll(".batch-tab")],
    panels: [...document.querySelectorAll(".batch-panel")],
    keepRes: $("batch-keep-res"),
    width: $("batch-width"),
    height: $("batch-height"),
    format: $("batch-format"),
    convertQuality: $("batch-convert-quality"),
    convertQualityValue: $("batch-convert-quality-value"),
    convertQualityRow: $("batch-convert-quality-row"),
    pngQuality: $("batch-png-quality"),
    jpgQuality: $("batch-jpg-quality"),
    jpgQualityValue: $("batch-jpg-quality-value"),
    skipLarger: $("batch-skip-larger"),
    addConvert: $("batch-add-convert"),
    addCompress: $("batch-add-compress"),
    clearNodes: $("batch-clear-nodes"),
    nodes: $("batch-nodes"),
    naming: $("batch-naming"),
    prefix: $("batch-prefix"),
    result: $("batch-result"),
    run: $("batch-run"),
    export: $("batch-export"),
  };
}

/* ---------------- 素材 ---------------- */

function isImage(file) {
  return (file.type && file.type.startsWith("image/")) || IMAGE_PATTERN.test(file.name);
}

function addFiles(incoming) {
  const accepted = incoming.filter(isImage);
  if (!accepted.length) {
    setStatus("没有找到可用的图片", 0);
    return;
  }
  const seen = new Set(state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  accepted.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    state.files.push(file);
  });
  state.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  resetResults();
  renderFiles();
  refreshControls();
  setStatus(`已载入 ${state.files.length} 张图片`, 0);
}

function renderFiles() {
  if (!ui) return;
  ui.count.textContent = `${state.files.length} 张`;
  if (!state.files.length) {
    ui.list.innerHTML = '<div class="empty-list">尚未添加图片</div>';
    return;
  }
  ui.list.replaceChildren(...state.files.map((file, index) => {
    const row = document.createElement("div");
    row.className = "frame-row batch-row-item";
    const result = state.results[index];
    const meta = result
      ? result.error
        ? `<span class="batch-row-error">失败</span>`
        : `<span class="batch-row-meta">${formatBytes(result.outputSize)}${result.keptOriginal ? " · 保留原图" : ""}</span>`
      : `<span class="batch-row-meta">${formatBytes(file.size)}</span>`;
    row.innerHTML = `<span class="frame-index">${index + 1}</span><span class="frame-name"></span>${meta}`;
    row.querySelector(".frame-name").textContent = file.name;
    row.title = result && result.error ? result.error : file.name;
    return row;
  }));
}

function resetResults() {
  state.results = [];
}

/* ---------------- 模式 ---------------- */

function setMode(mode) {
  state.mode = mode;
  ui.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.batchTab === mode));
  ui.panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.batchPanel === mode));
  refreshControls();
}

/* ---------------- 节点 ---------------- */

function newNode(type) {
  nodeSeq += 1;
  if (type === "convert") {
    return { key: nodeSeq, type: "convert", params: { keepResolution: false, width: 2048, height: 2048, format: "png", quality: 92 } };
  }
  // 与「极致压缩」面板保持一致：只有 PNG 质量（区间）与 JPG 质量可调，
  // 其余（色彩上限 / 速度 / 抖动 / 色调分离）走 COMPRESS_FIXED 的固定值。
  // ⚠️ 这里的初值要与 index.html 上的 `value` 和 PNG_QUALITY_FALLBACK 三处对齐。
  return { key: nodeSeq, type: "compress", params: { ...COMPRESS_FIXED, qualityMin: 80, qualityTarget: 95, quality: 75 } };
}

function nodeOptionList(selected, values) {
  return values.map((value) => `<option value="${value}"${String(selected) === String(value) ? " selected" : ""}>${value}</option>`).join("");
}

function renderNodes() {
  if (!ui) return;
  if (!state.nodes.length) {
    ui.nodes.innerHTML = '<div class="empty-list">尚未添加节点，处理时按原格式输出</div>';
    return;
  }
  ui.nodes.replaceChildren(...state.nodes.map((node, index) => {
    const card = document.createElement("div");
    card.className = "batch-node";
    const label = node.type === "convert" ? "格式转换" : "极致压缩";
    const body = node.type === "convert"
      ? `<label class="check-label"><input type="checkbox" data-param="keepResolution"${node.params.keepResolution ? " checked" : ""} /><span>保持原分辨率</span></label>
         <div class="batch-row">
           <label class="batch-field"><span>宽</span><input type="number" data-param="width" value="${node.params.width}" min="1" max="16384" /></label>
           <label class="batch-field"><span>高</span><input type="number" data-param="height" value="${node.params.height}" min="1" max="16384" /></label>
           <label class="batch-field"><span>格式</span><select data-param="format">${nodeOptionList(node.params.format, ["png", "jpg", "webp", "bmp", "tiff", "tga", "ico"])}</select></label>
           <label class="batch-field"><span>有损质量</span><input class="setting-range" type="range" data-param="quality" value="${node.params.quality}" min="1" max="100" /></label>
         </div>`
      : `<div class="compress-grid">
           <label class="batch-field"><span>PNG 质量</span>
             <div class="compress-png-row">
               <input type="text" data-role="png-quality" value="${node.params.qualityMin}-${node.params.qualityTarget}" inputmode="numeric" spellcheck="false" autocomplete="off" />
               <em class="compress-hint">（追求极致画质，可设置为 80-95；追求极致体积，可设置为 50-70）</em>
             </div>
           </label>
           <label class="batch-field"><span>JPG 质量 <b data-role="jpg-badge">${node.params.quality}</b></span><input class="setting-range" type="range" data-param="quality" value="${node.params.quality}" min="1" max="100" /></label>
         </div>`;
    card.innerHTML = `<div class="batch-node-head">
        <span class="batch-node-badge">${index + 1}</span>
        <strong>${label}</strong>
        <div class="batch-node-tools">
          <button type="button" data-act="up" title="上移"${index === 0 ? " disabled" : ""}><i data-lucide="arrow-up"></i></button>
          <button type="button" data-act="down" title="下移"${index === state.nodes.length - 1 ? " disabled" : ""}><i data-lucide="arrow-down"></i></button>
          <button type="button" data-act="remove" title="删除"><i data-lucide="x"></i></button>
        </div>
      </div>
      <div class="batch-node-body">${body}</div>`;

    card.querySelectorAll("[data-param]").forEach((control) => {
      const key = control.dataset.param;
      const apply = () => {
        if (control.type === "checkbox") node.params[key] = key === "dithering" ? (control.checked ? 1 : 0) : control.checked;
        else if (control.tagName === "SELECT") node.params[key] = /^\d+$/.test(control.value) ? Number(control.value) : control.value;
        else if (control.type === "range" || control.type === "number") node.params[key] = num(control, node.params[key]);
        if (key === "quality") {
          const badge = control.closest(".batch-field")?.querySelector("[data-role='jpg-badge']");
          if (badge) badge.textContent = String(node.params.quality);
        }
      };
      control.addEventListener("input", apply);
      control.addEventListener("change", apply);
    });

    // 节点里的 PNG 质量与主面板同一套规则：一个输入框写「下限-上限」，
    // 直接落到 qualityMin / qualityTarget；写「80」＝只设上限（下限 0），失焦时归一回区间写法。
    const pngField = card.querySelector('[data-role="png-quality"]');
    if (pngField) {
      const commit = () => {
        const { min, max } = parsePngQuality(pngField.value);
        node.params.qualityMin = min;
        node.params.qualityTarget = max;
        pngField.value = `${min}-${max}`;
      };
      pngField.addEventListener("change", commit);
      pngField.addEventListener("blur", commit);
    }

    card.querySelectorAll("[data-act]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.act;
        if (action === "remove") state.nodes.splice(index, 1);
        if (action === "up" && index > 0) [state.nodes[index - 1], state.nodes[index]] = [state.nodes[index], state.nodes[index - 1]];
        if (action === "down" && index < state.nodes.length - 1) [state.nodes[index + 1], state.nodes[index]] = [state.nodes[index], state.nodes[index + 1]];
        renderNodes();
      });
    });
    return card;
  }));
  paintIcons();
}

/* ---------------- 参数组装 ---------------- */

function readConvertParams() {
  return {
    keepResolution: ui.keepRes.checked,
    width: num(ui.width, 2048),
    height: num(ui.height, 2048),
    format: ui.format.value,
    quality: num(ui.convertQuality, 92),
  };
}

/* ------------------------ 极致压缩参数 ------------------------ */

/**
 * 面板上的「PNG 质量」是一个 0–100 的**区间**，写成 `下限-上限`；
 * 只写一个数时视为上限，下限按 0（＝不设底线，尽最大可能压）。
 * 面板不再暴露色彩上限 / 速度 / 抖动 / 色调分离。
 *
 * ⚠️ 这四个固定值 = 旧版面板的默认值，改这里就等于悄悄改变压缩结果，务必同步改默认值注释。
 *
 * ⚠️⚠️ **改「PNG 质量」的默认值要动两处，只改一处会出现「清空后跳回旧值」的怪现象**：
 *   1. `index.html` 的 `<input id="batch-png-quality" value="…">` —— 首屏显示值
 *   2. 下面这个 PNG_QUALITY_FALLBACK —— 输入框被清空 / 输入乱码时跳回的值，失焦归一同用
 *   节点的初值在 `newNode("compress")` 里，也要一并对齐。
 *   （更低层的 quantizer / worker / 中间件里的 0 与 100 是「不设限」语义，不是 UI 默认值，别跟着改。）
 */
const PNG_QUALITY_FALLBACK = { min: 80, max: 95 };
const COMPRESS_FIXED = { maxColors: 256, speed: 4, dithering: 1, posterization: 0 };

const toQualityNumber = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
};

function parsePngQuality(raw) {
  const numbers = String(raw ?? "").match(/\d+/g) || [];
  if (!numbers.length) return { ...PNG_QUALITY_FALLBACK };
  const first = toQualityNumber(numbers[0], PNG_QUALITY_FALLBACK.max);
  if (numbers.length === 1) return { min: 0, max: first };
  const second = toQualityNumber(numbers[1], first);
  return { min: Math.min(first, second), max: Math.max(first, second) };
}

function readCompressParams() {
  const { min, max } = parsePngQuality(ui.pngQuality.value);
  return {
    ...COMPRESS_FIXED,
    qualityMin: min,
    qualityTarget: max,
    quality: num(ui.jpgQuality, 75),
  };
}

function buildNodes() {
  if (state.mode === "workflow") {
    return state.nodes.map((node) => ({ type: node.type, params: { ...node.params } }));
  }
  if (state.mode === "convert") return [{ type: "convert", params: readConvertParams() }];
  return [{ type: "compress", params: readCompressParams() }];
}

function normalizeExt(name) {
  const raw = (name.split(".").pop() || "").toLowerCase();
  if (raw === "jpeg") return "jpg";
  if (raw === "tif") return "tiff";
  return raw;
}

function buildName(original, extension, index, naming) {
  const base = original.replace(/\.[^./\\]+$/, "") || original;
  const stem = naming.mode === 1 ? `${naming.prefix}_${String(index + 1).padStart(3, "0")}` : base;
  return `${stem}.${extension}`;
}

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

/* ---------------- 执行 ---------------- */

function setBusy(busy) {
  state.busy = busy;
  ui.run.disabled = busy || !state.files.length;
  ui.export.disabled = busy || !state.results.some((result) => !result.error);
  ui.clear.disabled = busy || !state.files.length;
}

function refreshControls() {
  setBusy(state.busy);
  ui.convertQualityRow.hidden = !LOSSY_FORMATS.has(ui.format.value);
  if (!state.files.length) ui.result.textContent = "等待添加图片";
  else if (!state.results.length) ui.result.textContent = `${state.files.length} 张待处理`;
}

function summarize() {
  const done = state.results.filter((result) => !result.error);
  const failed = state.results.length - done.length;
  if (!done.length) {
    ui.result.textContent = failed ? `全部 ${failed} 张处理失败` : "等待添加图片";
    return;
  }
  const sourceTotal = done.reduce((sum, result) => sum + result.sourceSize, 0);
  const outputTotal = done.reduce((sum, result) => sum + result.outputSize, 0);
  const saving = sourceTotal ? (1 - outputTotal / sourceTotal) * 100 : 0;
  const quantizedCount = done.filter((result) => result.quantized).length;
  const keptCount = done.filter((result) => result.keptOriginal).length;
  const parts = [`成功 ${done.length}${failed ? ` / 失败 ${failed}` : ""}`];
  parts.push(`${formatBytes(sourceTotal)} → ${formatBytes(outputTotal)}`);
  parts.push(`${saving >= 0 ? "减少" : "增加"} ${Math.abs(saving).toFixed(1)}%`);
  if (quantizedCount) parts.push(`已压缩 ${quantizedCount} 张`);
  if (keptCount) parts.push(`保留原图 ${keptCount} 张`);
  ui.result.textContent = parts.join(" · ");
}

async function run() {
  if (state.busy || !state.files.length) return;
  const nodes = buildNodes();
  const compressNode = [...nodes].reverse().find((node) => node.type === "compress");
  const convertNode = nodes.find((node) => node.type === "convert");
  const jpgQuality = compressNode?.params.quality ?? convertNode?.params.quality ?? 92;
  const naming = { mode: Number(ui.naming.value), prefix: ui.prefix.value.trim() || "Image" };
  const total = state.files.length;

  resetResults();
  renderFiles();
  setBusy(true);
  const used = new Set();

  try {
    for (let index = 0; index < total; index += 1) {
      const file = state.files[index];
      ui.result.textContent = `正在处理 ${index + 1} / ${total} · ${file.name}`;
      setStatus(`处理中：${file.name}`, (index / total) * 100);
      const sourceSize = file.size;
      try {
        const buffer = await file.arrayBuffer();
        const response = await workerCall("batch-file", {
          buffer,
          settings: { nodes, originalName: file.name, jpgQuality },
        }, [buffer]);

        let output = response.buffer;
        let quantized = false;
        let fallback = false;
        let keptOriginal = false;
        let paletteLength = 0;
        let engineName = "";
        if (response.needsQuantize && compressNode) {
          const params = compressNode.params;
          const quantizedResult = await quantizePng(output, {
            maxColors: params.maxColors,
            speed: params.speed,
            qualityMin: params.qualityMin,
            qualityTarget: params.qualityTarget,
            dithering: params.dithering,
            posterization: params.posterization,
          });
          if (quantizedResult.fallback) {
            // 画质低于质量下限：放弃量化，再让 Pillow 输出一张优化过的无损 PNG，
            // 避免中间产物（快速压缩）比原图还大。
            fallback = true;
            const retryBuffer = await file.arrayBuffer();
            const retryNodes = nodes.map((node) =>
              node.type === "compress" ? { ...node, params: { ...node.params, maxColors: 1 } } : node);
            const retry = await workerCall("batch-file", {
              buffer: retryBuffer,
              settings: { nodes: retryNodes, originalName: file.name, jpgQuality },
            }, [retryBuffer]);
            output = retry.buffer;
          } else {
            output = quantizedResult.buffer;
            quantized = true;
            paletteLength = quantizedResult.paletteLength;
            engineName = quantizedResult.engine || "";
          }
        }
        // 对应 pngquant 的 --skip-if-larger：同格式且结果更大时保留原文件，避免体积倒退
        if (ui.skipLarger.checked && response.extension === normalizeExt(file.name) && output.byteLength > sourceSize) {
          const originalBuffer = await file.arrayBuffer();
          output = originalBuffer;
          keptOriginal = true;
          quantized = false;
          fallback = false;
        }

        const name = uniqueName(buildName(file.name, response.extension, index, naming), used);
        state.results.push({
          name,
          buffer: output,
          sourceSize,
          outputSize: output.byteLength,
          quantized,
          fallback,
          keptOriginal,
          paletteLength,
          engine: engineName,
        });
      } catch (error) {
        state.results.push({ name: file.name, error: error?.message || String(error), sourceSize, outputSize: 0 });
      }
      renderFiles();
    }
    summarize();
    const ok = state.results.filter((result) => !result.error).length;
    setStatus(`批量处理完成：成功 ${ok} / ${total}`, 100);
  } finally {
    setBusy(false);
  }
}

async function exportZip() {
  const done = state.results.filter((result) => !result.error);
  if (!done.length) return;
  setBusy(true);
  setStatus("正在打包 ZIP", 80);
  try {
    const zip = new JSZip();
    done.forEach((result) => zip.file(result.name, result.buffer));
    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
      (meta) => setStatus("正在打包 ZIP", 80 + meta.percent * 0.19),
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `piccave_batch_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus(`已导出 ${done.length} 张 · ZIP ${formatBytes(blob.size)}`, 100);
  } catch (error) {
    setStatus(`打包失败：${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 初始化 ---------------- */

function bindDropZone(zone, input, callback) {
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragging");
  }));
  zone.addEventListener("drop", (event) => callback([...event.dataTransfer.files]));
  input.addEventListener("change", () => {
    callback([...input.files]);
    input.value = "";
  });
}

function setSourceMenu(open) {
  ui.sourceMenu.hidden = !open;
  ui.drop.setAttribute("aria-expanded", String(open));
}

async function ensureEngine() {
  if (state.engineReady) return true;
  try {
    await loadQuantizer();
    state.engineReady = true;
    return true;
  } catch (error) {
    console.error("处理引擎初始化失败：", error);
    return false;
  }
}

export function initBatchModule() {
  ui = collectUi();
  if (!ui.workspace) return;

  bindDropZone(ui.drop, ui.input, addFiles);
  ui.folderInput.addEventListener("change", () => {
    addFiles([...ui.folderInput.files]);
    ui.folderInput.value = "";
  });
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

  ui.tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.batchTab)));

  ui.clear.addEventListener("click", () => {
    state.files = [];
    resetResults();
    renderFiles();
    refreshControls();
    setStatus("已清空素材", 0);
  });

  ui.format.addEventListener("change", refreshControls);
  ui.keepRes.addEventListener("change", () => {
    const disabled = ui.keepRes.checked;
    ui.width.disabled = disabled;
    ui.height.disabled = disabled;
  });

  const bindRange = (input, output, suffix = "") => {
    input.addEventListener("input", () => {
      output.textContent = `${input.value}${suffix}`;
    });
  };
  bindRange(ui.convertQuality, ui.convertQualityValue);
  bindRange(ui.jpgQuality, ui.jpgQualityValue);

  // PNG 质量允许随手写「80」或「80-95」，失焦/回车时归一回「下限-上限」，让简写被解释成什么一目了然。
  const normalizePngQuality = () => {
    const { min, max } = parsePngQuality(ui.pngQuality.value);
    ui.pngQuality.value = `${min}-${max}`;
  };
  ui.pngQuality.addEventListener("change", normalizePngQuality);
  ui.pngQuality.addEventListener("blur", normalizePngQuality);

  ui.naming.addEventListener("change", () => {
    ui.prefix.disabled = ui.naming.value !== "1";
  });

  ui.addConvert.addEventListener("click", () => {
    state.nodes.push(newNode("convert"));
    renderNodes();
  });
  ui.addCompress.addEventListener("click", () => {
    state.nodes.push(newNode("compress"));
    renderNodes();
  });
  ui.clearNodes.addEventListener("click", () => {
    state.nodes = [];
    renderNodes();
  });

  ui.run.addEventListener("click", run);
  ui.export.addEventListener("click", exportZip);

  const navButton = document.querySelector('.module-nav[data-module="batch"]');
  if (navButton) {
    navButton.addEventListener("click", () => {
      if (!state.loaded) {
        state.loaded = true;
        ensureEngine();
      }
    });
  }

  renderNodes();
  renderFiles();
  refreshControls();
}
