import * as ortWebgpu from "onnxruntime-web/webgpu";
import modelUrl from "../Packages/realesrgan_x4.onnx?url";
import webgpuWasmUrl from "../Packages/ort-wasm-simd-threaded.asyncify.wasm?url";

const MODEL_SCALE = 4;
const TILE_PAD = 32;
const MAX_OUTPUT_PIXELS = 64_000_000;

const wasmThreads = self.crossOriginIsolated
  ? Math.min(4, Math.max(1, Math.ceil((self.navigator.hardwareConcurrency || 2) / 2)))
  : 1;
ortWebgpu.env.wasm.proxy = false;
ortWebgpu.env.wasm.numThreads = wasmThreads;
ortWebgpu.env.wasm.wasmPaths = { wasm: webgpuWasmUrl };
ortWebgpu.env.webgpu.powerPreference = "high-performance";

let sessionPromise = null;
const engine = "WebGPU";
const activeRuntime = ortWebgpu;

function progress(id, value, label) {
  self.postMessage({ type: "progress", id, value, label });
}

async function fetchWithProgress(id, url, loadingLabel) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`模型下载失败（HTTP ${response.status}）`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !total) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    progress(id, 2 + (received / total) * 17, `${loadingLabel} ${Math.round((received / total) * 100)}%`);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return merged.buffer;
}

