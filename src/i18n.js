const STORAGE_KEY = "piccave-language";
const translatableAttributes = ["title", "aria-label", "placeholder", "alt"];

const english = new Map(Object.entries({
  "功能菜单": "Tools menu",
  "工具栏": "Tools",
  "图片批量转换": "Batch Image Converter",
  "序列图与 GIF 转换": "Image Sequence & GIF",
  "序列图与精灵图转换": "Image Sequence & Sprite Sheet",
  "Alpha 图批量转换": "Batch Alpha Converter",
  "透明图片扩边": "Transparent Image Padding",
  "AI 图片画质增强": "AI Image Enhancement",
  "本地工作区": "Local workspace",
  "批量转换格式、压缩图片与组合工作流": "Convert formats, compress images, and build workflows",
  "序列图合成与 GIF 帧提取": "Create GIFs and extract GIF frames",
  "合成精灵图或按网格切分序列帧": "Create sprite sheets or split them into frames",
  "从图片透明通道生成黑白 Alpha 图": "Create grayscale masks from image alpha channels",
  "向透明区域延伸边缘颜色": "Extend edge colors into transparent areas",
  "使用 AI 模型提升图片清晰度": "Enhance image clarity with an AI model",
  "建议使用 Edge 或 Chrome 浏览器": "Edge or Chrome is recommended",
  "中英文切换": "Chinese / English",
  "切换到英文": "Switch to English",
  "切换到中文": "Switch to Chinese",
  "切换到亮色主题": "Switch to light theme",
  "切换到暗色主题": "Switch to dark theme",
  "转换模块": "Conversion modes",
  "序列图 → GIF": "Sequence → GIF",
  "GIF → 序列图": "GIF → Sequence",
  "素材": "Source",
  "编辑": "Edit",
  "序列帧": "Sequence Frames",
  "待提取 GIF": "GIF Files",
  "待处理图片": "Images to Process",
  "待合成序列帧": "Frames to Combine",
  "待切分精灵图": "Sprite Sheets to Split",
  "待转换图片": "Images to Convert",
  "待增强图片": "Images to Enhance",
  "透明图片": "Transparent Images",
  "清空序列": "Clear sequence",
  "清空列表": "Clear list",
  "清空图片": "Clear images",
  "添加序列图或文件夹": "Add Sequence or Folder",
  "添加序列图片": "Add Sequence Images",
  "添加精灵图": "Add Sprite Sheets",
  "添加 GIF": "Add GIF Files",
  "添加图片或文件夹": "Add Images or Folder",
  "添加图片": "Add Images",
  "添加透明图片": "Add Transparent Images",
  "点击选择，或直接拖放到这里": "Click to browse or drop files here",
  "点击选择，或直接拖放": "Click to browse or drop files",
  "点击选择一张或多张精灵图，或直接拖放": "Choose one or more sprite sheets, or drop them here",
  "选择序列图片": "Choose Sequence Images",
  "选择序列文件夹": "Choose Sequence Folder",
  "选择图片": "Choose Images",
  "选择文件夹": "Choose Folder",
  "多选需要的图片": "Select multiple images",
  "可一次多选": "Multiple selection supported",
  "自动载入并按名称排序": "Load all and sort by name",
  "递归载入全部图片": "Load images from all subfolders",
  "尚未添加图片": "No images added",
  "尚未添加序列帧": "No sequence frames added",
  "尚未添加精灵图": "No sprite sheets added",
  "尚未添加 GIF": "No GIF files added",
  "尚未添加节点，处理时按原格式输出": "No steps added; files will keep their original format",
  "画面预览": "Preview",
  "拖动选区或四角调整裁剪": "Drag the selection or its corners to crop",
  "上一帧": "Previous frame",
  "下一帧": "Next frame",
  "播放": "Play",
  "暂停": "Pause",
  "预览 FPS": "Preview FPS",
  "还没有画面": "Nothing to preview",
  "从左侧添加序列图片": "Add sequence images from the left panel",
  "截取帧范围": "Frame Range",
  "从": "From",
  "到": "To",
  "当前帧": "Current",
  "裁剪区域": "Crop Area",
  "宽": "Width",
  "高": "Height",
  "宽度": "Width",
  "高度": "Height",
  "应用": "Apply",
  "已应用": "Applied",
  "重置": "Reset",
  "裁剪边界尺寸": "Crop Bounds",
  "输出分辨率": "Output Scale",
  "动画": "Animation",
  "GIF 帧率": "GIF Frame Rate",
  "循环方式": "Loop",
  "无限循环": "Loop Forever",
  "播放一次": "Play Once",
  "输出帧范围": "Output Frame Range",
  "未设置": "Not set",
  "色彩与透明": "Color & Transparency",
  "色彩数": "Colors",
  "透明处理": "Transparency",
  "透明抖动": "Alpha Dithering",
  "硬阈值": "Hard Threshold",
  "抖动强度": "Dither Strength",
  "压缩": "Compression",
  "压缩预设": "Compression Preset",
  "无损优化": "Lossless Optimization",
  "轻度压缩": "Light Compression",
  "均衡压缩": "Balanced Compression",
  "强力压缩": "Strong Compression",
  "等待添加序列图片": "Waiting for sequence images",
  "计算大小": "Calculate Size",
  "压缩预览": "Compression Preview",
  "导出 GIF": "Export GIF",
  "批量提取": "Batch Extract",
  "GIF 转序列图": "GIF to Image Sequence",
  "将每个 GIF 的每一帧解码为独立图片。多个 GIF 会按文件名分目录，打包进同一个 ZIP。": "Decode every GIF frame as a separate image. Multiple GIFs are placed in named folders inside one ZIP.",
  "图片格式": "Image Format",
  "输出质量": "Output Quality",
  "命名规则": "Naming",
  "统一序号命名": "Sequential Numbers",
  "跟随源文件名": "Use Source Name",
  "逐个自定义": "Customize Each",
  "保存每帧时间信息": "Save frame timing data",
  "透明区域使用白色": "Fill transparent areas with white",
  "等待添加 GIF": "Waiting for GIF files",
  "导出": "Export",
  "批量处理模式": "Batch processing modes",
  "转换格式": "Convert Format",
  "极致压缩": "Maximum Compression",
  "工作流": "Workflow",
  "尺寸与格式": "Size & Format",
  "保持原分辨率": "Keep Original Resolution",
  "目标宽": "Target Width",
  "目标高": "Target Height",
  "输出格式": "Output Format",
  "有损质量": "Lossy Quality",
  "功能说明：大幅减小体积，保留透明度，主要针对 PNG 或 JPG": "Reduce file size while preserving transparency, primarily for PNG and JPG",
  "PNG 质量": "PNG Quality",
  "JPG 质量": "JPG Quality",
  "（追求极致画质，可设置为 80-95；追求极致体积，可设置为 50-70）": "(80–95 for maximum quality; 50–70 for the smallest size)",
  "处理结果比原文件大时，保留原文件": "Keep the original when processing makes the file larger",
  "处理链": "Processing Steps",
  "格式转换": "Format Conversion",
  "清空节点": "Clear Steps",
  "保持原文件名": "Keep Original Filename",
  "顺序命名（前缀_序号）": "Sequential (prefix_number)",
  "前缀": "Prefix",
  "开始处理": "Start Processing",
  "精灵图处理模式": "Sprite sheet modes",
  "合成精灵图": "Create Sprite Sheet",
  "切分序列帧": "Split into Frames",
  "网格排布": "Grid Layout",
  "列数": "Columns",
  "行数": "Rows",
  "自动": "Auto",
  "自动排布（按图片数量取最接近的正方形）": "Auto layout (closest square for the image count)",
  "输出画布": "Output Canvas",
  "画布宽": "Canvas Width",
  "画布高": "Canvas Height",
  "快速选择": "Preset",
  "自定义": "Custom",
  "按最大帧自动推算": "Calculate from largest frame",
  "每帧按比例缩小到不超过格子后居中放置，尺寸不一致时中心依然对齐。": "Each frame is scaled to fit its cell and centered, keeping different frame sizes aligned.",
  "输出": "Output",
  "PNG（保留透明）": "PNG (Keep Transparency)",
  "JPG（白色背景）": "JPG (White Background)",
  "逐张参数设置": "Per-image Settings",
  "默认参数 · 添加精灵图后自动套用": "Default settings · applied to new sprite sheets",
  "尚未添加精灵图：这里的设置会作为新增素材的初始值": "No sprite sheets added. These settings will be used for new files.",
  "帧宽": "Frame Width",
  "帧高": "Frame Height",
  "前缀名": "Prefix",
  "等待添加素材": "Waiting for source images",
  "等待添加序列帧": "Waiting for sequence frames",
  "等待添加精灵图": "Waiting for sprite sheets",
  "效果预览": "Preview",
  "Alpha 图": "Alpha Mask",
  "原图": "Original",
  "还没有可预览的图片": "No image to preview",
  "从左侧添加图片后在此查看效果": "Add images from the left panel to preview them here",
  "输出尺寸": "Output Size",
  "保持原尺寸": "Keep Original Size",
  "黑白方向与格式": "Mask Direction & Format",
  "黑白方向": "Mask Direction",
  "不透明区域为白": "Opaque Areas White",
  "透明区域为白": "Transparent Areas White",
  "原名 + 后缀": "Original Name + Suffix",
  "后缀": "Suffix",
  "开始转换": "Start Conversion",
  "还没有转换结果": "No converted result",
  "点击「开始转换」后在此查看 Alpha 图": "Click “Start Conversion” to preview the alpha mask",
  "无法显示这张图片": "Unable to display this image",
  "该格式可能不受支持": "This format may not be supported",
  "原图预览": "Original image preview",
  "增强后": "Enhanced",
  "增强结果预览": "Enhanced result preview",
  "等待开始增强": "Waiting to enhance",
  "AI 处理": "AI Processing",
  "运行引擎": "Engine",
  "分块大小": "Tile Size",
  "128（低内存）": "128 (Low Memory)",
  "256（推荐）": "256 (Recommended)",
  "512（速度优先）": "512 (Faster)",
  "正在加载 AI 模型。": "Loading AI model.",
  "导出设置": "Export Settings",
  "输出倍率": "Output Scale",
  "4 倍": "4×",
  "2 倍": "2×",
  "开始增强": "Enhance",
  "导出图片": "Export Images",
  "扩边后": "Padded",
  "扩边结果预览": "Padded result preview",
  "等待处理": "Waiting to process",
  "扩边参数": "Padding Settings",
  "扩边距离": "Padding Distance",
  "Alpha 阈值": "Alpha Threshold",
  "边缘内缩": "Edge Inset",
  "模糊半径": "Blur Radius",
  "处理方式": "Processing Options",
  "隔离相邻 UV 岛": "Isolate Adjacent UV Islands",
  "连接对角像素": "Connect Diagonal Pixels",
  "预览透明扩边": "Show Padding in Preview",
  "导出显示扩边": "Include Padding in Export",
  "等待添加透明图片": "Waiting for transparent images",
  "重新处理": "Process Again",
  "导出 PNG": "Export PNG",
  "功能已就绪": "Ready",
  "请选择": "Select",
  "选项": "Options",
  "选择选项": "Select an option",
  "上移": "Move up",
  "下移": "Move down",
  "删除": "Delete",
  "失败": "Failed",
  "保留原图": "Original kept",
  "数值必须是正整数": "Value must be a positive integer",
  "没有找到可用的图片": "No supported images found",
  "没有找到可用的序列图片": "No supported sequence images found",
  "这些图片已在列表中": "These images are already in the list",
  "这些 GIF 已在列表中": "These GIF files are already in the list",
  "请选择 GIF 文件": "Please choose GIF files",
  "请选择 PNG、JPG、WebP 或 BMP 图片": "Please choose PNG, JPG, WebP, or BMP images",
  "请选择 PNG、WebP、TIFF 或 TGA 图片": "Please choose PNG, WebP, TIFF, or TGA images",
  "没有新增可解码图片，重复图片不会再次添加": "No new decodable images; duplicates were skipped",
  "已清空列表": "List cleared",
  "已清空素材": "Source images cleared",
  "已清空 GIF 列表": "GIF list cleared",
  "已清空 AI 增强素材": "AI enhancement images cleared",
  "已清空透明图片": "Transparent images cleared",
  "正在打包 ZIP": "Creating ZIP",
  "正在转换": "Converting",
  "正在合成精灵图": "Creating sprite sheet",
  "正在切分序列帧": "Splitting frames",
  "正在生成导出图片": "Generating export image",
  "正在生成增强图片": "Generating enhanced image",
  "正在读取透明图片": "Reading transparent image",
  "正在识别透明边界": "Detecting transparent edges",
  "正在计算最近颜色": "Calculating nearest colors",
  "正在柔化扩边颜色": "Smoothing padded colors",
  "正在生成预览": "Generating preview",
  "正在计算扩边区域": "Calculating padded area",
  "正在准备透明图片扩边": "Preparing transparent image padding",
  "正在加载 AI 模型": "Loading AI model",
  "正在加载运行组件": "Loading runtime components",
  "正在加载运行组件（已缓存）": "Loading runtime components (cached)",
  "正在从本地读取 AI 模型": "Loading AI model locally",
  "AI 模型已加载": "AI model loaded",
  "正在使用 AI 模型增强图片": "Enhancing images with AI",
  "正在等待 AI 模型加载完成": "Waiting for the AI model to load",
  "AI 增强完成": "AI enhancement complete",
  "增强图片已导出": "Enhanced image exported",
  "分块大小已改变，请重新增强": "Tile size changed; run enhancement again",
  "处理失败，请调整分块后重试": "Processing failed; adjust the tile size and retry",
  "参数已改动，请重新转换": "Settings changed; convert again",
  "参数已改变，正在等待重新处理": "Settings changed; waiting to process again",
  "还没有可导出的结果": "No result to export",
  "请填写目标宽和高，或勾选保持原尺寸": "Enter a target width and height, or keep the original size",
  "目标尺寸过大，单边不要超过 16384": "Target size is too large; each side must be 16384 or less",
  "画布宽和高需同时填写，或同时留空": "Enter both canvas dimensions or leave both empty",
  "帧宽和帧高需同时填写，或同时留空": "Enter both frame dimensions or leave both empty",
  "合成失败，请检查素材后重试": "Creation failed; check the source images and retry",
  "切分失败，请检查参数后重试": "Splitting failed; check the settings and retry",
  "等待添加图片": "Waiting for images"
}));

