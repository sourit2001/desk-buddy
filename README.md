# Desk Buddy

轻量桌面陪伴应用，基于 Tauri 2 + React。支持图片桌宠和 MMD 桌宠，可在桌面上显示透明置顶的小伙伴，并提供互动、动作、状态特效和聊天能力。

完整使用步骤见 [使用说明书.md](./使用说明书.md)。

## 界面预览

截图请放在 `docs/images/` 目录，文件名按下面占位保持一致即可。

### 图片桌宠

图片桌宠适合 PNG/JPG/WebP 角色图、表情包、Q 版头像或多帧小动画。界面会围绕图片形象显示顶部互动按钮、状态条、对话气泡和表情特效；设置页只保留图片上传、自动抠图、多图帧动画等图片相关配置。

![图片桌宠界面](./docs/images/image-pet-window.png)

![图片桌宠设置](./docs/images/image-pet-settings.png)

### MMD 桌宠

MMD 桌宠适合 `.pmx` / `.pmd` 模型或包含模型贴图的 `.zip` 包。界面会渲染 3D 模型，并支持 VMD 动作、程序化轻动作、黄光/爱心/睡觉等状态特效；设置页只保留模型包、VMD 动作和 MMD 缩放等 MMD 相关配置。

![MMD 桌宠界面](./docs/images/mmd-pet-window.png)

![MMD 桌宠设置](./docs/images/mmd-pet-settings.png)

## 功能

- Windows/macOS 桌面应用骨架
- 透明、无边框、置顶桌宠窗口
- 配置窗口
- 多个桌宠配置，可分别命名和上传图片组
- 支持为不同桌宠同时打开多个独立窗口
- 上传图片时可自动抠图，适合纯色或近似纯色背景
- 通用动画：待机、点击、思考、说话、表情变化、多图帧动画
- 桌面空闲自由移动
- 轻量互动：右键菜单、亲密度/精力状态、闲置主动说话、独立性格和口头禅
- OpenAI-compatible Chat Completions API 配置
- 点击聊天、气泡显示回复

## 开发运行

```bash
npm install
npm run tauri:dev
```

## 构建

```bash
npm run tauri:build
```

macOS 会输出 `.app` / `.dmg`，Windows 会输出对应可执行包。跨平台产物需要在对应系统上构建。

## API 配置

在设置窗口里填写：

- Base URL，例如 `https://api.openai.com/v1`
- Model，例如 `gpt-4.1-mini`
- API Key
- 系统提示词

当前实现走 `/chat/completions`，适配 OpenAI-compatible 接口。

## 当前边界

- 自动抠图基于本地边缘背景识别，适合纯色/近似纯色背景；复杂照片背景后续可接模型或第三方 API。
- 配置保存在本机应用数据目录，浏览器调试时回退到 WebView localStorage；API Key 仅本机保存。
- 通用动效不依赖图片结构，不做骨骼、口型或 Live2D。
