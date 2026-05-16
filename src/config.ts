import { AppConfig, DesktopPet, defaultConfig, getActivePet } from "./types";
import { isTauriRuntime } from "./tauriRuntime";
import { invoke } from "@tauri-apps/api/core";

const CONFIG_KEY = "desk-pet-config-v1";
const CONFIG_EVENT = "desk-pet-config-updated";

function mergeConfig(value: Partial<AppConfig>): AppConfig {
  const legacyImages = value.petImages?.length ? value.petImages : value.petImageDataUrl ? [value.petImageDataUrl] : [];
  const pets = normalizePets(value, legacyImages);
  const activePetId = pets.some((pet) => pet.id === value.activePetId) ? String(value.activePetId) : pets[0].id;
  const animation = { ...defaultConfig.animation, ...value.animation };
  if (animation.imageSwitchSeconds >= 3 && value.animation?.framePlayback === undefined) {
    animation.imageSwitchSeconds = defaultConfig.animation.imageSwitchSeconds;
  }
  if (animation.imageSwitchSeconds < 0.8 && value.animation?.expressionEffects === undefined) {
    animation.imageSwitchSeconds = defaultConfig.animation.imageSwitchSeconds;
  }

  const nextConfig = {
    ...defaultConfig,
    ...value,
    activePetId,
    pets,
    window: { ...defaultConfig.window, ...value.window },
    animation,
    imageProcessing: { ...defaultConfig.imageProcessing, ...value.imageProcessing },
    llm: { ...defaultConfig.llm, ...value.llm },
  };
  const activePet = getActivePet(nextConfig);

  return {
    ...nextConfig,
    petImageDataUrl: activePet.images[0] ?? "",
    petImages: activePet.images,
    petName: activePet.name,
  };
}

function normalizePets(value: Partial<AppConfig>, legacyImages: string[]): DesktopPet[] {
  if (value.pets?.length) {
    const usedIds = new Set<string>();
    return value.pets.map((pet, index) => {
      const fallbackId = index === 0 ? "default" : `pet-${index + 1}`;
      const rawId = typeof pet.id === "string" && pet.id.trim() ? pet.id.trim() : fallbackId;
      const id = usedIds.has(rawId) ? `${rawId}-${index + 1}` : rawId;
      usedIds.add(id);

      return {
        id,
        name: typeof pet.name === "string" && pet.name.trim() ? pet.name.trim() : `桌宠 ${index + 1}`,
        images: Array.isArray(pet.images) ? pet.images.filter(Boolean) : [],
        displayMode: pet.displayMode ?? defaultConfig.pets[0].displayMode,
        mmdModelDataUrl: typeof pet.mmdModelDataUrl === "string" ? pet.mmdModelDataUrl : "",
        mmdModelPath: typeof pet.mmdModelPath === "string" ? pet.mmdModelPath : "",
        mmdModelName: typeof pet.mmdModelName === "string" ? pet.mmdModelName : "",
        mmdMotionDataUrl: typeof pet.mmdMotionDataUrl === "string" ? pet.mmdMotionDataUrl : "",
        mmdMotionPath: typeof pet.mmdMotionPath === "string" ? pet.mmdMotionPath : "",
        mmdMotionName: typeof pet.mmdMotionName === "string" ? pet.mmdMotionName : "",
        mmdMaterialMode: pet.mmdMaterialMode ?? defaultConfig.pets[0].mmdMaterialMode,
        mmdScale: typeof pet.mmdScale === "number" && Number.isFinite(pet.mmdScale) ? pet.mmdScale : defaultConfig.pets[0].mmdScale,
        personality: pet.personality ?? defaultConfig.pets[0].personality,
        catchphrase: typeof pet.catchphrase === "string" ? pet.catchphrase : "",
      };
    });
  }

  return [
    {
      id: defaultConfig.activePetId,
      name: value.petName?.trim() || defaultConfig.petName,
      images: legacyImages,
      displayMode: defaultConfig.pets[0].displayMode,
      mmdModelDataUrl: "",
      mmdModelPath: "",
      mmdModelName: "",
      mmdMotionDataUrl: "",
      mmdMotionPath: "",
      mmdMotionName: "",
      mmdMaterialMode: defaultConfig.pets[0].mmdMaterialMode,
      mmdScale: defaultConfig.pets[0].mmdScale,
      personality: defaultConfig.pets[0].personality,
      catchphrase: "",
    },
  ];
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
    const lightweightConfig = {
      ...nextConfig,
      petImageDataUrl: "",
      petImages: [],
      pets: nextConfig.pets.map((pet) => ({ ...pet, images: [], mmdModelDataUrl: "", mmdMotionDataUrl: "" })),
    };
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