const chinese = new Map([...english].map(([zh, en]) => [en, zh]));
const textRecords = new WeakMap();
const attributeRecords = new WeakMap();
let currentLanguage = "zh";
let observer = null;

const dynamicPatterns = [
  [/^(\d+) 张$/, "$1 images"],
  [/^(\d+) 帧$/, "$1 frames"],
  [/^(\d+) 个$/, "$1 files"],
  [/^已添加 (\d+) 张图片$/, "Added $1 images"],
  [/^已添加 (\d+) 张精灵图$/, "Added $1 sprite sheets"],
  [/^已添加 (\d+) 个 GIF$/, "Added $1 GIF files"],
  [/^已添加 (\d+) 张图片，共 (\d+) 张$/, "Added $1 images, $2 total"],
  [/^已载入 (\d+) 张图片$/, "Loaded $1 images"],
  [/^(\d+) 张待处理$/, "$1 images ready"],
  [/^全部 (\d+) 张处理失败$/, "All $1 images failed"],
  [/^已导出 (\d+) 张$/, "Exported $1 images"],
  [/^已导出 (\d+) 张蒙版 · ZIP (.+)$/, "Exported $1 masks · ZIP $2"],
  [/^转换完成：(\d+) 张$/, "Converted $1 images"],
  [/^正在转换（(\d+)\/(\d+)）$/, "Converting ($1/$2)"],
  [/^正在切分序列帧（(\d+)\/(\d+)）$/, "Splitting frames ($1/$2)"],
  [/^序列帧已导出：(\d+) 张$/, "Exported $1 frames"],
  [/^(\d+) - (\d+)（共 (\d+) 帧）$/, "$1–$2 ($3 frames)"],
  [/^(\d+) 帧 · 原始尺寸 (.+)$/, "$1 frames · Original size $2"],
  [/^(\d+) 个 GIF · (\d+) 帧 · (.+)$/, "$1 GIF files · $2 frames · $3"],
  [/^已选择 (\d+) 张，点击「开始转换」提取 Alpha 图$/, "$1 images selected · Click “Start Conversion” to extract alpha masks"],
  [/^处理完成 · (\d+) 个区域 · 扩边 (.+) 像素$/, "Complete · $1 regions · $2 pixels padded"],
  [/^第 (\d+) 张$/, "Image $1"],
];

