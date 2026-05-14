export type PetMood = "idle" | "thinking" | "speaking" | "clicked" | "stretch" | "wiggle" | "hop";
export type PetExpression = "neutral" | "happy" | "curious" | "sleepy" | "surprised" | "shy";

export type AppConfig = {
  petImageDataUrl: string;
  petImages: string[];
  petName: string;
  window: {
    width: number;
    height: number;
    alwaysOnTop: boolean;
    roamEnabled: boolean;
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
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
  };
};

export const defaultConfig: AppConfig = {
  petImageDataUrl: "",
  petImages: [],
  petName: "桌宠",
  window: {
    width: 280,
    height: 320,
    alwaysOnTop: true,
    roamEnabled: false,
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
  llm: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    systemPrompt: "你是一个温和、简洁、会陪伴用户的桌面宠物。回答要短，像聊天一样自然。",
  },
};
