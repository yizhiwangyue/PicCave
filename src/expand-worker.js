function postProgress(id, value, label) {
  self.postMessage({ type: "progress", id, value, label });
}

function edt1d(values) {
  const n = values.length;
  const distance = new Float64Array(n);
  const index = new Int32Array(n);
  const sites = [];
  for (let i = 0; i < n; i += 1) if (Number.isFinite(values[i])) sites.push(i);
  if (!sites.length) {
    distance.fill(Infinity);
    index.fill(-1);
    return { distance, index };
  }
  const v = new Int32Array(sites.length);
  const z = new Float64Array(sites.length + 1);
  let k = 0;
  v[0] = sites[0];
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let i = 1; i < sites.length; i += 1) {
    const q = sites[i];
    let p = v[k];
    let split = ((values[q] + q * q) - (values[p] + p * p)) / (2 * (q - p));
    while (k > 0 && split <= z[k]) {
      k -= 1;
      p = v[k];
      split = ((values[q] + q * q) - (values[p] + p * p)) / (2 * (q - p));
    }
    k += 1;
    v[k] = q;
    z[k] = split;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    const p = v[k];
    distance[q] = (q - p) * (q - p) + values[p];
    index[q] = p;
  }
  return { distance, index };
}

function nearestMap(mask, width, height) {
  const size = width * height;
  const columnDistance = new Float64Array(size);
  const columnY = new Int32Array(size);
  const values = new Float64Array(Math.max(width, height));
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) values[y] = mask[y * width + x] ? 0 : Infinity;
    const pass = edt1d(values.subarray(0, height));
    for (let y = 0; y < height; y += 1) {
      const offset = y * width + x;
      columnDistance[offset] = pass.distance[y];
      columnY[offset] = pass.index[y];
    }
  }
  const distance = new Float64Array(size);
  const nearestX = new Int32Array(size);
  const nearestY = new Int32Array(size);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) values[x] = columnDistance[row + x];
    const pass = edt1d(values.subarray(0, width));
    for (let x = 0; x < width; x += 1) {
      const offset = row + x;
      const sourceX = pass.index[x];
      distance[offset] = pass.distance[x];
      nearestX[offset] = sourceX;
      nearestY[offset] = sourceX >= 0 ? columnY[row + sourceX] : -1;
    }
  }
  return { distance, nearestX, nearestY };
}

function connectedComponents(mask, width, height, diagonal) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const directions = diagonal
    ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
    : [[0,-1],[-1,0],[1,0],[0,1]];
  let count = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    count += 1;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    labels[start] = count;
    while (head < tail) {
      const offset = queue[head++];
      const x = offset % width;
      const y = Math.floor(offset / width);
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !labels[next]) {
          labels[next] = count;
          queue[tail++] = next;
        }
      }
    }
  }
  return { labels, count };
}

function insetSeeds(valid, labels, count, width, height, iterations, diagonal) {
  let current = valid.slice();
  const last = new Int32Array(count + 1);
  last.fill(-1);
  const directions = diagonal
    ? [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]
    : [[0,-1],[-1,0],[1,0],[0,1]];
  for (let step = 0; step < iterations; step += 1) {
    for (let i = 0; i < current.length; i += 1) if (current[i]) last[labels[i]] = i;
    const next = new Uint8Array(current.length);
    for (let offset = 0; offset < current.length; offset += 1) {
      if (!current[offset]) continue;
      const x = offset % width;
      const y = Math.floor(offset / width);
      let keep = true;
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !current[ny * width + nx]) {
          keep = false;
          break;
        }
      }
      if (keep) next[offset] = 1;
    }
    current = next;
  }
  const present = new Uint8Array(count + 1);
  for (let i = 0; i < current.length; i += 1) if (current[i]) present[labels[i]] = 1;
  for (let label = 1; label <= count; label += 1) {
    if (!present[label]) {
      let seed = last[label];
      if (seed < 0) seed = labels.findIndex((value) => value === label);
      if (seed >= 0) current[seed] = 1;
    }
  }
  return current;
}

function gaussianKernel(radius) {
  const reach = Math.max(1, Math.ceil(radius * 3));
  const kernel = new Float32Array(reach * 2 + 1);
  let total = 0;
  for (let i = -reach; i <= reach; i += 1) {
    const value = Math.exp(-(i * i) / (2 * radius * radius));
    kernel[i + reach] = value;
    total += value;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= total;
  return { kernel, reach };
}

function blurPlane(source, width, height, radius, edgeMode = "nearest") {
  const { kernel, reach } = gaussianKernel(radius);
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -reach; k <= reach; k += 1) {
      const sx = edgeMode === "zero" ? x + k : Math.max(0, Math.min(width - 1, x + k));
      if (sx >= 0 && sx < width) sum += source[y * width + sx] * kernel[k + reach];
    }
    horizontal[y * width + x] = sum;
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -reach; k <= reach; k += 1) {
      const sy = edgeMode === "zero" ? y + k : Math.max(0, Math.min(height - 1, y + k));
      if (sy >= 0 && sy < height) sum += horizontal[sy * width + x] * kernel[k + reach];
    }
    output[y * width + x] = sum;
  }
  return output;
}

