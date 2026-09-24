const $ = (id) => document.getElementById(id);
const ACCEPTED = /\.(png|webp|tiff?|tga)$/i;

const state = {
  files: [], current: -1,
  file: null, sourceUrl: "", textureBlob: null, visibleBlob: null, resultUrl: "",
  width: 0, height: 0, busy: false, worker: null, requestId: 0, activeRequest: 0,
  debounce: null,
  views: { source: { scale: 1, x: 0, y: 0, drag: null }, result: { scale: 1, x: 0, y: 0, drag: null } },
};
let ui;

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}
function setStatus(label, value = 0) {
  $("status-text").textContent = label;
  $("progress").value = Math.max(0, Math.min(100, value));
}
function revoke(key) { if (state[key]) URL.revokeObjectURL(state[key]); state[key] = ""; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function previewParts(kind) {
  return { image: kind === "source" ? ui.sourcePreview : ui.resultPreview, stage: kind === "source" ? ui.sourceStage : ui.resultStage, view: state.views[kind] };
}
function renderView(kind) {
  const { image, stage, view } = previewParts(kind);
  image.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
  stage.classList.toggle("is-zoomed", view.scale > 1);
}
function constrainView(kind) {
  const { stage, view } = previewParts(kind);
  view.x = clamp(view.x, -stage.clientWidth * (view.scale - 1), 0);
  view.y = clamp(view.y, -stage.clientHeight * (view.scale - 1), 0);
}
function resetView(kind) {
  Object.assign(state.views[kind], { scale: 1, x: 0, y: 0, drag: null });
  renderView(kind);
}
function bindView(kind) {
  const { image, stage, view } = previewParts(kind);
  stage.addEventListener("wheel", (event) => {
    if (image.hidden || !image.src) return;
    const scale = clamp(view.scale * (event.deltaY < 0 ? 1.14 : 1 / 1.14), 1, 10);
    if (scale === view.scale) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top, ratio = scale / view.scale;
    view.x = px - (px - view.x) * ratio; view.y = py - (py - view.y) * ratio; view.scale = scale;
    constrainView(kind); renderView(kind);
  }, { passive: false });
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.scale <= 1 || image.hidden) return;
    view.drag = { id: event.pointerId, px: event.clientX, py: event.clientY, x: view.x, y: view.y };
    stage.setPointerCapture(event.pointerId); stage.classList.add("is-dragging"); event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (!view.drag || view.drag.id !== event.pointerId) return;
    view.x = view.drag.x + event.clientX - view.drag.px; view.y = view.drag.y + event.clientY - view.drag.py;
    constrainView(kind); renderView(kind);
  });
  const stop = (event) => {
    if (!view.drag || view.drag.id !== event.pointerId) return;
    view.drag = null; stage.classList.remove("is-dragging");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener("pointerup", stop); stage.addEventListener("pointercancel", stop);
  stage.addEventListener("dblclick", () => resetView(kind));
  image.addEventListener("dragstart", (event) => event.preventDefault());
}

function createWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker(new URL("./expand-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.id !== state.activeRequest) return;
    if (message.type === "progress") { setStatus(message.label, message.value); return; }
    if (message.type === "error") finishError(message.message);
    if (message.type === "result") finishResult(message);
  };
  worker.onerror = (event) => finishError(event.message || "扩边处理线程异常");
  state.worker = worker;
  return worker;
}
function options() {
  return {
    distance: Number(ui.distance.value), threshold: Number(ui.threshold.value),
    inset: Number(ui.inset.value), blur: Number(ui.blur.value),
    isolate: ui.isolate.checked, diagonal: ui.diagonal.checked,
  };
}
function setBusy(busy) {
  state.busy = busy;
  ui.run.disabled = busy || !state.file; ui.export.disabled = busy || !state.textureBlob;
  ui.clear.disabled = busy || !state.files.length; ui.input.disabled = busy;
}
function clearResult(message = "等待处理") {
  revoke("resultUrl"); state.textureBlob = null; state.visibleBlob = null;
  ui.resultPreview.hidden = true; ui.resultPreview.removeAttribute("src"); ui.resultEmpty.hidden = false;
  ui.resultEmpty.querySelector("span").textContent = message; ui.resultStage.classList.remove("has-image", "is-dragging");
  ui.resultSize.textContent = "-"; ui.export.disabled = true; resetView("result");
}
function showSelectedResult() {
  const blob = ui.previewVisible.checked ? state.visibleBlob : state.textureBlob;
  if (!blob) return;
  revoke("resultUrl"); state.resultUrl = URL.createObjectURL(blob); ui.resultPreview.src = state.resultUrl;
  ui.resultPreview.hidden = false; ui.resultEmpty.hidden = true; ui.resultStage.classList.add("has-image"); resetView("result");
}
async function processImage() {
  if (!state.file) return;
  window.clearTimeout(state.debounce);
  const id = ++state.requestId; state.activeRequest = id; setBusy(true); clearResult("正在处理透明边界");
  ui.result.textContent = "正在计算扩边区域"; setStatus("正在准备透明图片扩边", 2);
  try {
    const buffer = await state.file.arrayBuffer();
    createWorker().postMessage({ type: "process", id, buffer, mime: state.file.type, options: options() }, [buffer]);
  } catch (error) { finishError(error.message); }
}
function finishResult(message) {
  state.textureBlob = new Blob([message.textureBuffer], { type: "image/png" });
  state.visibleBlob = new Blob([message.visibleBuffer], { type: "image/png" });
  showSelectedResult(); ui.resultSize.textContent = `${message.width} × ${message.height}`;
  ui.result.textContent = `处理完成 · ${message.islands} 个区域 · 扩边 ${message.filled.toLocaleString()} 像素`;
  setBusy(false); setStatus("透明图片扩边完成", 100);
}
function finishError(message) {
  clearResult("处理失败，请调整参数后重试"); ui.result.textContent = `处理失败：${message}`;
  setBusy(false); setStatus(`透明图片扩边失败：${message}`, 0); console.error("透明图片扩边失败：", message);
}
function scheduleProcess() {
  if (!state.file) return;
  window.clearTimeout(state.debounce); clearResult("参数已改变，等待重新处理");
  ui.result.textContent = "参数已改变，正在等待重新处理";
  state.debounce = window.setTimeout(processImage, 280);
}

