const $ = (id) => document.getElementById(id);
const ACCEPTED = /\.(png|jpe?g|webp|bmp)$/i;
const MIME = { png: "image/png", webp: "image/webp", jpg: "image/jpeg" };

const state = {
  file: null,
  sourceUrl: "",
  resultBlob: null,
  resultUrl: "",
  sourceWidth: 0,
  sourceHeight: 0,
  busy: false,
  modelLoading: false,
  modelReady: false,
  worker: null,
  requestId: 0,
  pending: new Map(),
  previewViews: {
    source: { scale: 1, x: 0, y: 0, drag: null },
    result: { scale: 1, x: 0, y: 0, drag: null },
  },
};

let ui = null;

function setStatus(label, value) {
  const text = $("status-text");
  const bar = $("progress");
  if (text) text.textContent = label;
  if (bar && Number.isFinite(value)) bar.value = Math.max(0, Math.min(100, value));
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function collectUi() {
  return {
    workspace: $("enhance-workspace"),
    input: $("enhance-input"),
    drop: $("enhance-drop"),
    clear: $("enhance-clear"),
    count: $("enhance-count"),
    list: $("enhance-list"),
    sourcePreview: $("enhance-source-preview"),
    resultPreview: $("enhance-result-preview"),
    sourceStage: $("enhance-source-preview")?.parentElement,
    resultStage: $("enhance-result-preview")?.parentElement,
    sourceEmpty: $("enhance-source-empty"),
    resultEmpty: $("enhance-result-empty"),
    sourceSize: $("enhance-source-size"),
    resultSize: $("enhance-result-size"),
    engineNote: $("enhance-engine-note"),
    tileSize: $("enhance-tile-size"),
    scale: $("enhance-scale"),
    format: $("enhance-format"),
    quality: $("enhance-quality"),
    qualityValue: $("enhance-quality-value"),
    qualityRow: $("enhance-quality-row"),
    result: $("enhance-result"),
    run: $("enhance-run"),
    export: $("enhance-export"),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function previewParts(kind) {
  return {
    image: kind === "source" ? ui.sourcePreview : ui.resultPreview,
    stage: kind === "source" ? ui.sourceStage : ui.resultStage,
    view: state.previewViews[kind],
  };
}

function renderPreviewView(kind) {
  const { image, stage, view } = previewParts(kind);
  image.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
  stage.classList.toggle("is-zoomed", view.scale > 1);
}

function constrainPreviewView(kind) {
  const { stage, view } = previewParts(kind);
  const overflowX = stage.clientWidth * (view.scale - 1);
  const overflowY = stage.clientHeight * (view.scale - 1);
  view.x = clamp(view.x, -overflowX, 0);
  view.y = clamp(view.y, -overflowY, 0);
}

function resetPreviewView(kind) {
  const { view } = previewParts(kind);
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  view.drag = null;
  renderPreviewView(kind);
}

function bindPreviewView(kind) {
  const { image, stage, view } = previewParts(kind);
  stage.addEventListener("wheel", (event) => {
    if (image.hidden || !image.getAttribute("src")) return;
    const nextScale = clamp(view.scale * (event.deltaY < 0 ? 1.14 : 1 / 1.14), 1, 10);
    if (nextScale === view.scale) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const ratio = nextScale / view.scale;
    view.x = pointerX - (pointerX - view.x) * ratio;
    view.y = pointerY - (pointerY - view.y) * ratio;
    view.scale = nextScale;
    constrainPreviewView(kind);
    renderPreviewView(kind);
  }, { passive: false });

  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.scale <= 1 || image.hidden) return;
    view.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    view.x = view.drag.x + event.clientX - view.drag.startX;
    view.y = view.drag.y + event.clientY - view.drag.startY;
    constrainPreviewView(kind);
    renderPreviewView(kind);
  });
  const stopDrag = (event) => {
    if (!view.drag || view.drag.pointerId !== event.pointerId) return;
    view.drag = null;
    stage.classList.remove("is-dragging");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener("pointerup", stopDrag);
  stage.addEventListener("pointercancel", stopDrag);
  stage.addEventListener("dblclick", (event) => {
    if (image.hidden) return;
    event.preventDefault();
    resetPreviewView(kind);
  });
  image.addEventListener("dragstart", (event) => event.preventDefault());
  resetPreviewView(kind);
}

function createWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker(new URL("./enhance-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === "progress") {
      setStatus(message.label, message.value);
      if (state.modelLoading) ui.engineNote.textContent = message.label;
      return;
    }
    const pending = state.pending.get(message.id);
    if (!pending) return;
    state.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message);
  };
  worker.onerror = (event) => {
    state.pending.forEach(({ reject }) => reject(new Error(event.message || "AI 处理线程异常")));
    state.pending.clear();
  };
  state.worker = worker;
  return worker;
}

