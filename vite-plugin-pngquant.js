/**
 * piccave:pngquant-bridge
 * ---------------------------------------------------------------------------
 * 让浏览器页面能够"直接调用" Packages/pngquant.exe。
 *
 * 背景：浏览器沙箱无法执行原生 Windows 可执行文件。本项目在 Vite 开发/
 * 预览服务器里挂一段中间件，由 Node 以子进程方式调用 pngquant.exe，
 * 前端只需一次同源 fetch：
 *
 *   GET  /api/pngquant/health   -> 探测引擎是否可用（含版本号）
 *   POST /api/pngquant          -> body 为原始 PNG，返回量化后的 PNG
 *
 * 该插件只在 dev / preview 生效；`vite build` 产出的静态站点没有 Node
 * 进程，前端会自动回退到 libimagequant WASM（见 src/quantizer.js）。
 *
 * 实测确认的 pngquant 2.17.0 语义（详见 Packages/NOTICE.txt）：
 *   - 输入 `-` 读 stdin、`--output -` 写 stdout，两者字节完全一致
 *   - 退出码 0   = 成功
 *   - 退出码 99  = 画质低于 --quality 下限（stdout 仍会吐出字节，必须丢弃）
 *   - 退出码 98  = --skip-if-larger 判定结果更大（同样会吐字节，不可信）
 *   - --speed 为 1(最慢/最好) ~ 11(最快/最差)，默认 4
 *   - 抖动只有开 / 关（--nofs 关闭），没有百分比
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HEALTH_PATH = "/api/pngquant/health";
const QUANTIZE_PATH = "/api/pngquant";

/** 请求体上限，避免异常请求把内存吃满（PNG 素材通常远小于此值）。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** 子进程 stderr 保留上限，仅用于解析质量分数。 */
const STDERR_LIMIT_BYTES = 64 * 1024;

const CANDIDATE_PATHS = [
  "Packages/pngquant.exe",
  "Packages/pngquant",
  "packages/pngquant.exe",
  "tools/pngquant.exe",
  "public/Packages/pngquant.exe",
];

