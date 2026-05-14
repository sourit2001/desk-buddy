import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { MessageCircle, Power, Settings, Send, X } from "lucide-react";
import { loadConfig, loadConfigAsync, subscribeConfig } from "./config";
import { isTauriRuntime } from "./tauriRuntime";
import { AppConfig, PetExpression, PetMood } from "./types";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export function PetWindow() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [mood, setMood] = useState<PetMood>("idle");
  const [expression, setExpression] = useState<PetExpression>("neutral");
  const [bubble, setBubble] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [imageIndex, setImageIndex] = useState(0);
  const interactionTimeoutRef = useRef<number>();
  const expressionTimeoutRef = useRef<number>();
  const expressionIndexRef = useRef(0);
  const roamingRef = useRef(false);
  const moodRef = useRef<PetMood>("idle");
  const composerOpenRef = useRef(false);

  useEffect(() => {
    loadConfigAsync().then(setConfig).catch(() => undefined);
    return subscribeConfig(setConfig);
  }, []);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    composerOpenRef.current = composerOpen;
  }, [composerOpen]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const appWindow = getCurrentWindow();
    appWindow.setAlwaysOnTop(config.window.alwaysOnTop);
    appWindow.setSize(new LogicalSize(config.window.width, config.window.height));
  }, [config.window.alwaysOnTop, config.window.height, config.window.width]);

  useEffect(() => {
    if (!isTauriRuntime() || !config.window.roamEnabled) return;

    const intervalMs = Math.max(4, config.window.roamIntervalSeconds) * 1000;
    const tryRoam = () => {
      if (composerOpenRef.current || moodRef.current !== "idle" || roamingRef.current) return;
      roamToRandomPosition().catch(() => undefined);
    };

    const firstMove = window.setTimeout(tryRoam, Math.min(2400, intervalMs));
    const interval = window.setInterval(tryRoam, intervalMs);

    return () => {
      window.clearTimeout(firstMove);
      window.clearInterval(interval);
    };
  }, [config.window.roamEnabled, config.window.roamIntervalSeconds, config.window.roamDurationSeconds]);

  const petImages = config.petImages?.length ? config.petImages : config.petImageDataUrl ? [config.petImageDataUrl] : [];

  useEffect(() => {
    if (imageIndex >= petImages.length) setImageIndex(0);
  }, [petImages.length, imageIndex]);

  useEffect(() => {
    if (!config.animation.enabled || !config.animation.framePlayback || petImages.length < 2) return;

    const interval = window.setInterval(
      () => {
        setImageIndex((current) => {
          if (petImages.length < 2) return 0;
          if (!config.animation.randomImageSwitch) return (current + 1) % petImages.length;

          const preferNext = Math.random() < 0.72;
          if (preferNext) return (current + 1) % petImages.length;

          let randomNext = Math.floor(Math.random() * petImages.length);
          if (randomNext === current) randomNext = (randomNext + 1) % petImages.length;
          return randomNext;
        });
      },
      Math.max(0.12, config.animation.imageSwitchSeconds) * 1000,
    );

    return () => window.clearInterval(interval);
  }, [
    config.animation.enabled,
    config.animation.framePlayback,
    config.animation.imageSwitchSeconds,
    config.animation.randomImageSwitch,
    petImages.length,
  ]);

  useEffect(() => {
    if (!bubble) return;
    const timeout = window.setTimeout(() => setBubble(""), Math.min(9000, Math.max(3500, bubble.length * 110)));
    return () => window.clearTimeout(timeout);
  }, [bubble]);

  useEffect(() => {
    if (!config.animation.enabled || mood !== "idle") return;

    const idleMoves: PetMood[] = ["stretch", "wiggle", "hop"];
    const timeout = window.setTimeout(
      () => {
        const nextMood = idleMoves[Math.floor(Math.random() * idleMoves.length)];
        setMood(nextMood);
        interactionTimeoutRef.current = window.setTimeout(() => setMood("idle"), nextMood === "stretch" ? 1300 : 900);
      },
      4200 + Math.random() * 4200,
    );

    return () => {
      window.clearTimeout(timeout);
      if (interactionTimeoutRef.current) window.clearTimeout(interactionTimeoutRef.current);
    };
  }, [config.animation.enabled, mood]);

  useEffect(() => {
    if (!config.animation.enabled || !config.animation.expressionEffects || mood !== "idle") {
      if (mood === "thinking") setExpression("curious");
      if (mood === "speaking") setExpression("happy");
      return;
    }

    const expressions: PetExpression[] = ["curious", "surprised", "sleepy", "shy", "happy"];
    const timeout = window.setTimeout(
      () => {
        const nextExpression = expressions[expressionIndexRef.current % expressions.length];
        expressionIndexRef.current += 1;
        setExpression(nextExpression);
        expressionTimeoutRef.current = window.setTimeout(() => setExpression("neutral"), 2600);
      },
      2600,
    );

    return () => {
      window.clearTimeout(timeout);
      if (expressionTimeoutRef.current) window.clearTimeout(expressionTimeoutRef.current);
    };
  }, [config.animation.enabled, config.animation.expressionEffects, mood]);

  const petStyle = useMemo(
    () => ({
      "--intensity": config.animation.enabled ? config.animation.intensity : 0,
    }) as React.CSSProperties,
    [config.animation.enabled, config.animation.intensity],
  );

  const currentPetImage = petImages[imageIndex] ?? "";

  async function openSettings() {
    if (!isTauriRuntime()) {
      window.location.href = "/?view=settings";
      return;
    }
    await invoke("show_settings");
  }

  async function quitApp() {
    if (!isTauriRuntime()) {
      window.close();
      return;
    }
    await invoke("quit_app");
  }

  async function handlePetClick() {
    if (!currentPetImage) {
      await openSettings();
      return;
    }

    setMood("clicked");
    if (config.animation.expressionEffects) setExpression("happy");
    window.setTimeout(() => setMood("idle"), 420);
    window.setTimeout(() => setExpression("neutral"), 1200);
  }

  async function startWindowDrag(event: MouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    roamingRef.current = false;
    event.currentTarget.classList.add("dragging");
    if (isTauriRuntime()) await getCurrentWindow().startDragging();
    event.currentTarget.classList.remove("dragging");
  }

  async function roamToRandomPosition() {
    if (roamingRef.current) return;

    const appWindow = getCurrentWindow();
    const monitor = await currentMonitor();
    const currentPosition = await appWindow.outerPosition();
    const currentSize = await appWindow.outerSize();
    if (!monitor) return;

    const scaleFactor = monitor.scaleFactor || 1;
    const monitorLeft = monitor.position.x / scaleFactor;
    const monitorTop = monitor.position.y / scaleFactor;
    const monitorWidth = monitor.size.width / scaleFactor;
    const monitorHeight = monitor.size.height / scaleFactor;
    const windowWidth = currentSize.width / scaleFactor;
    const windowHeight = currentSize.height / scaleFactor;
    const margin = 28;
    const maxX = Math.max(monitorLeft + margin, monitorLeft + monitorWidth - windowWidth - margin);
    const maxY = Math.max(monitorTop + margin, monitorTop + monitorHeight - windowHeight - margin);
    const targetX = monitorLeft + margin + Math.random() * Math.max(1, maxX - monitorLeft - margin);
    const targetY = monitorTop + margin + Math.random() * Math.max(1, maxY - monitorTop - margin);
    const startX = currentPosition.x / scaleFactor;
    const startY = currentPosition.y / scaleFactor;
    const duration = Math.max(1.2, config.window.roamDurationSeconds) * 1000;
    const startAt = performance.now();

    roamingRef.current = true;
    setMood("wiggle");

    const easeInOut = (value: number) => (value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2);

    const step = async (now: number) => {
      if (!roamingRef.current) return;

      const progress = Math.min(1, (now - startAt) / duration);
      const eased = easeInOut(progress);
      const nextX = startX + (targetX - startX) * eased;
      const nextY = startY + (targetY - startY) * eased;
      await appWindow.setPosition(new LogicalPosition(nextX, nextY));

      if (progress < 1) {
        window.requestAnimationFrame((time) => {
          step(time).catch(() => {
            roamingRef.current = false;
            setMood("idle");
          });
        });
      } else {
        roamingRef.current = false;
        setMood("idle");
      }
    };

    window.requestAnimationFrame((time) => {
      step(time).catch(() => {
        roamingRef.current = false;
        setMood("idle");
      });
    });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || mood === "thinking") return;

    setInput("");
    setComposerOpen(false);
    setBubble(text);
    setMood("thinking");

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);

    try {
      const reply = await invoke<string>("chat_completion", {
        request: {
          base_url: config.llm.baseUrl,
          api_key: config.llm.apiKey,
          model: config.llm.model,
          system_prompt: config.llm.systemPrompt,
          messages: nextMessages,
        },
      });

      setMessages([...nextMessages, { role: "assistant", content: reply }]);
      setBubble(reply);
      setMood("speaking");
      window.setTimeout(() => setMood("idle"), Math.min(5000, Math.max(1400, reply.length * 80)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBubble(`连接失败：${message}`);
      setMood("idle");
    }
  }

  return (
    <main className="pet-shell" style={petStyle} onDoubleClick={openSettings}>
      <div className="pet-drag-region" data-tauri-drag-region />

      <div className="pet-actions">
        <button className="icon-button" type="button" title="聊天" onClick={() => setComposerOpen(true)}>
          <MessageCircle size={16} />
        </button>
        <button className="icon-button" type="button" title="设置" onClick={openSettings}>
          <Settings size={16} />
        </button>
        <button className="icon-button danger" type="button" title="退出" onClick={quitApp}>
          <Power size={16} />
        </button>
      </div>

      {bubble && <div className={`speech-bubble ${mood}`}>{bubble}</div>}

      <button
        className={`pet-stage ${mood} expression-${expression}`}
        type="button"
        onMouseDown={startWindowDrag}
        onClick={handlePetClick}
        title="按住拖动位置，点击触发互动，双击设置"
      >
        {currentPetImage ? (
          <>
            <img
              key={`${imageIndex}-${currentPetImage.length}`}
              className="pet-image"
              src={currentPetImage}
              alt={config.petName}
              draggable={false}
            />
            {config.animation.expressionEffects && expression !== "neutral" && (
              <div className={`expression-layer ${expression}`} aria-hidden="true">
                <span className="mark mark-one" />
                <span className="mark mark-two" />
                <span className="mark mark-three" />
              </div>
            )}
          </>
        ) : (
          <div className="pet-placeholder">
            <Settings size={34} />
            <span>打开设置</span>
          </div>
        )}
      </button>

      {composerOpen && (
        <form className="composer" onSubmit={sendMessage}>
          <input
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={config.llm.apiKey ? "和桌宠说点什么" : "先在设置里配置 API Key"}
          />
          <button className="icon-button send" type="submit" title="发送" disabled={!config.llm.apiKey || !input.trim()}>
            <Send size={16} />
          </button>
          <button className="icon-button" type="button" title="关闭" onClick={() => setComposerOpen(false)}>
            <X size={16} />
          </button>
        </form>
      )}
    </main>
  );
}
