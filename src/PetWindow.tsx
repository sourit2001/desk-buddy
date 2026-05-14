import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { Heart, MessageCircle, Moon, Power, Send, Settings, Sparkles, Utensils, X } from "lucide-react";
import { loadConfig, loadConfigAsync, subscribeConfig } from "./config";
import { isTauriRuntime } from "./tauriRuntime";
import { AppConfig, getActivePet, PetExpression, PetMood } from "./types";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type PetRuntimeState = {
  affection: number;
  energy: number;
  lastInteractionAt: number;
};

type PetMenu = {
  x: number;
  y: number;
};

const defaultPetState: PetRuntimeState = {
  affection: 35,
  energy: 72,
  lastInteractionAt: Date.now(),
};

const personalityNames = {
  gentle: "温和",
  lively: "活泼",
  cool: "酷酷的",
  clingy: "黏人",
};

function petStateKey(petId: string) {
  return `desk-pet-state-${petId}`;
}

function loadPetState(petId: string): PetRuntimeState {
  try {
    const raw = localStorage.getItem(petStateKey(petId));
    if (!raw) return defaultPetState;
    return { ...defaultPetState, ...(JSON.parse(raw) as Partial<PetRuntimeState>) };
  } catch {
    return defaultPetState;
  }
}

function savePetState(petId: string, state: PetRuntimeState) {
  try {
    localStorage.setItem(petStateKey(petId), JSON.stringify(state));
  } catch {
    // Runtime state is nice-to-have; config persistence still works without it.
  }
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function PetWindow() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [mood, setMood] = useState<PetMood>("idle");
  const [expression, setExpression] = useState<PetExpression>("neutral");
  const [bubble, setBubble] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [imageIndex, setImageIndex] = useState(0);
  const [petState, setPetState] = useState<PetRuntimeState>(defaultPetState);
  const [petMenu, setPetMenu] = useState<PetMenu | null>(null);
  const interactionTimeoutRef = useRef<number>();
  const expressionTimeoutRef = useRef<number>();
  const expressionIndexRef = useRef(0);
  const roamingRef = useRef(false);
  const moodRef = useRef<PetMood>("idle");
  const composerOpenRef = useRef(false);
  const activePet = getActivePet(config);
  const petImages = activePet.images;

  useEffect(() => {
    loadConfigAsync().then(setConfig).catch(() => undefined);
    return subscribeConfig(setConfig);
  }, []);

  useEffect(() => {
    setPetState(loadPetState(activePet.id));
    setPetMenu(null);
    setMessages([]);
    setImageIndex(0);
  }, [activePet.id]);

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

  useEffect(() => {
    if (!currentPetImage || composerOpen || mood !== "idle" || bubble) return;

    const timeout = window.setTimeout(
      () => {
        if (composerOpenRef.current || moodRef.current !== "idle") return;
        const line = getIdleLine();
        setBubble(line);
        setExpression(petState.energy < 32 ? "sleepy" : "curious");
        window.setTimeout(() => setExpression("neutral"), 2200);
      },
      22000 + Math.random() * 18000,
    );

    return () => window.clearTimeout(timeout);
  }, [activePet.id, bubble, composerOpen, currentPetImage, mood, petState.affection, petState.energy]);

  function commitPetState(updater: (state: PetRuntimeState) => PetRuntimeState) {
    setPetState((current) => {
      const next = updater(current);
      savePetState(activePet.id, next);
      return next;
    });
  }

  function interact(text: string, nextExpression: PetExpression, nextMood: PetMood = "clicked") {
    setPetMenu(null);
    setBubble(text);
    setMood(nextMood);
    setExpression(nextExpression);
    window.setTimeout(() => setMood("idle"), nextMood === "hop" ? 900 : 620);
    window.setTimeout(() => setExpression("neutral"), 1800);
  }

  function getPetLine(kind: "pet" | "feed" | "nap" | "play") {
    if (activePet.catchphrase.trim()) return activePet.catchphrase.trim();

    const lines = {
      gentle: {
        pet: ["嗯，我在。", "这样很舒服。", "谢谢你陪我。"],
        feed: ["吃饱一点，心情也会好一点。", "这份我收下了。"],
        nap: ["我眯一会儿，等下继续陪你。", "安静一会儿也很好。"],
        play: ["慢慢来，我跟得上。", "今天也要轻松一点。"],
      },
      lively: {
        pet: ["再来一下！", "嘿嘿，精神起来了！", "我准备好了！"],
        feed: ["补充能量完成！", "好吃，再来点也行。"],
        nap: ["充电十分钟，快乐一整天！", "我先打个盹。"],
        play: ["出发！", "这个我喜欢！"],
      },
      cool: {
        pet: ["嗯，知道了。", "手法还行。", "别太得意。"],
        feed: ["可以。", "能量补上了。"],
        nap: ["我只是短暂离线。", "保持安静。"],
        play: ["勉强陪你一下。", "这局算你赢。"],
      },
      clingy: {
        pet: ["不要停。", "你终于理我啦。", "再陪我一会儿。"],
        feed: ["一起吃更好。", "你记得我，我很开心。"],
        nap: ["你别走太远。", "我睡醒还要找你。"],
        play: ["我想一直跟着你。", "再玩一次吧。"],
      },
    }[activePet.personality][kind];

    return lines[Math.floor(Math.random() * lines.length)];
  }

  function getIdleLine() {
    if (petState.energy < 28) return `${activePet.name} 有点困了。`;
    if (petState.affection > 75) return `${activePet.name} 正在等你摸摸。`;

    const lines = {
      gentle: ["休息一下眼睛吧。", "我在这里陪你。", "今天也慢慢来。"],
      lively: ["要不要活动一下？", "我刚刚想到一个好玩的动作。", "你忙完了吗？"],
      cool: ["我在巡逻。", "效率还不错。", "别忘了保存你的工作。"],
      clingy: ["你是不是忘记我了？", "我可以靠近一点吗？", "陪我说句话嘛。"],
    }[activePet.personality];

    return lines[Math.floor(Math.random() * lines.length)];
  }

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    setPetMenu({ x: Math.min(event.clientX, window.innerWidth - 142), y: Math.min(event.clientY, window.innerHeight - 188) });
  }

  function toggleInteractionMenu(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setPetMenu((current) =>
      current
        ? null
        : {
            x: Math.max(8, window.innerWidth - 148),
            y: 46,
          },
    );
  }

  function runInteraction(kind: "pet" | "feed" | "nap" | "play" | "chat") {
    if (kind === "chat") {
      setPetMenu(null);
      setComposerOpen(true);
      return;
    }

    const updates = {
      pet: { affection: 4, energy: 0, expression: "happy" as PetExpression, mood: "clicked" as PetMood },
      feed: { affection: 2, energy: 12, expression: "happy" as PetExpression, mood: "speaking" as PetMood },
      nap: { affection: 0, energy: 24, expression: "sleepy" as PetExpression, mood: "stretch" as PetMood },
      play: { affection: 5, energy: -10, expression: "surprised" as PetExpression, mood: "hop" as PetMood },
    }[kind];

    commitPetState((state) => ({
      affection: clamp(state.affection + updates.affection),
      energy: clamp(state.energy + updates.energy),
      lastInteractionAt: Date.now(),
    }));
    interact(getPetLine(kind), updates.expression, updates.mood);
  }

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

    commitPetState((state) => ({
      affection: clamp(state.affection + 2),
      energy: clamp(state.energy - 1),
      lastInteractionAt: Date.now(),
    }));
    interact(getPetLine("pet"), "happy", "clicked");
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
          system_prompt: `${config.llm.systemPrompt}

当前桌宠：${activePet.name}
性格：${personalityNames[activePet.personality]}
亲密度：${Math.round(petState.affection)}/100
精力：${Math.round(petState.energy)}/100
${activePet.catchphrase.trim() ? `口头禅：${activePet.catchphrase.trim()}` : ""}
请保持这个桌宠的人设，回复短一点，像桌面宠物在和主人说话。`,
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
    <main className="pet-shell" style={petStyle} onClick={() => setPetMenu(null)} onContextMenu={handleContextMenu} onDoubleClick={openSettings}>
      <div className="pet-drag-region" data-tauri-drag-region />

      <div className="pet-actions">
        <button className="icon-button" type="button" title="互动" onClick={toggleInteractionMenu}>
          <Sparkles size={16} />
        </button>
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

      <div className="pet-status" aria-label="桌宠状态">
        <strong>{activePet.name}</strong>
        <span>亲密 {Math.round(petState.affection)}</span>
        <span>精力 {Math.round(petState.energy)}</span>
      </div>

      {bubble && <div className={`speech-bubble ${mood}`}>{bubble}</div>}

      <button
        className={`pet-stage ${mood} expression-${expression}`}
        type="button"
        onMouseDown={startWindowDrag}
        onClick={handlePetClick}
        title="左键摸摸，右键互动，按住拖动位置，双击设置"
      >
        {currentPetImage ? (
          <>
            <img
              key={`${imageIndex}-${currentPetImage.length}`}
              className="pet-image"
              src={currentPetImage}
              alt={activePet.name}
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

      {petMenu && (
        <div className="pet-menu" style={{ left: petMenu.x, top: petMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => runInteraction("pet")}>
            <Heart size={15} />
            摸摸
          </button>
          <button type="button" onClick={() => runInteraction("feed")}>
            <Utensils size={15} />
            喂食
          </button>
          <button type="button" onClick={() => runInteraction("nap")}>
            <Moon size={15} />
            休息
          </button>
          <button type="button" onClick={() => runInteraction("play")}>
            <Sparkles size={15} />
            玩一下
          </button>
          <button type="button" onClick={() => runInteraction("chat")}>
            <MessageCircle size={15} />
            聊天
          </button>
        </div>
      )}

      {composerOpen && (
        <form className="composer" onSubmit={sendMessage}>
          <input
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={config.llm.apiKey ? `和 ${activePet.name} 说点什么` : "先在设置里配置 API Key"}
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