function renderFiles() {
  ui.count.textContent = `${state.files.length} 张`;
  if (!state.files.length) {
    ui.list.innerHTML = '<div class="empty-list">尚未添加图片</div>';
    return;
  }
  ui.list.replaceChildren(...state.files.map((item, index) => {
    const row = document.createElement("button"); row.type = "button";
    row.className = `frame-row batch-row-item${index === state.current ? " is-active" : ""}`;
    row.innerHTML = `<span class="frame-index">${index + 1}</span><span class="frame-name"></span><span class="batch-row-meta">${item.width} × ${item.height}</span>`;
    row.querySelector(".frame-name").textContent = item.file.name;
    row.title = `${item.file.name} · ${formatBytes(item.file.size)}`;
    row.addEventListener("click", () => { if (!state.busy) selectFile(index); });
    return row;
  }));
}
function selectFile(index) {
  const item = state.files[index];
  if (!item) return;
  window.clearTimeout(state.debounce); state.activeRequest = ++state.requestId;
  state.current = index; state.file = item.file; state.width = item.width; state.height = item.height;
  revoke("sourceUrl"); state.sourceUrl = URL.createObjectURL(item.file);
  ui.sourcePreview.src = state.sourceUrl; ui.sourcePreview.hidden = false; ui.sourceEmpty.hidden = true;
  ui.sourceStage.classList.add("has-image"); ui.sourceSize.textContent = `${state.width} × ${state.height}`; resetView("source");
  clearResult(); renderFiles(); ui.result.textContent = `${item.file.name} · ${formatBytes(item.file.size)}`; setBusy(false); processImage();
}
async function addFiles(incoming) {
  const candidates = incoming.filter((file) => file.type?.startsWith("image/") || ACCEPTED.test(file.name));
  if (!candidates.length) { setStatus("请选择 PNG、WebP、TIFF 或 TGA 图片", 0); return; }
  const seen = new Set(state.files.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  const added = [];
  for (const file of candidates) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    try {
      const bitmap = await createImageBitmap(file);
      added.push({ file, width: bitmap.width, height: bitmap.height });
      bitmap.close(); seen.add(key);
    } catch (_) { /* 跳过浏览器无法解码的文件 */ }
  }
  if (!added.length) { setStatus("没有新增可解码图片，重复图片不会再次添加", 0); return; }
  const firstNew = state.files.length;
  state.files.push(...added);
  selectFile(firstNew);
  setStatus(`已添加 ${added.length} 张图片，共 ${state.files.length} 张`, 0);
}
function clearFile() {
  window.clearTimeout(state.debounce); state.activeRequest = ++state.requestId; state.files = []; state.current = -1; state.file = null; state.width = 0; state.height = 0;
  revoke("sourceUrl"); ui.sourcePreview.hidden = true; ui.sourcePreview.removeAttribute("src"); ui.sourceEmpty.hidden = false;
  ui.sourceStage.classList.remove("has-image", "is-dragging"); ui.sourceSize.textContent = "-"; resetView("source");
  clearResult(); renderFiles();
  ui.result.textContent = "等待添加透明图片"; setBusy(false); setStatus("已清空透明图片", 0);
}
function exportImage() {
  const blob = ui.exportVisible.checked ? state.visibleBlob : state.textureBlob;
  if (!blob || !state.file) return;
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  const base = state.file.name.replace(/\.[^.]+$/, "") || "image";
  anchor.href = url; anchor.download = `${base}_extended.png`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000); setStatus("扩边图片已导出", 100);
}
function bindDrop() {
  ["dragenter", "dragover"].forEach((name) => ui.drop.addEventListener(name, (event) => { event.preventDefault(); if (!state.busy) ui.drop.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((name) => ui.drop.addEventListener(name, (event) => { event.preventDefault(); ui.drop.classList.remove("is-dragging"); }));
  ui.drop.addEventListener("drop", (event) => { if (!state.busy) addFiles([...event.dataTransfer.files]); });
  ui.drop.addEventListener("click", () => { if (!state.busy) ui.input.click(); });
  ui.drop.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !state.busy) { event.preventDefault(); ui.input.click(); } });
  ui.input.addEventListener("click", (event) => event.stopPropagation());
  ui.input.addEventListener("change", () => { addFiles([...ui.input.files]); ui.input.value = ""; });
}

export function initExpandModule() {
  ui = {
    workspace: $("expand-workspace"), input: $("expand-input"), drop: $("expand-drop"), clear: $("expand-clear"), count: $("expand-count"), list: $("expand-list"),
    sourcePreview: $("expand-source-preview"), resultPreview: $("expand-result-preview"), sourceEmpty: $("expand-source-empty"), resultEmpty: $("expand-result-empty"),
    sourceSize: $("expand-source-size"), resultSize: $("expand-result-size"), distance: $("expand-distance"), threshold: $("expand-threshold"), inset: $("expand-inset"), blur: $("expand-blur"),
    isolate: $("expand-isolate"), diagonal: $("expand-diagonal"), previewVisible: $("expand-preview-visible"), exportVisible: $("expand-export-visible"),
    result: $("expand-result"), run: $("expand-run"), export: $("expand-export"),
  };
  if (!ui.workspace) return;
  ui.sourceStage = ui.sourcePreview.parentElement; ui.resultStage = ui.resultPreview.parentElement;
  bindView("source"); bindView("result"); bindDrop();
  ui.clear.addEventListener("click", clearFile); ui.run.addEventListener("click", processImage); ui.export.addEventListener("click", exportImage);
  [ui.distance, ui.threshold, ui.inset, ui.blur, ui.isolate, ui.diagonal].forEach((control) => control.addEventListener("input", scheduleProcess));
  ui.distance.addEventListener("input", () => { $("expand-distance-value").textContent = `${ui.distance.value} px`; });
  ui.blur.addEventListener("input", () => { $("expand-blur-value").textContent = ui.blur.value; });
  ui.previewVisible.addEventListener("change", showSelectedResult);
  renderFiles();
  setBusy(false);
}