function workerCall(type, payload = {}, transfers = []) {
  const id = ++state.requestId;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    createWorker().postMessage({ type, id, ...payload }, transfers);
  });
}

function resetWorker() {
  if (state.worker) state.worker.terminate();
  state.worker = null;
  state.modelReady = false;
  state.pending.clear();
}

function showEngineResult(response) {
  ui.engineNote.classList.remove("is-error");
  ui.engineNote.textContent = `当前使用 ${response.engine} 进行模型推理。`;
}

async function preloadModel() {
  if (state.modelReady || state.modelLoading) return;
  state.modelLoading = true;
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  ui.engineNote.classList.remove("is-error");
  ui.engineNote.textContent = localHost ? "正在从本地读取 WebGPU 模型" : "正在加载 WebGPU 模型";
  try {
    const response = await workerCall("init");
    state.modelReady = true;
    showEngineResult(response);
    setStatus(`AI 模型已加载（${response.engine}）`, 100);
  } catch (error) {
    resetWorker();
    ui.engineNote.classList.add("is-error");
    ui.engineNote.textContent = error.message;
    setStatus(`AI 模型加载失败：${error.message}`, 0);
    console.error("AI 模型预加载失败：", error);
  } finally {
    state.modelLoading = false;
  }
}

function revokeUrl(key) {
  if (state[key]) URL.revokeObjectURL(state[key]);
  state[key] = "";
}

function clearResult() {
  revokeUrl("resultUrl");
  state.resultBlob = null;
  ui.resultPreview.removeAttribute("src");
  ui.resultPreview.hidden = true;
  ui.resultEmpty.hidden = false;
  ui.resultEmpty.querySelector("span").textContent = state.file ? "等待开始增强" : "等待添加图片";
  ui.resultSize.textContent = "-";
  ui.resultStage.classList.remove("has-image", "is-dragging");
  resetPreviewView("result");
  ui.export.disabled = true;
}

function setBusy(busy) {
  state.busy = busy;
  ui.run.disabled = busy || !state.file;
  ui.export.disabled = busy || !state.resultBlob;
  ui.clear.disabled = busy || !state.file;
  ui.input.disabled = busy;
  ui.tileSize.disabled = busy;
}

function renderFile() {
  ui.count.textContent = state.file ? "1 张" : "0 张";
  if (!state.file) {
    ui.list.innerHTML = '<div class="empty-list">尚未添加图片</div>';
    return;
  }
  const row = document.createElement("div");
  row.className = "frame-row batch-row-item";
  row.innerHTML = '<span class="frame-index">1</span><span class="frame-name"></span><span class="batch-row-meta"></span>';
  row.querySelector(".frame-name").textContent = state.file.name;
  row.querySelector(".batch-row-meta").textContent = `${state.sourceWidth} × ${state.sourceHeight}`;
  row.title = `${state.file.name} · ${formatBytes(state.file.size)}`;
  ui.list.replaceChildren(row);
}

async function loadFile(file) {
  if (!file) return;
  if (!(file.type?.startsWith("image/") || ACCEPTED.test(file.name))) {
    setStatus("请选择 PNG、JPG、WebP 或 BMP 图片", 0);
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    state.sourceWidth = bitmap.width;
    state.sourceHeight = bitmap.height;
    bitmap.close();
  } catch (_) {
    setStatus("浏览器无法解码这张图片", 0);
    return;
  }

  state.file = file;
  revokeUrl("sourceUrl");
  state.sourceUrl = URL.createObjectURL(file);
  ui.sourcePreview.src = state.sourceUrl;
  ui.sourcePreview.hidden = false;
  ui.sourceStage.classList.add("has-image");
  resetPreviewView("source");
  ui.sourceEmpty.hidden = true;
  ui.sourceSize.textContent = `${state.sourceWidth} × ${state.sourceHeight}`;
  clearResult();
  renderFile();
  ui.result.textContent = `${file.name} · ${formatBytes(file.size)} · AI 输出 ${state.sourceWidth * 4} × ${state.sourceHeight * 4}`;
  setBusy(false);
  setStatus("图片已载入，可以开始增强", 0);
}

