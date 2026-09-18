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
