import { ChangeEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CopyPlus, Eye, ImagePlus, MonitorUp, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { loadConfig, loadConfigAsync, saveConfig } from "./config";
import { readFileAsDataUrl, removeImageBackground } from "./imageCutout";
import { isTauriRuntime } from "./tauriRuntime";
import { AppConfig, DesktopPet, getActivePet, PetDisplayMode, PetPersonality, RoamMode } from "./types";

const personalityOptions: Array<{ value: PetPersonality; label: string }> = [
  { value: "gentle", label: "温和" },
  { value: "lively", label: "活泼" },
  { value: "cool", label: "酷酷的" },
  { value: "clingy", label: "黏人" },
];

const displayModeOptions: Array<{ value: PetDisplayMode; label: string }> = [
  { value: "image", label: "图片桌宠" },
  { value: "mmd", label: "MMD 模型" },
];

type MmdAsset = {
  path: string;
  fileName?: string;
  file_name?: string;
};

function getMmdAssetFileName(asset: MmdAsset, fallback: string) {
  return asset.fileName || asset.file_name || fallback;
}

const roamModeOptions: Array<{ value: RoamMode; label: string }> = [
  { value: "edges", label: "屏幕四边" },
  { value: "topBottom", label: "上下边缘" },
  { value: "leftRight", label: "左右边缘" },
  { value: "left", label: "左边缘" },
  { value: "right", label: "右边缘" },
  { value: "middle", label: "屏幕中间" },
  { value: "anywhere", label: "全屏随机" },
];

export function SettingsWindow() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [processingImages, setProcessingImages] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const activePet = getActivePet(config);
  const petImages = activePet.images;

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

  function updateConfigAndPersist(next: AppConfig) {
    updateConfig(next);
    saveConfig(next)
      .then(() => {
        setSaved(true);
        setSaveError("");
        window.setTimeout(() => setSaved(false), 1600);
      })
      .catch((error) => {
        setSaved(false);
        setSaveError(error instanceof Error ? error.message : String(error));
      });
  }

  function syncActivePet(nextConfig: AppConfig, pet: DesktopPet): AppConfig {
    return {
      ...nextConfig,
      activePetId: pet.id,
      petName: pet.name,
      petImages: pet.images,
      petImageDataUrl: pet.images[0] ?? "",
    };
  }

  function updatePet(nextPet: DesktopPet) {
    const nextPets = config.pets.map((pet) => (pet.id === nextPet.id ? nextPet : pet));
    updateConfig(syncActivePet({ ...config, pets: nextPets }, nextPet));
  }

  function updatePetAndPersist(nextPet: DesktopPet) {
    const nextPets = config.pets.map((pet) => (pet.id === nextPet.id ? nextPet : pet));
    updateConfigAndPersist(syncActivePet({ ...config, pets: nextPets }, nextPet));
  }

  function selectPet(petId: string) {
    const nextPet = config.pets.find((pet) => pet.id === petId);
    if (nextPet) updateConfig(syncActivePet(config, nextPet));
    setPreviewIndex(0);
  }

  function createPet() {
    const nextPet: DesktopPet = {
      id: `pet-${Date.now()}`,
      name: `桌宠 ${config.pets.length + 1}`,
      images: [],
      displayMode: "image",
      mmdModelDataUrl: "",
      mmdModelPath: "",
      mmdModelName: "",
      mmdMotionDataUrl: "",
      mmdMotionPath: "",
      mmdMotionName: "",
      mmdMaterialMode: "texture",
      mmdScale: 0.5,
      personality: "gentle",
      catchphrase: "",
    };
    updateConfig(syncActivePet({ ...config, pets: [...config.pets, nextPet] }, nextPet));
    setPreviewIndex(0);
  }

  function deleteActivePet() {
    if (config.pets.length <= 1) return;

    const activeIndex = config.pets.findIndex((pet) => pet.id === activePet.id);
    const nextPets = config.pets.filter((pet) => pet.id !== activePet.id);
    const nextPet = nextPets[Math.max(0, activeIndex - 1)] ?? nextPets[0];
    updateConfig(syncActivePet({ ...config, pets: nextPets }, nextPet));
    setPreviewIndex(0);
  }

  async function updateImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    setProcessingImages(true);
    setSaveError("");

    try {
      const images = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          if (!config.imageProcessing.removeBackground) return dataUrl;
          return removeImageBackground(dataUrl, config.imageProcessing.backgroundTolerance);
        }),
      );
      const nextImages = [...petImages, ...images];
      updatePet({ ...activePet, images: nextImages });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setProcessingImages(false);
      event.target.value = "";
    }
  }

  function removeImage(index: number) {
    const nextImages = petImages.filter((_, imageIndex) => imageIndex !== index);
    updatePet({ ...activePet, images: nextImages });
  }

  async function updateMmdModel(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (isTauriRuntime()) {
        const asset = await invoke<MmdAsset>("save_mmd_asset", { fileName: file.name, dataUrl });
        updatePetAndPersist({
          ...activePet,
          displayMode: "mmd",
          mmdModelDataUrl: "",
          mmdModelPath: asset.path,
          mmdModelName: getMmdAssetFileName(asset, file.name),
        });
      } else {
        updatePetAndPersist({ ...activePet, displayMode: "mmd", mmdModelDataUrl: dataUrl, mmdModelPath: "", mmdModelName: file.name });
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      event.target.value = "";
    }
  }

  async function updateMmdMotion(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      if (!file.name.toLowerCase().endsWith(".vmd")) {
        throw new Error("动作文件请选择解压后的 .vmd，不要直接选择 zip。camera.vmd/カメラ.vmd 是镜头动作，通常不适合桌宠。");
      }
      const dataUrl = await readFileAsDataUrl(file);
      if (isTauriRuntime()) {
        const asset = await invoke<MmdAsset>("save_mmd_asset", { fileName: file.name, dataUrl });
        updatePetAndPersist({
          ...activePet,
          displayMode: "mmd",
          mmdMotionDataUrl: "",
          mmdMotionPath: asset.path,
          mmdMotionName: getMmdAssetFileName(asset, file.name),
        });
      } else {
        updatePetAndPersist({ ...activePet, displayMode: "mmd", mmdMotionDataUrl: dataUrl, mmdMotionPath: "", mmdMotionName: file.name });
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      event.target.value = "";
    }
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

  async function openNewInstance() {
    if (!isTauriRuntime()) {
      window.open("/", "_blank");
      return;
    }
    await invoke("open_new_instance");
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div>
          <h1>Desk Buddy 设置</h1>
          <p>desk-buddy 支持图片桌宠、MMD 模型、窗口行为、通用动效和 OpenAI-compatible API。</p>
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
          <div className="pet-manager">
            <div className="pet-list" aria-label="桌宠列表">
              {config.pets.map((pet) => (
                <button
                  className={`pet-tab ${pet.id === activePet.id ? "active" : ""}`}
                  type="button"
                  key={pet.id}
                  onClick={() => selectPet(pet.id)}
                >
                  <span>{pet.name}</span>
                  <small>{pet.displayMode === "mmd" ? pet.mmdModelName || "MMD" : `${pet.images.length} 张`}</small>
                </button>
              ))}
            </div>
            <div className="pet-manager-actions">
              <button className="ghost-button compact" type="button" onClick={createPet}>
                <Plus size={15} />
                新增
              </button>
              <button className="ghost-button compact" type="button" onClick={openNewInstance}>
                <CopyPlus size={15} />
                打开新程序
              </button>
              <button className="ghost-button compact danger-text" type="button" onClick={deleteActivePet} disabled={config.pets.length <= 1}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
            <small className="pet-manager-hint">当前选择：{activePet.name}</small>
          </div>
          <label className="field">
            <span>当前宠物名称</span>
            <input value={activePet.name} onChange={(event) => updatePet({ ...activePet, name: event.target.value })} />
          </label>
          <div className="split-fields">
            <label className="field">
              <span>性格</span>
              <select
                value={activePet.personality}
                onChange={(event) => updatePet({ ...activePet, personality: event.target.value as PetPersonality })}
              >
                {personalityOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>口头禅</span>
              <input
                value={activePet.catchphrase}
                placeholder="可选"
                onChange={(event) => updatePet({ ...activePet, catchphrase: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>显示模式</span>
            <select
              value={activePet.displayMode}
              onChange={(event) => {
                const displayMode = event.target.value as PetDisplayMode;
                updatePetAndPersist({
                  ...activePet,
                  displayMode,
                  mmdMaterialMode: "texture",
                });
              }}
            >
              {displayModeOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {activePet.displayMode === "mmd" && (
            <div className="mmd-upload-panel">
              <div className="image-toolbar">
                <label className="primary-button file-button">
                  <ImagePlus size={16} />
                  选择模型包
                  <input type="file" accept=".zip,.pmx,.pmd" onChange={updateMmdModel} />
                </label>
                <label className="ghost-button file-button">
                  <ImagePlus size={16} />
                  选择动作 .vmd
                  <input type="file" accept=".vmd" onChange={updateMmdMotion} />
                </label>
              </div>
              <div className="mmd-file-list">
                <span>模型：{activePet.mmdModelName || "未选择，先显示 3D 预览"}</span>
                <span>动作：{activePet.mmdMotionName || "未选择，将使用程序化轻动作"}</span>
                <span>提示：先解压动作包，再选择角色动作 .vmd；不要选择 zip 或 camera.vmd。</span>
              </div>
              <label className="field">
                <span>MMD 缩放：{activePet.mmdScale.toFixed(2)}x</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.8}
                  step={0.05}
                  value={activePet.mmdScale}
                  onChange={(event) => updatePetAndPersist({ ...activePet, mmdScale: Number(event.target.value) })}
                />
              </label>
              {(activePet.mmdModelDataUrl || activePet.mmdModelPath || activePet.mmdMotionDataUrl || activePet.mmdMotionPath) && (
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() =>
                    updatePetAndPersist({
                      ...activePet,
                      mmdModelDataUrl: "",
                      mmdModelPath: "",
                      mmdModelName: "",
                      mmdMotionDataUrl: "",
                      mmdMotionPath: "",
                      mmdMotionName: "",
                    })
                  }
                >
                  清空 MMD
                </button>
              )}
            </div>
          )}
          {activePet.displayMode === "image" && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={config.imageProcessing.removeBackground}
                  onChange={(event) =>
                    updateConfig({
                      ...config,
                      imageProcessing: { ...config.imageProcessing, removeBackground: event.target.checked },
                    })
                  }
                />
                上传时自动抠图
              </label>
              <label className="field">
                <span>抠图容差</span>
                <input
                  type="range"
                  min={12}
                  max={96}
                  step={2}
                  value={config.imageProcessing.backgroundTolerance}
                  disabled={!config.imageProcessing.removeBackground}
                  onChange={(event) =>
                    updateConfig({
                      ...config,
                      imageProcessing: { ...config.imageProcessing, backgroundTolerance: Number(event.target.value) },
                    })
                  }
                />
              </label>
              <div className="image-toolbar">
                <label className="primary-button file-button">
                  <ImagePlus size={16} />
                  {processingImages ? "处理中" : "添加图片"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={updateImages} disabled={processingImages} />
                </label>
                {petImages.length > 0 && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => updatePet({ ...activePet, images: [] })}
                  >
                    清空
                  </button>
                )}
              </div>
              <div className="upload-box">
                {petImages[previewIndex] ? (
                  <img key={`${previewIndex}-${petImages[previewIndex].length}`} src={petImages[previewIndex]} alt="预览" />
                ) : (
                  <span>{config.imageProcessing.removeBackground ? "选择普通图片，上传时自动抠图" : "选择透明 PNG，或打开自动抠图"}</span>
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
            </>
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
                min={220}
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
                min={260}
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
                updateConfigAndPersist({ ...config, window: { ...config.window, roamEnabled: event.target.checked } })
              }
            />
            空闲时自由移动
          </label>
          <label className="field">
            <span>移动范围</span>
            <select
              value={config.window.roamMode}
              disabled={!config.window.roamEnabled}
              onChange={(event) =>
                updateConfigAndPersist({ ...config, window: { ...config.window, roamMode: event.target.value as RoamMode } })
              }
            >
              {roamModeOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
                  updateConfigAndPersist({
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
                  updateConfigAndPersist({
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
          {activePet.displayMode === "image" && (
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
          )}
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
              checked={config.animation.gazeFollowMouse}
              onChange={(event) =>
                updateConfigAndPersist({ ...config, animation: { ...config.animation, gazeFollowMouse: event.target.checked } })
              }
            />
            眼睛跟随鼠标
          </label>
          {activePet.displayMode === "image" && (
            <>
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
            </>
          )}
        </div>

        <div className="panel wide">
          <h2>
            <Eye size={18} />
            对话 API
          </h2>
          <div className="preset-actions" aria-label="API 预设">
            <button
              className="ghost-button compact"
              type="button"
              onClick={() =>
                updateConfig({
                  ...config,
                  llm: {
                    ...config.llm,
                    baseUrl: "https://api.deepseek.com",
                    model: "deepseek-v4-flash",
                  },
                })
              }
            >
              使用 DeepSeek
            </button>
          </div>
          <label className="field">
            <span>Base URL</span>
            <input
              value={config.llm.baseUrl}
              placeholder="https://api.deepseek.com"
              onChange={(event) => updateConfig({ ...config, llm: { ...config.llm, baseUrl: event.target.value } })}
            />
          </label>
          <div className="split-fields">
            <label className="field">
              <span>Model</span>
              <input
                value={config.llm.model}
                placeholder="deepseek-v4-flash"
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
