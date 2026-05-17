export type PetMood = "idle" | "thinking" | "speaking" | "clicked" | "stretch" | "wiggle" | "hop" | "walk" | "greet" | "nod";
export type PetExpression = "neutral" | "happy" | "curious" | "sleepy" | "surprised" | "shy" | "bored" | "petting";
export type PetPersonality = "gentle" | "lively" | "cool" | "clingy";
export type RoamMode = "anywhere" | "edges" | "topBottom" | "leftRight" | "top" | "bottom" | "left" | "right" | "middle";
export type PetDisplayMode = "image" | "mmd";
export type MmdMaterialMode = "debug" | "solid" | "texture";

export type DesktopPet = {
  id: string;
  name: string;
  images: string[];
  displayMode: PetDisplayMode;
  mmdModelDataUrl: string;
  mmdModelPath: string;
  mmdModelName: string;
  mmdMotionDataUrl: string;
  mmdMotionPath: string;
  mmdMotionName: string;
  mmdMaterialMode: MmdMaterialMode;
  mmdScale: number;
  personality: PetPersonality;
  catchphrase: string;
};

export type AppConfig = {
  activePetId: string;
  pets: DesktopPet[];
  petImageDataUrl: string;
  petImages: string[];
  petName: string;
  window: {
    width: number;
    height: number;
    alwaysOnTop: boolean;
    roamEnabled: boolean;
    roamMode: RoamMode;
    roamIntervalSeconds: number;
    roamDurationSeconds: number;
  };
  animation: {
    enabled: boolean;
    intensity: number;
    randomImageSwitch: boolean;
    imageSwitchSeconds: number;
    framePlayback: boolean;
    expressionEffects: boolean;
  };
  imageProcessing: {
    removeBackground: boolean;
    backgroundTolerance: number;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
  };
};

export const defaultConfig: AppConfig = {
  activePetId: "default",
  pets: [
    {
      id: "default",
      name: "桌宠",
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
    },
  ],
  petImageDataUrl: "",
  petImages: [],
  petName: "桌宠",
  window: {
    width: 500,
    height: 500,
    alwaysOnTop: true,
    roamEnabled: false,
    roamMode: "edges",
    roamIntervalSeconds: 12,
    roamDurationSeconds: 4,
  },
  animation: {
    enabled: true,
    intensity: 1,
    randomImageSwitch: true,
    imageSwitchSeconds: 1.2,
    framePlayback: true,
    expressionEffects: true,
  },
  imageProcessing: {
    removeBackground: false,
    backgroundTolerance: 42,
  },
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    systemPrompt: "你是一个温和、简洁、会陪伴用户的桌面宠物。回答要短，像聊天一样自然。",
  },
};

export function getActivePet(config: AppConfig): DesktopPet {
  return config.pets.find((pet) => pet.id === config.activePetId) ?? config.pets[0] ?? defaultConfig.pets[0];
}
