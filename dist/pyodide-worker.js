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
  postProgress(id, 28, "正在处理图片");
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
  const resultProxy = pyodide.globals.get("gif_result");
  const result = resultProxy.toJs();
  resultProxy.destroy();
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
  postProgress(id, 20, "正在解码 GIF");
  await pyodide.runPythonAsync(`
from PIL import Image
import io, json

settings = json.loads(extract_settings)
fmt = settings["format"].upper()
quality = int(settings["quality"])
prefix = (settings.get("prefix") or "frame").strip() or "frame"
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
        results.append((f"{prefix}_{index + 1:0{digits}d}.{extension}", output.getvalue()))
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

function removeDir(pyodide, root, entries) {
  entries.forEach((name) => { try { pyodide.FS.unlink(`${root}/${name}`); } catch (_) {} });
  try { pyodide.FS.rmdir(root); } catch (_) {}
}

async function batchFile(id, buffer, settings) {
  const pyodide = await getRuntime();
  const root = `/tmp/batch_${id}`;
  try { pyodide.FS.mkdir(root); } catch (_) {}
  pyodide.FS.writeFile(`${root}/input.img`, new Uint8Array(buffer));
  pyodide.globals.set("job_root", root);
  pyodide.globals.set("job_settings", JSON.stringify(settings));
  postProgress(id, 20, "正在解码");
  await pyodide.runPythonAsync(`
from PIL import Image
import io, json

settings = json.loads(job_settings)
nodes = settings.get("nodes") or []
original = settings.get("originalName") or "image"

base, _, raw_ext = original.rpartition(".")
if not base:
    base, raw_ext = original, "png"
current_ext = (raw_ext or "png").lower().lstrip(".") or "png"

last_compress = None

def fit_inside(size, limit):
    w, h = size
    longest = max(w, h)
    if longest <= limit:
        return (w, h)
    ratio = float(limit) / float(longest)
    return (max(1, int(round(w * ratio))), max(1, int(round(h * ratio))))

def flatten_alpha(source):
    rgba = source.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.split()[3])
    return background

image = Image.open(f"{job_root}/input.img")
image.load()

for node in nodes:
    node_type = node.get("type")
    params = node.get("params") or {}
    if node_type == "convert":
        target = str(params.get("format") or "png").lower()
        if not params.get("keepResolution"):
            try:
                want_w = int(params.get("width") or 0)
                want_h = int(params.get("height") or 0)
            except (TypeError, ValueError):
                want_w, want_h = 0, 0
            if want_w > 0 and want_h > 0 and (want_w, want_h) != image.size:
                image = image.resize((want_w, want_h), Image.Resampling.LANCZOS)
        if target == "ico":
            image = image.resize(fit_inside(image.size, 256), Image.Resampling.LANCZOS)
        current_ext = target
    elif node_type == "compress":
        last_compress = params

max_colors = 0
try:
    jpg_quality = int(settings.get("jpgQuality") or 92)
except (TypeError, ValueError):
    jpg_quality = 92
if last_compress:
    try:
        max_colors = int(last_compress.get("maxColors") or 0)
    except (TypeError, ValueError):
        max_colors = 0
    try:
        jpg_quality = int(last_compress.get("quality") or jpg_quality)
    except (TypeError, ValueError):
        pass
jpg_quality = max(1, min(100, jpg_quality))
max_colors = max(0, min(256, max_colors))

aliases = {"jpeg": "jpg", "tif": "tiff"}
current_ext = aliases.get(current_ext, current_ext)
if current_ext not in ("png", "jpg", "webp", "bmp", "tiff", "tga", "ico"):
    current_ext = "png"

output = io.BytesIO()
needs_quantize = False

if current_ext == "png":
    if last_compress and max_colors >= 2:
        image.convert("RGBA").save(output, format="PNG", compress_level=1)
        needs_quantize = True
    else:
        work = image if image.mode in ("1", "L", "P", "RGB", "RGBA") else image.convert("RGBA")
        work.save(output, format="PNG", optimize=True)
elif current_ext == "jpg":
    work = image if image.mode == "RGB" else flatten_alpha(image)
    work.save(output, format="JPEG", quality=jpg_quality, optimize=True, subsampling=0)
elif current_ext == "webp":
    work = image if image.mode in ("RGB", "RGBA") else image.convert("RGBA")
    work.save(output, format="WEBP", quality=jpg_quality, method=4)
elif current_ext == "bmp":
    work = image if image.mode == "RGB" else flatten_alpha(image)
    work.save(output, format="BMP")
elif current_ext == "tiff":
    work = image if image.mode in ("1", "L", "P", "RGB", "RGBA", "CMYK") else image.convert("RGBA")
    work.save(output, format="TIFF")
elif current_ext == "tga":
    work = image if image.mode in ("L", "RGB", "RGBA", "P") else image.convert("RGBA")
    work.save(output, format="TGA")
