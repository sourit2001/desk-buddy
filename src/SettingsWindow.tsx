import { ChangeEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Eye, ImagePlus, MonitorUp, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { loadConfig, loadConfigAsync, saveConfig } from "./config";
import { isTauriRuntime } from "./tauriRuntime";
import { AppConfig } from "./types";

export function SettingsWindow() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  const petImages = config.petImages?.length ? config.petImages : config.petImageDataUrl ? [config.petImageDataUrl] : [];

  useEffect(() => {
    loadConfigAsync().then(setConfig).catch((error) => setSaveError(String(error)));
  }, []);

  useEffect(() => {
    if (previewIndex >= petImages.length) setPreviewIndex(0);
  }, [petImages.length, previewIndex]);

  useEffect(() => {
    if (!config.animation.enabled || !config.animation.framePlayback || petImages.length < 2) return;

    const interval = window.setInterval(() => {
      setPreviewIndex((current) => (current + 1) % petImages.length);
    }, Math.max(0.12, config.animation.imageSwitchSeconds) * 1000);

    return () => window.clearInterval(interval);
  }, [config.animation.enabled, config.animation.framePlayback, config.animation.imageSwitchSeconds, petImages.length]);

  function updateConfig(next: AppConfig) {
    setConfig(next);
    setSaved(false);
    setSaveError("");
  }

  function updateImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    Promise.all(
      files.map(
        (file) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.readAsDataURL(file);
          }),
      ),
    ).then((images) => {
      const nextImages = [...petImages, ...images];
      updateConfig({ ...config, petImageDataUrl: nextImages[0] ?? "", petImages: nextImages });
      event.target.value = "";
    });
  }

  function removeImage(index: number) {
    const nextImages = petImages.filter((_, imageIndex) => imageIndex !== index);
    updateConfig({ ...config, petImageDataUrl: nextImages[0] ?? "", petImages: nextImages });
  }

  async function persist() {
    try {
      await saveConfig(config);
      setSaved(true);
      setSaveError("");
      window.setTimeout(() => setSaved(false), 1600);
    } catch (error) {
      setSaved(false);
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  async function closeWindow() {
    if (!isTauriRuntime()) {
      window.location.href = "/";
      return;
    }
    await getCurrentWindow().hide();
  }

  async function showPetWindow() {
    if (!isTauriRuntime()) {
      window.location.href = "/";
      return;
    }
    await invoke("show_pet");
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div>
          <h1>桌宠设置</h1>
          <p>透明 PNG、窗口行为、通用动效和 OpenAI-compatible API。</p>
        </div>
        <button className="primary-button" type="button" onClick={persist}>
          <Save size={16} />
          {saved ? "已保存" : "保存"}
        </button>
      </header>
      {saveError && <div className="save-error">保存失败：{saveError}</div>}

      <section className="settings-grid">
        <div className="panel">
          <h2>
            <ImagePlus size={18} />
            形象
          </h2>
          <label className="field">
            <span>名称</span>
            <input value={config.petName} onChange={(event) => updateConfig({ ...config, petName: event.target.value })} />
          </label>
          <div className="image-toolbar">
            <label className="primary-button file-button">
              <ImagePlus size={16} />
              添加图片
              <input type="file" accept="image/png" multiple onChange={updateImages} />
            </label>
            {petImages.length > 0 && (
              <button
                className="ghost-button"
                type="button"
                onClick={() => updateConfig({ ...config, petImageDataUrl: "", petImages: [] })}
              >
                清空
              </button>
            )}
          </div>
          <div className="upload-box">
            {petImages[previewIndex] ? (
              <img key={`${previewIndex}-${petImages[previewIndex].length}`} src={petImages[previewIndex]} alt="预览" />
            ) : (
              <span>选择一个或多个透明 PNG</span>
            )}
          </div>
          {petImages.length > 0 && (
            <div className="image-strip" aria-label="已上传图片">
              {petImages.map((image, index) => (
                <div className="image-tile" key={`${image.length}-${index}`}>
                  <img src={image} alt={`桌宠图片 ${index + 1}`} />
                  <button className="tile-remove" type="button" title="删除" onClick={() => removeImage(index)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>
            <SlidersHorizontal size={18} />
            窗口与动画
          </h2>
          <div className="split-fields">
            <label className="field">
              <span>宽度</span>
              <input
                type="number"
                min={180}
                max={640}
                value={config.window.width}
                onChange={(event) =>
                  updateConfig({ ...config, window: { ...config.window, width: Number(event.target.value) } })
                }
              />
            </label>
            <label className="field">
              <span>高度</span>
              <input
                type="number"
                min={180}
                max={720}
                value={config.window.height}
                onChange={(event) =>
                  updateConfig({ ...config, window: { ...config.window, height: Number(event.target.value) } })
                }
              />
            </label>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.window.alwaysOnTop}
              onChange={(event) =>
                updateConfig({ ...config, window: { ...config.window, alwaysOnTop: event.target.checked } })
              }
            />
            置顶显示
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.window.roamEnabled}
              onChange={(event) =>
                updateConfig({ ...config, window: { ...config.window, roamEnabled: event.target.checked } })
              }
            />
            空闲时自由移动
          </label>
          <div className="split-fields">
            <label className="field">
              <span>移动间隔（秒）</span>
              <input
                type="number"
                min={4}
                max={60}
                step={1}
                value={config.window.roamIntervalSeconds}
                onChange={(event) =>
                  updateConfig({
                    ...config,
                    window: { ...config.window, roamIntervalSeconds: Number(event.target.value) },
                  })
                }
              />
            </label>
            <label className="field">
              <span>移动耗时（秒）</span>
              <input
                type="number"
                min={1.2}
                max={12}
                step={0.2}
                value={config.window.roamDurationSeconds}
                onChange={(event) =>
                  updateConfig({
                    ...config,
                    window: { ...config.window, roamDurationSeconds: Number(event.target.value) },
                  })
                }
              />
            </label>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.animation.enabled}
              onChange={(event) =>
                updateConfig({ ...config, animation: { ...config.animation, enabled: event.target.checked } })
              }
            />
            启用动画
          </label>
          <label className="field">
            <span>动画强度</span>
            <input
              type="range"
              min={0.2}
              max={2}
              step={0.1}
              value={config.animation.intensity}
              onChange={(event) =>
                updateConfig({ ...config, animation: { ...config.animation, intensity: Number(event.target.value) } })
              }
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.animation.framePlayback}
              onChange={(event) =>
                updateConfig({ ...config, animation: { ...config.animation, framePlayback: event.target.checked } })
              }
            />
            播放多图帧动画
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.animation.expressionEffects}
              onChange={(event) =>
                updateConfig({ ...config, animation: { ...config.animation, expressionEffects: event.target.checked } })
              }
            />
            启用表情变化
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.animation.randomImageSwitch}
              onChange={(event) =>
                updateConfig({ ...config, animation: { ...config.animation, randomImageSwitch: event.target.checked } })
              }
            />
            偶尔随机跳帧
          </label>
          <label className="field">
            <span>帧间隔（秒）</span>
            <input
              type="number"
              min={0.3}
              max={5}
              step={0.05}
              value={config.animation.imageSwitchSeconds}
              onChange={(event) =>
                updateConfig({
                  ...config,
                  animation: { ...config.animation, imageSwitchSeconds: Number(event.target.value) },
                })
              }
            />
          </label>
        </div>

        <div className="panel wide">
          <h2>
            <Eye size={18} />
            对话 API
          </h2>
          <label className="field">
            <span>Base URL</span>
            <input
              value={config.llm.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => updateConfig({ ...config, llm: { ...config.llm, baseUrl: event.target.value } })}
            />
          </label>
          <div className="split-fields">
            <label className="field">
              <span>Model</span>
              <input
                value={config.llm.model}
                placeholder="gpt-4.1-mini"
                onChange={(event) => updateConfig({ ...config, llm: { ...config.llm, model: event.target.value } })}
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={config.llm.apiKey}
                onChange={(event) => updateConfig({ ...config, llm: { ...config.llm, apiKey: event.target.value } })}
              />
            </label>
          </div>
          <label className="field">
            <span>系统提示词</span>
            <textarea
              rows={4}
              value={config.llm.systemPrompt}
              onChange={(event) => updateConfig({ ...config, llm: { ...config.llm, systemPrompt: event.target.value } })}
            />
          </label>
        </div>
      </section>

      <footer className="settings-footer">
        <div className="footer-actions">
          <button className="ghost-button" type="button" onClick={showPetWindow}>
            <MonitorUp size={16} />
            显示桌宠
          </button>
          <button className="ghost-button" type="button" onClick={closeWindow}>
            关闭
          </button>
        </div>
        <button className="primary-button" type="button" onClick={persist}>
          <Save size={16} />
          {saved ? "已保存" : "保存设置"}
        </button>
      </footer>
    </main>
  );
}