function resolveBinary(root, configured) {
  const candidates = configured ? [configured] : CANDIDATE_PATHS;
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
    try {
      if (fs.statSync(absolute).isFile()) return absolute;
    } catch (_) {
      /* 继续尝试下一个候选路径 */
    }
  }
  return null;
}

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function runBinary(binary, args, input, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), spawnError: error });
      return;
    }

    const stdout = [];
    const stderr = [];
    let stderrBytes = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= STDERR_LIMIT_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    child.on("error", (error) => finish({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), spawnError: error }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));

    if (signal) {
      const abort = () => {
        try {
          child.kill();
        } catch (_) {
          /* 进程可能已退出 */
        }
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    // pngquant 可能先读完就退出，写入端出现 EPIPE 属正常，不能让它冒泡。
    child.stdin.on("error", () => {});
    child.stdin.end(input || undefined);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(new Error("请求体超过 64MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

/** 从 --verbose 输出里取回真实达成的画质：`mapped image to new colors...MSE=10.2 (Q=68)` */
function parseQuality(stderrText) {
  const match = stderrText.match(/\(Q=(\d+)\)/);
  return match ? Number(match[1]) : null;
}

/** 取回实际写入的调色板颜色数：`writing 256-color image to stdout` */
function parseColorCount(stderrText) {
  const match = stderrText.match(/(\d+)-color image/);
  return match ? Number(match[1]) : null;
}

const EXIT_REASONS = { 98: "larger", 99: "quality", 25: "no-conversion", 24: "no-quantization" };

export default function pngquantBridge(options = {}) {
  let root = process.cwd();
  let binary = null;
  let versionInfo = null;

  const refresh = (configRoot) => {
    if (configRoot) root = configRoot;
    binary = resolveBinary(root, options.binary);
    versionInfo = null;
  };

  /** 探测二进制版本，结果缓存到本次会话结束。 */
  const detectVersion = async () => {
    if (versionInfo) return versionInfo;
    const result = await runBinary(binary, ["--version"], null, null);
    if (result.code !== 0) return null;
    const text = `${result.stdout.toString("utf8")} ${result.stderr.toString("utf8")}`;
    const version = (text.match(/\d+\.\d+\.\d+/) || [""])[0];
    versionInfo = { version, raw: text.trim().split("\n")[0] };
    return versionInfo;
  };

  const handler = async (req, res, next) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch (_) {
      return next();
    }
    if (url.pathname !== HEALTH_PATH && url.pathname !== QUANTIZE_PATH) return next();

    try {
      if (url.pathname === HEALTH_PATH) {
        if (!binary) return sendJson(res, 503, { ok: false, error: "未找到 Packages/pngquant.exe", searched: CANDIDATE_PATHS });
        const info = await detectVersion();
        if (!info) return sendJson(res, 500, { ok: false, error: "pngquant.exe 无法执行，可能被安全软件拦截" });
        return sendJson(res, 200, {
          ok: true,
          engine: "pngquant",
          version: info.version,
          raw: info.raw,
          binary: path.relative(root, binary).split(path.sep).join("/"),
          features: { quality: true, speed: [1, 11], colors: [2, 256], posterize: [0, 4], ditherMode: "on-off", verboseQuality: true },
        });
      }

      // POST /api/pngquant
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        return res.end();
      }
      if (!binary) return sendJson(res, 503, { ok: false, error: "未找到 Packages/pngquant.exe" });

      const body = await readBody(req);
      if (!body.length) return sendJson(res, 400, { ok: false, error: "请求体为空" });

      const colors = toInt(url.searchParams.get("colors"), 256, 2, 256);
      const speed = toInt(url.searchParams.get("speed"), 4, 1, 11);
      const qualityMin = toInt(url.searchParams.get("qualityMin"), 0, 0, 100);
      const qualityMax = toInt(url.searchParams.get("qualityMax"), 100, 0, 100);
      const posterize = toInt(url.searchParams.get("posterize"), 0, 0, 4);
      const dither = url.searchParams.get("dither") !== "0";
      const verbose = url.searchParams.get("verbose") !== "0";

      const low = Math.min(qualityMin, qualityMax);
      const high = Math.max(qualityMin, qualityMax);

      const args = ["--force", "--speed", String(speed), "--quality", `${low}-${high}`, "--output", "-"];
      if (!dither) args.push("--nofs");
      if (posterize > 0) args.push("--posterize", String(posterize));
      if (verbose) args.push("--verbose");
      args.push(String(colors), "--", "-");

      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      const result = await runBinary(binary, args, body, controller.signal);
      const stderrText = result.stderr.toString("utf8");

      if (result.spawnError) {
        return sendJson(res, 500, { ok: false, error: `无法启动 pngquant：${result.spawnError.message}` });
      }

      // 只有退出码 0 的 stdout 才可信：99 / 98 同样会吐字节，但语义上属于"放弃"
      if (result.code === 0 && result.stdout.length) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", String(result.stdout.length));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Quant-Status", "ok");
        res.setHeader("X-Quant-Engine", "pngquant");
        res.setHeader("X-Input-Size", String(body.length));
        res.setHeader("X-Output-Size", String(result.stdout.length));
        const quality = parseQuality(stderrText);
        if (quality !== null) res.setHeader("X-Quant-Quality", String(quality));
        const used = parseColorCount(stderrText);
        if (used !== null) res.setHeader("X-Quant-Colors", String(used));
        return res.end(result.stdout);
      }

      const reason = EXIT_REASONS[result.code];
      if (reason) {
        // 对应桌面版的"回退到 Pillow"：保留上层已生成的无损 PNG
        res.statusCode = 200;
        res.setHeader("X-Quant-Status", "fallback");
        res.setHeader("X-Quant-Reason", reason);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", "0");
        return res.end();
      }

      return sendJson(res, 500, {
        ok: false,
        error: `pngquant 执行失败（退出码 ${result.code}）`,
        detail: stderrText.slice(0, 400),
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
    }
  };

  return {
    name: "piccave:pngquant-bridge",

    configResolved(config) {
      refresh(config.root);
    },

    configureServer(server) {
      refresh(server.config.root);
      server.middlewares.use(handler);
      if (binary) server.config.logger.info(`  ➜  pngquant bridge: ${path.relative(root, binary).split(path.sep).join("/")}`);
      else server.config.logger.warn("  pngquant.exe 未找到，浏览器将回退到 libimagequant WASM 量化");
    },

    configurePreviewServer(server) {
      refresh(server.config.root);
      server.middlewares.use(handler);
    },
  };
}