elif current_ext == "ico":
    side = max(16, min(256, max(image.width, image.height)))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    thumb = image.convert("RGBA")
    if thumb.size != (side, side):
        thumb = thumb.resize(fit_inside(thumb.size, side), Image.Resampling.LANCZOS)
    canvas.paste(thumb, ((side - thumb.width) // 2, (side - thumb.height) // 2))
    canvas.save(output, format="ICO", sizes=[(side, side)])

batch_bytes = output.getvalue()
batch_meta = json.dumps({
    "extension": current_ext,
    "needsQuantize": needs_quantize,
    "width": image.width,
    "height": image.height,
})
`);
  postProgress(id, 62, "正在编码输出");
  const bytesProxy = pyodide.globals.get("batch_bytes");
  const view = bytesProxy.toJs();
  bytesProxy.destroy();
  const meta = JSON.parse(pyodide.globals.get("batch_meta"));
  const out = new Uint8Array(view).buffer;
  removeDir(pyodide, root, ["input.img"]);
  return { buffer: out, extension: meta.extension, needsQuantize: meta.needsQuantize, width: meta.width, height: meta.height };
}

/* 序列帧 → 精灵图。
   合成策略：先定画布总尺寸，再均分出 cols×rows 个等大格子，
   每帧 contain 缩放（保持比例）后精确居中贴入对应格子，保证播放时视觉中心不偏移。 */
async function pack(id, files, settings) {
  const pyodide = await getRuntime();
  const root = `/tmp/pack_${id}`;
  try { pyodide.FS.mkdir(root); } catch (_) {}
  postProgress(id, 8, "正在写入序列帧");
  files.forEach((file, index) => pyodide.FS.writeFile(`${root}/${index}.img`, new Uint8Array(file.buffer)));
  pyodide.globals.set("pack_root", root);
  pyodide.globals.set("pack_count", files.length);
  pyodide.globals.set("pack_settings", JSON.stringify(settings));
  postProgress(id, 26, "正在合成精灵图");
  await pyodide.runPythonAsync(`
from PIL import Image
import io, json, math

settings = json.loads(pack_settings)
count = int(pack_count)
cols = int(settings.get("cols") or 0)
rows = int(settings.get("rows") or 0)
canvas_w = int(settings.get("canvasW") or 0)
canvas_h = int(settings.get("canvasH") or 0)
fmt = (settings.get("format") or "png").lower()
quality = max(1, min(100, int(settings.get("quality") or 92)))

# 行列推算：指定了列就由列推行，反之亦然；都没给则取最接近的正方形排布
if cols and rows:
    if cols * rows < count:
        rows = math.ceil(count / cols)
elif cols:
    rows = math.ceil(count / cols)
elif rows:
    cols = math.ceil(count / rows)
else:
    cols = math.ceil(math.sqrt(count))
    rows = math.ceil(count / cols)

# 画布推算：未指定时按所有帧中的最大宽/高作为单格尺寸，再乘以行列
if not canvas_w or not canvas_h:
    max_w = 0
    max_h = 0
    for index in range(count):
        with Image.open(f"{pack_root}/{index}.img") as probe:
            max_w = max(max_w, probe.width)
            max_h = max(max_h, probe.height)
    if not canvas_w:
        canvas_w = max_w * cols
    if not canvas_h:
        canvas_h = max_h * rows

cell_w = max(1, canvas_w // cols)
cell_h = max(1, canvas_h // rows)

sheet = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))

for index in range(count):
    with Image.open(f"{pack_root}/{index}.img") as source:
        frame = source.convert("RGBA")
    src_w, src_h = frame.size
    scale = min(cell_w / src_w, cell_h / src_h)
    if abs(scale - 1.0) > 1e-6:
        frame = frame.resize(
            (max(1, int(round(src_w * scale))), max(1, int(round(src_h * scale)))),
            Image.Resampling.LANCZOS,
        )
    draw_w, draw_h = frame.size
    cell_x = (index % cols) * cell_w
    cell_y = (index // cols) * cell_h
    sheet.paste(
        frame,
        (cell_x + (cell_w - draw_w) // 2, cell_y + (cell_h - draw_h) // 2),
        mask=frame,
    )

output = io.BytesIO()
extension = fmt
if fmt in ("jpg", "jpeg"):
    flat = Image.new("RGB", sheet.size, (255, 255, 255))
    flat.paste(sheet, mask=sheet.split()[3])
    flat.save(output, format="JPEG", quality=quality, optimize=True, subsampling=0)
    extension = "jpg"
elif fmt == "webp":
    sheet.save(output, format="WEBP", quality=quality, method=4)
    extension = "webp"
elif fmt == "bmp":
    flat = Image.new("RGB", sheet.size, (255, 255, 255))
    flat.paste(sheet, mask=sheet.split()[3])
    flat.save(output, format="BMP")
    extension = "bmp"
elif fmt == "tiff":
    sheet.save(output, format="TIFF")
    extension = "tiff"
else:
    sheet.save(output, format="PNG", optimize=True)
    extension = "png"

pack_bytes = output.getvalue()
pack_meta = json.dumps({
    "extension": extension,
    "cols": cols,
    "rows": rows,
    "width": canvas_w,
    "height": canvas_h,
    "cellW": cell_w,
    "cellH": cell_h,
})
`);
  postProgress(id, 90, "正在返回合成结果");
  const bytesProxy = pyodide.globals.get("pack_bytes");
  const view = bytesProxy.toJs();
  bytesProxy.destroy();
  const meta = JSON.parse(pyodide.globals.get("pack_meta"));
  const out = new Uint8Array(view).buffer;
  cleanup(pyodide, root, files.length);
  return { buffer: out, ...meta };
}

/* 精灵图 → 序列帧。按 cols×rows 均匀切分，帧名 `前缀_序号`，序号从 0 起。
   格式为 JPG/BMP 时透明区域合成白底。 */
async function unpack(id, buffer, settings) {
  const pyodide = await getRuntime();
  const root = `/tmp/unpack_${id}`;
  try { pyodide.FS.mkdir(root); } catch (_) {}
  pyodide.FS.writeFile(`${root}/sheet.img`, new Uint8Array(buffer));
  pyodide.globals.set("unpack_root", root);
  pyodide.globals.set("unpack_settings", JSON.stringify(settings));
  postProgress(id, 20, "正在切分序列帧");
  await pyodide.runPythonAsync(`
from PIL import Image
import io, json

settings = json.loads(unpack_settings)
cols = max(1, int(settings.get("cols") or 1))
rows = max(1, int(settings.get("rows") or 1))
fmt = (settings.get("format") or "png").lower()
prefix = (settings.get("prefix") or "frame").strip() or "frame"
quality = max(1, min(100, int(settings.get("quality") or 92)))
out_w = int(settings.get("width") or 0)
out_h = int(settings.get("height") or 0)

with Image.open(f"{unpack_root}/sheet.img") as source:
    sheet = source.convert("RGBA")

img_w, img_h = sheet.size
frame_w = max(1, img_w // cols)
frame_h = max(1, img_h // rows)

total = cols * rows
digits = max(len(str(total)), 3)
results = []

for row in range(rows):
    for col in range(cols):
        index = row * cols + col
        frame = sheet.crop((
            col * frame_w,
            row * frame_h,
            col * frame_w + frame_w,
            row * frame_h + frame_h,
        ))
        if out_w and out_h:
            frame = frame.resize((out_w, out_h), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        if fmt in ("jpg", "jpeg"):
            flat = Image.new("RGB", frame.size, (255, 255, 255))
            flat.paste(frame, mask=frame.split()[3])
            flat.save(output, format="JPEG", quality=quality, optimize=True, subsampling=0)
            ext = "jpg"
        elif fmt == "bmp":
            flat = Image.new("RGB", frame.size, (255, 255, 255))
            flat.paste(frame, mask=frame.split()[3])
            flat.save(output, format="BMP")
            ext = "bmp"
        elif fmt == "webp":
            frame.save(output, format="WEBP", quality=quality, method=4)
            ext = "webp"
        elif fmt == "tiff":
            frame.save(output, format="TIFF")
            ext = "tiff"
        else:
            frame.save(output, format="PNG", optimize=True)
            ext = "png"
        results.append((f"{prefix}_{index:0{digits}d}.{ext}", output.getvalue()))

unpack_meta = json.dumps({
    "frame_count": total,
    "cols": cols,
    "rows": rows,
    "frameW": frame_w,
    "frameH": frame_h,
}, ensure_ascii=False)
`);
  postProgress(id, 90, "正在返回切片结果");
  const proxy = pyodide.globals.get("results");
  const values = proxy.toJs({ create_proxies: false });
  proxy.destroy();
  const files = values.map(([name, data]) => ({ name, buffer: new Uint8Array(data).buffer }));
  const meta = JSON.parse(pyodide.globals.get("unpack_meta"));
  removeDir(pyodide, root, ["sheet.img"]);
  return { files, ...meta };
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
    } else if (type === "batch-file") {
      const result = await batchFile(id, event.data.buffer, event.data.settings);
      self.postMessage({ type: "batch-result", id, ...result }, [result.buffer]);
    } else if (type === "pack") {
      const result = await pack(id, event.data.files, event.data.settings);
      self.postMessage({ type: "pack-result", id, ...result }, [result.buffer]);
    } else if (type === "unpack") {
      const result = await unpack(id, event.data.buffer, event.data.settings);
      self.postMessage({ type: "unpack-result", id, ...result }, result.files.map((file) => file.buffer));
    }
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || String(error), stack: error?.stack || "" });
  }
};