function withInitializationStatus(id, label, task, timeoutMs = 90_000) {
  const started = Date.now();
  let timeout;
  const ticker = setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    progress(id, 20, `${label}（${seconds} 秒）`);
  }, 1000);
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label}超过 90 秒，请刷新页面或检查浏览器硬件加速设置`)), timeoutMs);
  });
  return Promise.race([task(), deadline]).finally(() => {
    clearInterval(ticker);
    clearTimeout(timeout);
  });
}

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

async function normalizeWebGpuAdapter(adapter) {
  if (adapter.info) return adapter;

  let legacyInfo;
  if (typeof adapter.requestAdapterInfo === "function") {
    try {
      legacyInfo = await adapter.requestAdapterInfo();
    } catch (_) {
      // 部分旧版 Chromium 暴露了方法但会拒绝调用，继续使用空信息兼容。
    }
  }
  const info = {
    vendor: legacyInfo?.vendor || "",
    architecture: legacyInfo?.architecture || "",
    device: legacyInfo?.device || "",
    description: legacyInfo?.description || "",
    subgroupMinSize: Number(legacyInfo?.subgroupMinSize) || 0,
    subgroupMaxSize: Number(legacyInfo?.subgroupMaxSize) || 0,
    isFallbackAdapter: Boolean(legacyInfo?.isFallbackAdapter),
    subgroupMatrixConfigs: legacyInfo?.subgroupMatrixConfigs,
  };

  // ORT 1.30 的 WebGPU glue 直接读取 adapter.info。Proxy 同时保留原生
  // GPUAdapter 作为方法接收者，避免旧浏览器的 WebIDL brand check 失败。
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "info") return info;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function availableWebGpuAdapter() {
  if (!self.navigator.gpu) return { adapter: null, reason: "当前浏览器未提供 WebGPU，请更新浏览器并检查硬件加速设置" };
  let timeout;
  try {
    const adapter = await Promise.race([
      self.navigator.gpu.requestAdapter({ powerPreference: "high-performance" }),
      new Promise((resolve) => { timeout = setTimeout(() => resolve("timeout"), 5000); }),
    ]);
    if (adapter === "timeout") return { adapter: null, reason: "请求 WebGPU 显卡适配器超时" };
    if (!adapter) return { adapter: null, reason: "未找到可用的 WebGPU 显卡适配器，请检查显卡驱动和硬件加速设置" };
    return { adapter: await normalizeWebGpuAdapter(adapter), reason: "" };
  } catch (error) {
    return { adapter: null, reason: `请求 WebGPU 显卡适配器失败：${errorMessage(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function createSession(id) {
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(self.location.hostname);
  const loadingLabel = localHost ? "正在从本地读取 AI 模型" : "正在加载 AI 模型";
  progress(id, 2, loadingLabel);
  const model = new Uint8Array(await fetchWithProgress(id, modelUrl, loadingLabel));
  const gpu = await availableWebGpuAdapter();
  if (!gpu.adapter) throw new Error(gpu.reason || "WebGPU 初始化失败");
  progress(id, 20, "正在初始化 WebGPU 引擎");
  try {
    ortWebgpu.env.webgpu.adapter = gpu.adapter;
    return await withInitializationStatus(id, "正在初始化 WebGPU 引擎", () =>
      ortWebgpu.InferenceSession.create(model, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
        executionMode: "sequential",
      }));
  } catch (error) {
    throw new Error(`WebGPU 引擎初始化失败：${errorMessage(error)}`);
  }
}

function getSession(id) {
  if (!sessionPromise) {
    sessionPromise = createSession(id).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

function makeTensor(image, imageWidth, startX, startY, width, height) {
  const pixels = width * height;
  const data = new Float32Array(pixels * 3);
  for (let y = 0; y < height; y += 1) {
    let source = ((startY + y) * imageWidth + startX) * 4;
    let target = y * width;
    for (let x = 0; x < width; x += 1) {
      data[target] = image[source] / 255;
      data[pixels + target] = image[source + 1] / 255;
      data[pixels * 2 + target] = image[source + 2] / 255;
      source += 4;
      target += 1;
    }
  }
  return new activeRuntime.Tensor("float32", data, [1, 3, height, width]);
}

function copyTile(output, outputWidth, tensor, inputWidth, core) {
  const data = tensor.data;
  const dims = tensor.dims;
  const tileHeight = Number(dims[dims.length - 2]);
  const tileWidth = Number(dims[dims.length - 1]);
  const plane = tileWidth * tileHeight;
  const scaleX = Math.round(tileWidth / inputWidth);
  if (scaleX !== MODEL_SCALE) throw new Error(`模型输出倍率异常：${scaleX}x`);

  const sourceX = core.relativeX * MODEL_SCALE;
  const sourceY = core.relativeY * MODEL_SCALE;
  const copyWidth = core.width * MODEL_SCALE;
  const copyHeight = core.height * MODEL_SCALE;
  const targetX = core.x * MODEL_SCALE;
  const targetY = core.y * MODEL_SCALE;

  for (let y = 0; y < copyHeight; y += 1) {
    let sourceIndex = (sourceY + y) * tileWidth + sourceX;
    let targetIndex = ((targetY + y) * outputWidth + targetX) * 4;
    for (let x = 0; x < copyWidth; x += 1) {
      output[targetIndex] = Math.max(0, Math.min(255, Math.round(data[sourceIndex] * 255)));
      output[targetIndex + 1] = Math.max(0, Math.min(255, Math.round(data[plane + sourceIndex] * 255)));
      output[targetIndex + 2] = Math.max(0, Math.min(255, Math.round(data[plane * 2 + sourceIndex] * 255)));
      output[targetIndex + 3] = 255;
      sourceIndex += 1;
      targetIndex += 4;
    }
  }
}

function restoreAlpha(sourceCanvas, output, outputWidth, outputHeight) {
  const alphaCanvas = new OffscreenCanvas(outputWidth, outputHeight);
  const alphaContext = alphaCanvas.getContext("2d", { willReadFrequently: true });
  alphaContext.imageSmoothingEnabled = true;
  alphaContext.imageSmoothingQuality = "high";
  alphaContext.drawImage(sourceCanvas, 0, 0, outputWidth, outputHeight);
  const alpha = alphaContext.getImageData(0, 0, outputWidth, outputHeight).data;
  for (let index = 3; index < output.length; index += 4) output[index] = alpha[index];
}

async function enhance(id, buffer, mime, tileSize) {
  const blob = new Blob([buffer], { type: mime || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const outputWidth = width * MODEL_SCALE;
  const outputHeight = height * MODEL_SCALE;
  if (outputWidth * outputHeight > MAX_OUTPUT_PIXELS) {
    bitmap.close();
    throw new Error("图片放大后超过 6400 万像素，请先缩小原图再处理");
  }

  const sourceCanvas = new OffscreenCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(bitmap, 0, 0);
  bitmap.close();
  const source = sourceContext.getImageData(0, 0, width, height).data;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const session = await getSession(id);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const total = tilesX * tilesY;
  let completed = 0;

  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const startX = Math.max(0, x - TILE_PAD);
      const startY = Math.max(0, y - TILE_PAD);
      const endX = Math.min(width, x + tileSize + TILE_PAD);
      const endY = Math.min(height, y + tileSize + TILE_PAD);
      const inputWidth = endX - startX;
      const inputHeight = endY - startY;
      const tensor = makeTensor(source, width, startX, startY, inputWidth, inputHeight);
      const results = await session.run({ [inputName]: tensor });
      const result = results[outputName];
      copyTile(output, outputWidth, result, inputWidth, {
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
        relativeX: x - startX,
        relativeY: y - startY,
      });
      tensor.dispose();
      result.dispose();
      completed += 1;
      progress(id, 24 + (completed / total) * 68, `AI 增强中 ${completed} / ${total} 块`);
    }
  }

  progress(id, 94, "正在生成增强图片");
  restoreAlpha(sourceCanvas, output, outputWidth, outputHeight);
  const resultCanvas = new OffscreenCanvas(outputWidth, outputHeight);
  resultCanvas.getContext("2d").putImageData(new ImageData(output, outputWidth, outputHeight), 0, 0);
  const resultBlob = await resultCanvas.convertToBlob({ type: "image/png" });
  const resultBuffer = await resultBlob.arrayBuffer();
  return { buffer: resultBuffer, width, height, outputWidth, outputHeight, engine };
}

self.onmessage = async (event) => {
  const { type, id } = event.data;
  try {
    if (type === "init") {
      await getSession(id);
      self.postMessage({ type: "ready", id, engine });
      return;
    }
    if (type === "enhance") {
      const result = await enhance(
        id,
        event.data.buffer,
        event.data.mime,
        Math.max(128, Math.min(512, Number(event.data.tileSize) || 256)),
      );
      self.postMessage({ type: "result", id, ...result }, [result.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || String(error) });
  }
};