function clearFile() {
  revokeUrl("sourceUrl");
  state.file = null;
  state.sourceWidth = 0;
  state.sourceHeight = 0;
  ui.sourcePreview.removeAttribute("src");
  ui.sourcePreview.hidden = true;
  ui.sourceStage.classList.remove("has-image", "is-dragging");
  resetPreviewView("source");
  ui.sourceEmpty.hidden = false;
  ui.sourceSize.textContent = "-";
  clearResult();
  renderFile();
  ui.result.textContent = "等待添加图片";
  setBusy(false);
  setStatus("已清空 AI 增强素材", 0);
}

async function runEnhance() {
  if (!state.file || state.busy) return;
  setBusy(true);
  clearResult();
  ui.result.textContent = state.modelReady ? "正在使用 AI 模型增强图片" : "正在等待 AI 模型加载完成";
  try {
    const buffer = await state.file.arrayBuffer();
    const response = await workerCall("enhance", {
      buffer,
      mime: state.file.type,
      tileSize: Number(ui.tileSize.value),
    }, [buffer]);
    state.resultBlob = new Blob([response.buffer], { type: "image/png" });
    state.modelReady = true;
    state.resultUrl = URL.createObjectURL(state.resultBlob);
    ui.resultPreview.src = state.resultUrl;
    ui.resultPreview.hidden = false;
    ui.resultStage.classList.add("has-image");
    resetPreviewView("result");
    ui.resultEmpty.hidden = true;
    ui.resultSize.textContent = `${response.outputWidth} × ${response.outputHeight}`;
    showEngineResult(response);
    ui.result.textContent = `增强完成 · ${response.outputWidth} × ${response.outputHeight} · ${formatBytes(state.resultBlob.size)}`;
    setStatus(`AI 增强完成（${response.engine}）`, 100);
  } catch (error) {
    ui.result.textContent = `增强失败：${error.message}`;
    ui.resultEmpty.querySelector("span").textContent = "处理失败，请调整分块后重试";
    setStatus(`AI 增强失败：${error.message}`, 0);
    console.error("AI 图片增强失败：", error);
  } finally {
    setBusy(false);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))), type, quality);
  });
}

async function exportResult() {
  if (!state.resultBlob || state.busy) return;
  setBusy(true);
  setStatus("正在生成导出图片", 94);
  try {
    const bitmap = await createImageBitmap(state.resultBlob);
    const scale = Number(ui.scale.value) || 4;
    const width = state.sourceWidth * scale;
    const height = state.sourceHeight * scale;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (ui.format.value === "jpg") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const format = ui.format.value;
    const blob = await canvasToBlob(canvas, MIME[format], Number(ui.quality.value) / 100);
    const base = state.file.name.replace(/\.[^.]+$/, "") || "image";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${base}_enhanced_${scale}x.${format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ui.result.textContent = `已导出 ${width} × ${height} · ${formatBytes(blob.size)}`;
    setStatus("增强图片已导出", 100);
  } catch (error) {
    setStatus(`导出失败：${error.message}`, 0);
  } finally {
    setBusy(false);
  }
}

function bindDropZone() {
  ["dragenter", "dragover"].forEach((name) => ui.drop.addEventListener(name, (event) => {
    event.preventDefault();
    if (!state.busy) ui.drop.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => ui.drop.addEventListener(name, (event) => {
    event.preventDefault();
    ui.drop.classList.remove("is-dragging");
  }));
  ui.drop.addEventListener("drop", (event) => {
    if (!state.busy) loadFile([...event.dataTransfer.files][0]);
  });
  ui.drop.addEventListener("click", () => { if (!state.busy) ui.input.click(); });
  ui.drop.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !state.busy) {
      event.preventDefault();
      ui.input.click();
    }
  });
  ui.input.addEventListener("click", (event) => event.stopPropagation());
  ui.input.addEventListener("change", () => {
    loadFile(ui.input.files[0]);
    ui.input.value = "";
  });
}

export function initEnhanceModule() {
  ui = collectUi();
  if (!ui.workspace) return;
  bindPreviewView("source");
  bindPreviewView("result");
  bindDropZone();
  ui.clear.addEventListener("click", clearFile);
  ui.run.addEventListener("click", runEnhance);
  ui.export.addEventListener("click", exportResult);
  ui.tileSize.addEventListener("change", () => {
    if (!state.resultBlob) return;
    clearResult();
    ui.result.textContent = "分块大小已改变，请重新增强";
  });
  ui.format.addEventListener("change", () => {
    ui.qualityRow.hidden = ui.format.value === "png";
  });
  ui.quality.addEventListener("input", () => { ui.qualityValue.textContent = ui.quality.value; });
  renderFile();
  setBusy(false);
  preloadModel();
}
