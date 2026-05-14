# DeskPet

轻量桌宠 MVP，基于 Tauri 2 + React。

## 功能

- Windows/macOS 桌面应用骨架
- 透明、无边框、置顶桌宠窗口
- 配置窗口
- 上传透明 PNG 作为桌宠形象
- 通用动画：待机、点击、思考、说话
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

- 不做自动抠图，用户需要上传透明 PNG。
- 配置暂存在 WebView localStorage，API Key 仅本机保存；后续可换成系统 Keychain/Credential Manager。
- 通用动效不依赖图片结构，不做骨骼、口型或 Live2D。
