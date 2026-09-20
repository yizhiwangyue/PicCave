import initImageQuant, {
  ImageQuantizer,
  decode_png_to_rgba,
  encode_palette_to_png,
} from "libimagequant-wasm/wasm/libimagequant_wasm.js";
import wasmUrl from "libimagequant-wasm/wasm/libimagequant_wasm_bg.wasm?url";

let readyPromise = null;

function ensureReady() {
  if (!readyPromise) {
    readyPromise = initImageQuant({ module_or_path: wasmUrl }).then(() => true);
  }
  return readyPromise;
}

function quantize(id, buffer, options) {
  const source = new Uint8Array(buffer);
  const decoded = decode_png_to_rgba(source);
  const rgba = decoded?.[0];
  const width = Number(decoded?.[1]) || 0;
  const height = Number(decoded?.[2]) || 0;
  if (!rgba || !width || !height) throw new Error("无法解码中间 PNG 数据");

  const maxColors = Math.max(2, Math.min(256, Math.round(options.maxColors || 256)));
  const speed = Math.max(1, Math.min(10, Math.round(options.speed || 3)));
  const qualityMin = Math.max(0, Math.min(100, Math.round(options.qualityMin ?? 0)));
  const qualityTarget = Math.max(qualityMin, Math.min(100, Math.round(options.qualityTarget ?? 100)));
  const dithering = Math.max(0, Math.min(1, Number(options.dithering ?? 1)));
  const posterization = Math.max(0, Math.min(4, Math.round(options.posterization || 0)));

  const quantizer = new ImageQuantizer();
  let result = null;
  let tooLow = false;
  try {
    quantizer.setMaxColors(maxColors);
    quantizer.setSpeed(speed);
    quantizer.setQuality(qualityMin, qualityTarget);
    if (posterization > 0) quantizer.setPosterization(posterization);
    try {
      result = quantizer.quantizeImage(rgba, width, height);
    } catch (error) {
      // libimagequant 在画质达不到 qualityMin 时抛出 QualityTooLow，
      // 对应 pngquant 的退出码 99：此时应放弃量化而不是判定失败。
      tooLow = true;
    }
  } finally {
    quantizer.free();
  }

  if (tooLow || !result) {
    return { buffer: new Uint8Array(source).buffer, fallback: true, quality: 0, paletteLength: 0, width, height };
  }

  try {
    const achieved = Number(result.getQuantizationQuality());
    if (Number.isFinite(achieved) && achieved * 100 < qualityMin) {
      return { buffer: new Uint8Array(source).buffer, fallback: true, quality: achieved, paletteLength: 0, width, height };
    }
    result.setDithering(dithering);
    const indices = result.getPaletteIndices(rgba, width, height);
    const palette = result.getPalette();
    const encoded = encode_palette_to_png(indices, palette, width, height);
    return {
      buffer: new Uint8Array(encoded).buffer,
      fallback: false,
      quality: Number.isFinite(achieved) ? achieved : 0,
      paletteLength: Number(result.getPaletteLength()) || 0,
      width,
      height,
    };
  } finally {
    result.free();
  }
}

self.onmessage = async (event) => {
  const { type, id } = event.data;
  try {
    if (type === "init") {
      await ensureReady();
      self.postMessage({ type: "ready", id });
    } else if (type === "quantize") {
      await ensureReady();
      const result = quantize(id, event.data.buffer, event.data.options || {});
      self.postMessage({ type: "quantize-result", id, ...result }, [result.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || String(error) });
  }
};
