/**
 * 量化引擎调度层
 * ---------------------------------------------------------------------------
 * 极致压缩的 PNG 色彩量化有两条通道，优先级如下：
 *
 *   1. native —— 通过 Vite 中间件调用 Packages/pngquant.exe（真·pngquant）
 *      仅在 `npm run dev` / `npm run preview`（启动网页版.bat）下可用。
 *   2. wasm   —— libimagequant WASM 工作线程，pngquant 的量化内核
 *      静态部署（GitHub Pages）没有 Node 进程时的自动回退。
 *
 * 两条通道对上层暴露同一个契约：
 *   { buffer: ArrayBuffer|null, fallback: boolean, quality: number,
 *     paletteLength: number, engine: "pngquant" | "libimagequant" }
 *
 * fallback = true 表示"放弃量化"（画质不达标 / 结果更大），此时 buffer 为
 * null，调用方应保留无损结果 —— 对应 pngquant 的退出码 99 / 98。
 */

const BASE_URL = import.meta.env.BASE_URL || "/";
const HEALTH_ENDPOINT = `${BASE_URL}api/pngquant/health`;
const QUANTIZE_ENDPOINT = `${BASE_URL}api/pngquant`;

/** 健康探测超时：静态部署上这个请求注定失败，不能让它拖慢首屏。 */
const PROBE_TIMEOUT_MS = 2500;

let enginePromise = null;
let wasmRuntime = null;

const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

/* ------------------------- libimagequant WASM 回退 ------------------------- */

function createWasmRuntime() {
  const worker = new Worker(new URL("./libimagequant-worker.js", import.meta.url), { type: "module" });
  let requestId = 0;
  const pending = new Map();

  worker.onmessage = (event) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "error") request.reject(new Error(message.message));
    else request.resolve(message);
  };

  worker.onerror = (event) => {
    pending.forEach((request) => request.reject(new Error(event.message || "图像处理模块加载失败")));
    pending.clear();
  };

  const call = (type, payload = {}, transfers = []) => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...payload }, transfers);
    });
  };

  let ready = null;
  return {
    ready() {
      if (!ready) {
        ready = call("init").then(() => true).catch((error) => {
          ready = null;
          throw error;
        });
      }
      return ready;
    },
    quantize(buffer, options) {
      return call("quantize", { buffer, options }, [buffer]);
    },
  };
}

function getWasmRuntime() {
  if (!wasmRuntime) wasmRuntime = createWasmRuntime();
  return wasmRuntime;
}

/* ------------------------------ 引擎探测 ------------------------------ */

async function detectEngine() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(HEALTH_ENDPOINT, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }

    // 静态托管下 SPA 兜底可能返回 200 + HTML，必须校验 Content-Type
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("application/json")) throw new Error("bridge-unavailable");

    const info = await response.json();
    if (!info?.ok) throw new Error(info?.error || "bridge-unavailable");

    return {
      mode: "native",
      label: "本地处理引擎",
      version: info.version || "",
      binary: info.binary || "",
      features: info.features || null,
      reason: "",
    };
  } catch (error) {
    return {
      mode: "wasm",
      label: "本地处理引擎",
      version: "",
      binary: "",
      features: null,
      reason: error?.name === "AbortError" ? "探测超时" : error?.message || "bridge-unavailable",
    };
  }
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 解析并缓存量化引擎。返回引擎描述对象（含 mode / label / version）。
 * native 模式不需要预热；wasm 模式会在此完成 WASM 初始化。
 */
export function loadQuantizer() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const engine = await detectEngine();
      if (engine.mode === "wasm") await getWasmRuntime().ready();
      return engine;
    })().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

/** 已解析的引擎信息；未调用过 loadQuantizer 时返回 null。 */
export function getEngineInfo() {
  return enginePromise;
}

export async function quantizePng(buffer, options = {}) {
  const engine = await loadQuantizer();
  return engine.mode === "native" ? quantizeNative(buffer, options) : quantizeWasm(buffer, options);
}

/* ------------------------------ native 通道 ------------------------------ */

function buildNativeParams(options) {
  const params = new URLSearchParams();
  params.set("colors", String(clampInt(options.maxColors, 256, 2, 256)));
  params.set("speed", String(clampInt(options.speed, 4, 1, 11)));
  params.set("qualityMin", String(clampInt(options.qualityMin, 0, 0, 100)));
  params.set("qualityMax", String(clampInt(options.qualityTarget, 100, 0, 100)));
  params.set("posterize", String(clampInt(options.posterization, 0, 0, 4)));
  // pngquant 2.17 只支持开/关抖动，无法表达百分比：>0 一律视为开启
  params.set("dither", Number(options.dithering ?? 1) > 0 ? "1" : "0");
  params.set("verbose", "1");
  return params;
}

async function quantizeNative(buffer, options) {
  const response = await fetch(`${QUANTIZE_ENDPOINT}?${buildNativeParams(options)}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: buffer,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `处理服务返回 HTTP ${response.status}`);
  }

  if ((response.headers.get("X-Quant-Status") || "").toLowerCase() === "fallback") {
    return {
      buffer: null,
      fallback: true,
      reason: response.headers.get("X-Quant-Reason") || "quality",
      quality: 0,
      paletteLength: 0,
      engine: "pngquant",
    };
  }

  const output = await response.arrayBuffer();
  if (!output.byteLength) {
    return { buffer: null, fallback: true, reason: "empty", quality: 0, paletteLength: 0, engine: "pngquant" };
  }

  return {
    buffer: output,
    fallback: false,
    reason: "",
    quality: Number(response.headers.get("X-Quant-Quality")) || 0,
    paletteLength: Number(response.headers.get("X-Quant-Colors")) || 0,
    engine: "pngquant",
  };
}

/* ------------------------------- wasm 通道 ------------------------------- */

async function quantizeWasm(buffer, options) {
  const runtime = getWasmRuntime();
  await runtime.ready();
  const result = await runtime.quantize(buffer, options);
  return { reason: "", ...result, engine: "libimagequant" };
}
