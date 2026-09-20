# 序列图 / GIF 转换实验室

这是桌面版转换工具的浏览器实验版本。图片只在当前浏览器标签页内处理，不会上传到服务器。

## 启动

```powershell
cd D:\Tools\序列转gif\web
npm install
npm run dev
```

打开终端显示的本地地址。首次使用图像转换时，浏览器需要联网加载 Pyodide 和 Pillow；后续处理均在本地完成。

## 处理架构

- 主线程：界面、序列播放、裁剪框和参数管理
- Web Worker：Pyodide + Pillow 合成 GIF、提取 GIF 帧
- Gifsicle WASM：对 Pillow 合成的 GIF 做无损或有损压缩
- JSZip：把提取的序列帧和可选的 `timing.json` 打包下载

合成结果和压缩结果都缓存在当前页面内。同一批文件和参数未变化时，压缩预览与最终导出会直接复用缓存。

## 图片批量转换模块

对应桌面版 `图片批量转换压缩/image_tool.py` 的三个模式，处理链为
`Pyodide + Pillow（解码/缩放/转码） → pngquant（PNG 色彩量化）`。

### pngquant 双通道设计

浏览器沙箱无法执行 Windows 可执行文件，所以「极致压缩」按环境自动选择通道：

| 运行方式 | 量化引擎 | 说明 |
| --- | --- | --- |
| `npm run dev` / `启动网页版.bat` | `Packages/pngquant.exe` | 真·pngquant 2.17.0，由 Vite 中间件以子进程调用 |
| `npm run build` 后的静态站点 | libimagequant WASM | pngquant 的量化内核编译版，无需 Node |

中间件源码：`vite-plugin-pngquant.js`，只挂在 dev / preview 上，接口为
`GET /api/pngquant/health` 与 `POST /api/pngquant`。前端调度逻辑在
`src/quantizer.js`，探测不到桥接时自动回退，两条通道对上层暴露同一套返回值。

**改动 `vite.config.js` 后必须重启本地服务**，否则桥接不会挂载。

两个引擎的参数差异：pngquant 的速度是 `1(最慢/最好) ~ 11(最快/最差)`，
抖动只有开/关（`--nofs`）没有百分比；WASM 内核速度范围 1–10，抖动支持 0–100% 连续值。
界面按原生 pngquant 的语义呈现。`Packages/NOTICE.txt` 记录了版本、许可与替换方式。

## 当前实验版限制

- 刷新或关闭页面后缓存会清空。
- 大量高分辨率帧会占用较多浏览器内存，建议分段处理。
- GIF 仅支持二值透明；“透明抖动”通过像素分布模拟半透明边缘。
- Pyodide 运行时目前从 jsDelivr CDN 加载，离线使用需要后续把运行时文件打包到本地。

## 部署到 GitHub Pages

将本文件夹中的源码上传到 GitHub 仓库根目录，然后在仓库的
`Settings > Pages > Build and deployment` 中选择 `GitHub Actions`。

推送到 `main` 分支后，`.github/workflows/deploy.yml` 会自动安装依赖、
执行 Vite 构建并发布 `dist`。`node_modules` 和 `dist` 不需要手动上传。

静态站点上「极致压缩」会自动走 libimagequant WASM 通道（`Packages/` 不会被打进
`dist`），功能等价、参数略有差异，属于预期行为而非故障。