const fragments = [
  ["正在加载运行组件", "Loading runtime components"],
  ["正在加载 AI 模型", "Loading AI model"],
  ["（已缓存）", " (cached)"],
  ["当前使用 ", "Using "],
  [" 进行模型推理。", " for model inference."],
  ["正在初始化，首次加载约需数秒", "Initializing; the first load may take a few seconds"],
  ["初始化失败，请刷新页面重试", "Initialization failed; refresh the page to retry"],
  ["序列已载入，可播放或拖动裁剪框", "Sequence loaded; play it or drag the crop box"],
  ["准备序列帧", "Preparing sequence frames"],
  ["合成完成：", "Created: "],
  ["压缩完成：", "Compressed: "],
  ["压缩失败，未生成输出文件", "Compression failed; no output was created"],
  ["GIF 已生成并下载：", "GIF created and downloaded: "],
  ["处理出现错误：", "Processing error: "],
  ["处理失败：", "Processing failed: "],
  ["读取图片失败：", "Could not read image: "],
  ["导出失败：", "Export failed: "],
  ["转换失败：", "Conversion failed: "],
  ["增强失败：", "Enhancement failed: "],
  ["AI 增强失败：", "AI enhancement failed: "],
  ["AI 模型加载失败：", "AI model failed to load: "],
  ["透明图片扩边失败：", "Image padding failed: "],
  ["合成失败：", "Creation failed: "],
  ["切分失败：", "Splitting failed: "],
  ["已选择 ", "Selected "],
  ["已添加 ", "Added "],
  ["已导出 ", "Exported "],
  ["正在处理 ", "Processing "],
  ["处理中：", "Processing: "],
  ["批量处理完成：成功 ", "Batch complete: "],
  ["成功 ", "Succeeded "],
  ["失败 ", "Failed "],
  ["减少 ", "Reduced "],
  ["增加 ", "Increased "],
  ["已压缩 ", "Compressed "],
  ["保留原图 ", "Original kept for "],
  [" 张图片", " images"],
  [" 张精灵图", " sprite sheets"],
  [" 张蒙版", " masks"],
  [" 张已转换", " converted"],
  [" 张", " images"],
  [" 帧", " frames"],
  [" 个 GIF", " GIF files"],
  [" 个区域", " regions"],
  ["原始尺寸", "Original size"],
  ["参数改变后需要重新计算", "Recalculate after changing settings"],
  ["可继续压缩预览", "Ready for compression preview"],
  ["合成结果", "Created GIF"],
  ["合成 ", "Created "],
  ["压缩 ", "Compressed "],
];