function blurExtension(rgba, extension, owners, islandCount, width, height, radius, isolate) {
  if (!isolate) {
    for (let channel = 0; channel < 3; channel += 1) {
      const plane = new Float32Array(width * height);
      for (let i = 0; i < plane.length; i += 1) plane[i] = rgba[i * 4 + channel];
      const blurred = blurPlane(plane, width, height, radius);
      for (let i = 0; i < plane.length; i += 1) if (extension[i]) rgba[i * 4 + channel] = Math.round(blurred[i]);
    }
    return;
  }
  const boxes = Array.from({ length: islandCount + 1 }, () => ({ x0: width, y0: height, x1: -1, y1: -1 }));
  for (let i = 0; i < owners.length; i += 1) {
    const label = owners[i];
    if (!label) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    const box = boxes[label];
    box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x);
    box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y);
  }
  const margin = Math.max(2, Math.ceil(radius * 3));
  for (let label = 1; label <= islandCount; label += 1) {
    const box = boxes[label];
    if (box.x1 < 0) continue;
    const x0 = Math.max(0, box.x0 - margin), y0 = Math.max(0, box.y0 - margin);
    const x1 = Math.min(width - 1, box.x1 + margin), y1 = Math.min(height - 1, box.y1 + margin);
    const w = x1 - x0 + 1, h = y1 - y0 + 1, size = w * h;
    const weight = new Float32Array(size);
    const planes = [new Float32Array(size), new Float32Array(size), new Float32Array(size)];
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const sourceIndex = (y0 + y) * width + x0 + x;
      const local = y * w + x;
      if (owners[sourceIndex] !== label) continue;
      weight[local] = 1;
      for (let c = 0; c < 3; c += 1) planes[c][local] = rgba[sourceIndex * 4 + c];
    }
    const blurredWeight = blurPlane(weight, w, h, radius, "zero");
    const blurredPlanes = planes.map((plane) => blurPlane(plane, w, h, radius, "zero"));
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const target = (y0 + y) * width + x0 + x;
      if (!extension[target] || owners[target] !== label) continue;
      const local = y * w + x;
      const divisor = Math.max(blurredWeight[local], 1e-6);
      for (let c = 0; c < 3; c += 1) rgba[target * 4 + c] = Math.round(blurredPlanes[c][local] / divisor);
    }
  }
}

async function encodePng(data, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function processImage(id, buffer, mime, options) {
  postProgress(id, 5, "正在读取透明图片");
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mime || "image/png" }));
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, width, height);
  const rgba = image.data;
  const valid = new Uint8Array(width * height);
  let maxAlpha = 0;
  const threshold = Math.max(1, Math.min(255, options.threshold));
  for (let i = 0; i < valid.length; i += 1) {
    const alpha = rgba[i * 4 + 3];
    maxAlpha = Math.max(maxAlpha, alpha);
    if (alpha >= threshold) valid[i] = 1;
  }
  let validCount = valid.reduce((sum, value) => sum + value, 0);
  if (!validCount && maxAlpha > 0) {
    for (let i = 0; i < valid.length; i += 1) if (rgba[i * 4 + 3] === maxAlpha) valid[i] = 1;
    validCount = valid.reduce((sum, value) => sum + value, 0);
  }
  if (!validCount || validCount === valid.length || options.distance <= 0) {
    const texture = await encodePng(new Uint8ClampedArray(rgba), width, height);
    return { width, height, texture, visible: texture, islands: validCount ? 1 : 0, filled: 0 };
  }

  postProgress(id, 22, "正在识别透明边界");
  const components = connectedComponents(valid, width, height, options.diagonal);
  const seeds = insetSeeds(valid, components.labels, components.count, width, height, Math.max(0, options.inset), options.diagonal);
  postProgress(id, 43, "正在计算最近颜色");
  const seedMap = nearestMap(seeds, width, height);
  const edgeMap = nearestMap(valid, width, height);
  const extension = new Uint8Array(valid.length);
  const owners = new Int32Array(valid.length);
  const limit = options.distance * options.distance;
  let filled = 0;
  for (let i = 0; i < valid.length; i += 1) {
    const extend = (!valid[i] && edgeMap.distance[i] <= limit) || (valid[i] && !seeds[i]);
    const sx = seedMap.nearestX[i], sy = seedMap.nearestY[i];
    if (sx >= 0 && sy >= 0) owners[i] = components.labels[sy * width + sx];
    if (!extend || sx < 0 || sy < 0) continue;
    extension[i] = 1;
    filled += 1;
    const source = (sy * width + sx) * 4;
    const target = i * 4;
    rgba[target] = rgba[source]; rgba[target + 1] = rgba[source + 1]; rgba[target + 2] = rgba[source + 2];
  }
  if (options.blur > 0 && filled) {
    postProgress(id, 69, "正在柔化扩边颜色");
    blurExtension(rgba, extension, owners, components.count, width, height, options.blur, options.isolate);
  }
  postProgress(id, 88, "正在生成预览");
  const textureData = new Uint8ClampedArray(rgba);
  const visibleData = new Uint8ClampedArray(rgba);
  for (let i = 0; i < extension.length; i += 1) if (extension[i]) visibleData[i * 4 + 3] = 255;
  const [texture, visible] = await Promise.all([encodePng(textureData, width, height), encodePng(visibleData, width, height)]);
  return { width, height, texture, visible, islands: components.count, filled };
}

self.onmessage = async (event) => {
  const { id, type } = event.data;
  if (type !== "process") return;
  try {
    const result = await processImage(id, event.data.buffer, event.data.mime, event.data.options);
    const textureBuffer = await result.texture.arrayBuffer();
    const visibleBuffer = result.visible === result.texture ? textureBuffer.slice(0) : await result.visible.arrayBuffer();
    self.postMessage({ type: "result", id, ...result, texture: undefined, visible: undefined, textureBuffer, visibleBuffer }, [textureBuffer, visibleBuffer]);
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || String(error) });
  }
};
