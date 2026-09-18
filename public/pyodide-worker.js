const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
let runtimePromise;

function postProgress(id, value, label) {
  self.postMessage({ type: "progress", id, value, label });
}

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      importScripts(`${PYODIDE_BASE}pyodide.js`);
      const pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });
      await pyodide.loadPackage("pillow");
      return pyodide;
    })();
  }
  return runtimePromise;
}

async function encode(id, files, settings) {
  const pyodide = await getRuntime();
  const root = `/tmp/sequence_${id}`;
  try { pyodide.FS.mkdir(root); } catch (_) {}
  postProgress(id, 12, "正在写入序列帧");
  files.forEach((file, index) => pyodide.FS.writeFile(`${root}/${index}.img`, new Uint8Array(file.buffer)));
  pyodide.globals.set("job_root", root);
  pyodide.globals.set("job_count", files.length);
  pyodide.globals.set("job_settings", JSON.stringify(settings));
  postProgress(id, 28, "Pillow 正在处理图片");
  await pyodide.runPythonAsync(`
from PIL import Image, ImageOps
import io, json, os

settings = json.loads(job_settings)
start = max(0, int(settings["start"]) - 1)
end = min(int(job_count), int(settings["end"]))
crop = tuple(int(v) for v in settings["crop"])
target = (int(settings["width"]), int(settings["height"]))
colors = max(2, min(256, int(settings["colors"])))
alpha_strength = max(0, min(100, int(settings["ditherStrength"]))) / 100.0
frames = []

for index in range(start, end):
    with Image.open(f"{job_root}/{index}.img") as source:
        image = source.convert("RGBA")
    image = image.crop(crop)
    if image.size != target:
        image = image.resize(target, Image.Resampling.LANCZOS)

    alpha = image.getchannel("A")
    rgb = Image.new("RGB", image.size, (0, 0, 0))
    rgb.paste(image.convert("RGB"), mask=alpha)
    palette_colors = min(colors - 1, 255)
    paletted = rgb.quantize(colors=palette_colors, method=Image.Quantize.MEDIANCUT,
                            dither=Image.Dither.FLOYDSTEINBERG)
    palette = (paletted.getpalette() or [])[:765]
    palette += [0] * (765 - len(palette))
    palette += [0, 0, 0]
    paletted.putpalette(palette)

    hard_opaque = alpha.point(lambda value: 255 if value >= 128 else 0)
    if settings["transparencyMode"] == "dither" and alpha_strength > 0:
        effective_alpha = Image.blend(hard_opaque, alpha, alpha_strength)
        opaque = effective_alpha.convert("1", dither=Image.Dither.FLOYDSTEINBERG).convert("L")
    else:
        opaque = hard_opaque
    transparent = ImageOps.invert(opaque)
    paletted.paste(255, mask=transparent)
    paletted.info["transparency"] = 255
    frames.append(paletted)

if not frames:
    raise ValueError("所选帧范围为空")

duration = max(1, round(1000 / float(settings["fps"])))
output = io.BytesIO()
frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:],
               duration=duration, loop=int(settings["loop"]), transparency=255,
               disposal=2, background=255, optimize=False)
gif_result = output.getvalue()
`);
  postProgress(id, 92, "正在返回合成结果");
  const result = pyodide.globals.get("gif_result").toJs();
  const bytes = new Uint8Array(result);
  cleanup(pyodide, root, files.length);
  return bytes.buffer;
}

async function extract(id, buffer, settings) {
  const pyodide = await getRuntime();
  const root = `/tmp/extract_${id}`;
  try { pyodide.FS.mkdir(root); } catch (_) {}
  pyodide.FS.writeFile(`${root}/input.gif`, new Uint8Array(buffer));
  pyodide.globals.set("extract_root", root);
  pyodide.globals.set("extract_settings", JSON.stringify(settings));
  postProgress(id, 20, "Pillow 正在解码 GIF");
  await pyodide.runPythonAsync(`
from PIL import Image
import io, json

settings = json.loads(extract_settings)
fmt = settings["format"].upper()
quality = int(settings["quality"])
results = []
durations = []
with Image.open(f"{extract_root}/input.gif") as gif:
    source_name = getattr(gif, "filename", "input.gif")
    count = getattr(gif, "n_frames", 1)
    digits = max(4, len(str(count)))
    for index in range(count):
        gif.seek(index)
        durations.append(int(gif.info.get("duration", 0)))
        frame = gif.convert("RGBA")
        output = io.BytesIO()
        if fmt == "JPG":
            background = Image.new("RGB", frame.size, (255, 255, 255))
            background.paste(frame, mask=frame.getchannel("A"))
            background.save(output, format="JPEG", quality=quality, optimize=True)
            extension = "jpg"
        elif fmt == "WEBP":
            if settings["white"]:
                background = Image.new("RGB", frame.size, (255, 255, 255))
                background.paste(frame, mask=frame.getchannel("A"))
                frame = background
            frame.save(output, format="WEBP", quality=quality, method=4)
            extension = "webp"
        else:
            frame.save(output, format="PNG", optimize=False)
            extension = "png"
        results.append((f"frame_{index + 1:0{digits}d}.{extension}", output.getvalue()))
extract_meta = json.dumps({"frame_count": count, "durations_ms": durations}, ensure_ascii=False)
`);
  const proxy = pyodide.globals.get("results");
  const values = proxy.toJs({ create_proxies: false });
  proxy.destroy();
  const files = values.map(([name, data]) => {
    const bytes = new Uint8Array(data);
    return { name, buffer: bytes.buffer };
  });
  const timing = pyodide.globals.get("extract_meta");
  cleanup(pyodide, root, 0, true);
  return { files, timing };
}

function cleanup(pyodide, root, count, extraction = false) {
  try {
    if (extraction) pyodide.FS.unlink(`${root}/input.gif`);
    else for (let index = 0; index < count; index += 1) pyodide.FS.unlink(`${root}/${index}.img`);
    pyodide.FS.rmdir(root);
  } catch (_) {}
}

self.onmessage = async (event) => {
  const { type, id } = event.data;
  try {
    if (type === "init") {
      await getRuntime();
      self.postMessage({ type: "ready", id });
    } else if (type === "encode") {
      const buffer = await encode(id, event.data.files, event.data.settings);
      self.postMessage({ type: "encode-result", id, buffer }, [buffer]);
    } else if (type === "extract") {
      const result = await extract(id, event.data.buffer, event.data.settings);
      const transfers = result.files.map((file) => file.buffer);
      self.postMessage({ type: "extract-result", id, ...result }, transfers);
    }
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || String(error), stack: error?.stack || "" });
  }
};
