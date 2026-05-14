import { AppConfig, defaultConfig } from "./types";
import { isTauriRuntime } from "./tauriRuntime";
import { invoke } from "@tauri-apps/api/core";

const CONFIG_KEY = "desk-pet-config-v1";
const CONFIG_EVENT = "desk-pet-config-updated";

function mergeConfig(value: Partial<AppConfig>): AppConfig {
  const petImages = value.petImages?.length ? value.petImages : value.petImageDataUrl ? [value.petImageDataUrl] : [];
  const animation = { ...defaultConfig.animation, ...value.animation };
  if (animation.imageSwitchSeconds >= 3 && value.animation?.framePlayback === undefined) {
    animation.imageSwitchSeconds = defaultConfig.animation.imageSwitchSeconds;
  }
  if (animation.imageSwitchSeconds < 0.8 && value.animation?.expressionEffects === undefined) {
    animation.imageSwitchSeconds = defaultConfig.animation.imageSwitchSeconds;
  }

  return {
    ...defaultConfig,
    ...value,
    petImageDataUrl: petImages[0] ?? "",
    petImages,
    window: { ...defaultConfig.window, ...value.window },
    animation,
    llm: { ...defaultConfig.llm, ...value.llm },
  };
}

export function loadConfig(): AppConfig {
  const raw = localStorage.getItem(CONFIG_KEY);
  if (!raw) return defaultConfig;

  try {
    return mergeConfig(JSON.parse(raw) as Partial<AppConfig>);
  } catch {
    return defaultConfig;
  }
}

export async function loadConfigAsync(): Promise<AppConfig> {
  if (isTauriRuntime()) {
    const stored = await invoke<Partial<AppConfig> | null>("load_config");
    if (stored) return mergeConfig(stored);
  }

  return loadConfig();
}

export async function saveConfig(config: AppConfig) {
  const nextConfig = mergeConfig(config);

  if (isTauriRuntime()) {
    await invoke("save_config", { config: nextConfig });
  }

  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(nextConfig));
  } catch {
    const lightweightConfig = { ...nextConfig, petImageDataUrl: "", petImages: [] };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(lightweightConfig));
  }

  window.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: nextConfig }));

  if (isTauriRuntime()) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(CONFIG_EVENT, nextConfig);
  }
}

export function subscribeConfig(listener: (config: AppConfig) => void) {
  let unlistenTauri: (() => void) | undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.key === CONFIG_KEY) listener(loadConfig());
  };
  const onCustom = (event: Event) => {
    listener(mergeConfig((event as CustomEvent<AppConfig>).detail));
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(CONFIG_EVENT, onCustom);

  if (isTauriRuntime()) {
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<AppConfig>(CONFIG_EVENT, (event) => {
          listener(mergeConfig(event.payload));
        }),
      )
      .then((unlisten) => {
        unlistenTauri = unlisten;
      })
      .catch(() => undefined);
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CONFIG_EVENT, onCustom);
    unlistenTauri?.();
  };
}