function translateCore(value) {
  if (!value || currentLanguage === "zh") return value;
  const exact = english.get(value);
  if (exact) return exact;
  for (const [pattern, replacement] of dynamicPatterns) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  let result = value;
  fragments.forEach(([from, to]) => { result = result.replaceAll(from, to); });
  return result;
}

function sourceChinese(value) {
  return chinese.get(value) || value;
}

function splitWhitespace(value) {
  const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return { before: match?.[1] || "", core: match?.[2] || "", after: match?.[3] || "" };
}

function translateTextNode(node) {
  const current = node.nodeValue || "";
  let record = textRecords.get(node);
  if (!record || current !== record.lastApplied) {
    const parts = splitWhitespace(current);
    record = { ...parts, core: sourceChinese(parts.core), lastApplied: current };
    textRecords.set(node, record);
  }
  const output = `${record.before}${translateCore(record.core)}${record.after}`;
  record.lastApplied = output;
  if (current !== output) node.nodeValue = output;
}

function translateAttribute(element, name) {
  if (!element.hasAttribute(name)) return;
  let records = attributeRecords.get(element);
  if (!records) { records = new Map(); attributeRecords.set(element, records); }
  const current = element.getAttribute(name) || "";
  let record = records.get(name);
  if (!record || current !== record.lastApplied) {
    record = { source: sourceChinese(current), lastApplied: current };
    records.set(name, record);
  }
  const output = translateCore(record.source);
  record.lastApplied = output;
  if (current !== output) element.setAttribute(name, output);
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root); return; }
  if (!(root instanceof Element) && root !== document) return;
  if (root instanceof Element) translatableAttributes.forEach((name) => translateAttribute(root, name));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
    else translatableAttributes.forEach((name) => translateAttribute(node, name));
    node = walker.nextNode();
  }
}

function updateButton(button) {
  if (!button) return;
  const label = currentLanguage === "zh" ? "切换到英文" : "Switch to Chinese";
  button.setAttribute("aria-label", label);
  button.title = label;
}

export function setLanguage(language, button, persist = true) {
  currentLanguage = language === "en" ? "en" : "zh";
  document.documentElement.lang = currentLanguage === "en" ? "en" : "zh-CN";
  document.documentElement.dataset.language = currentLanguage;
  translateTree(document.body);
  updateButton(button);
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, currentLanguage); } catch { /* 当前页面仍可正常切换。 */ }
  }
  document.dispatchEvent(new CustomEvent("piccave:languagechange", { detail: { language: currentLanguage } }));
}

export function initI18n(button) {
  const initial = document.documentElement.dataset.language === "en" ? "en" : "zh";
  setLanguage(initial, button, false);
  button?.addEventListener("click", () => setLanguage(currentLanguage === "zh" ? "en" : "zh", button));

  observer = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === "characterData") translateTextNode(record.target);
      record.addedNodes?.forEach((node) => translateTree(node));
      if (record.type === "attributes") translateAttribute(record.target, record.attributeName);
    });
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: translatableAttributes,
  });
}
