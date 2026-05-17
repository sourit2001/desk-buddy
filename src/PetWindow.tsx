import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { Footprints, Hand, Heart, MessageCircle, Moon, Power, Send, Settings, Smile, Sparkles, Utensils, X } from "lucide-react";
import { loadConfig, loadConfigAsync, subscribeConfig } from "./config";
import { isTauriRuntime } from "./tauriRuntime";
import { MmdPet } from "./MmdPet";
import { AppConfig, getActivePet, PetExpression, PetMood, RoamMode } from "./types";

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

type RoamBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type RoamTarget = {
  x: number;
  y: number;
};

type RoamEdge = "top" | "right" | "bottom" | "left";

const defaultPetState: PetRuntimeState = {
  affection: 35,
  energy: 72,
  lastInteractionAt: Date.now(),
};

const moodDurations: Partial<Record<PetMood, number>> = {
  stretch: 1300,
  wiggle: 900,
  hop: 900,
  walk: 1600,
  greet: 1250,
  nod: 1050,
};

const proactiveLineDelays = {
  interval: 12000,
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

function randomBetween(min: number, max: number) {
  return min + Math.random() * Math.max(1, max - min);
}

function pickFarCoordinate(min: number, max: number, current: number) {
  const span = Math.max(1, max - min);
  const midpoint = min + span / 2;
  const targetMin = current < midpoint ? min + span * 0.88 : min;
  const targetMax = current < midpoint ? max : max - span * 0.88;
  return randomBetween(targetMin, targetMax);
}

function pickOppositeEdgeCoordinate(min: number, max: number, current: number) {
  const span = Math.max(1, max - min);
  const edgeBand = Math.max(1, span * 0.08);
  const midpoint = min + span / 2;
  return current < midpoint ? randomBetween(max - edgeBand, max) : randomBetween(min, min + edgeBand);
}

function distanceBetween(from: RoamTarget, to: RoamTarget) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function nearestEdge(point: RoamTarget, bounds: RoamBounds): RoamEdge {
  const distances: Array<{ edge: RoamEdge; distance: number }> = [
    { edge: "top", distance: Math.abs(point.y - bounds.top) },
    { edge: "right", distance: Math.abs(point.x - bounds.right) },
    { edge: "bottom", distance: Math.abs(point.y - bounds.bottom) },
    { edge: "left", distance: Math.abs(point.x - bounds.left) },
  ];
  return distances.sort((a, b) => a.distance - b.distance)[0].edge;
}

function pointOnEdge(edge: RoamEdge, point: RoamTarget, bounds: RoamBounds): RoamTarget {
  if (edge === "top") return { x: clamp(point.x, bounds.left, bounds.right), y: bounds.top };
  if (edge === "right") return { x: bounds.right, y: clamp(point.y, bounds.top, bounds.bottom) };
  if (edge === "bottom") return { x: clamp(point.x, bounds.left, bounds.right), y: bounds.bottom };
  return { x: bounds.left, y: clamp(point.y, bounds.top, bounds.bottom) };
}

function perimeterLength(bounds: RoamBounds) {
  return Math.max(1, 2 * (bounds.right - bounds.left + bounds.bottom - bounds.top));
}

function edgePointToPerimeter(point: RoamTarget, bounds: RoamBounds) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const edge = nearestEdge(point, bounds);

  if (edge === "top") return clamp(point.x, bounds.left, bounds.right) - bounds.left;
  if (edge === "right") return width + clamp(point.y, bounds.top, bounds.bottom) - bounds.top;
  if (edge === "bottom") return width + height + bounds.right - clamp(point.x, bounds.left, bounds.right);
  return width + height + width + bounds.bottom - clamp(point.y, bounds.top, bounds.bottom);
}

function perimeterToPoint(distance: number, bounds: RoamBounds): RoamTarget {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const perimeter = perimeterLength(bounds);
  const position = ((distance % perimeter) + perimeter) % perimeter;

  if (position <= width) return { x: bounds.left + position, y: bounds.top };
  if (position <= width + height) return { x: bounds.right, y: bounds.top + position - width };
  if (position <= width + height + width) return { x: bounds.right - (position - width - height), y: bounds.bottom };
  return { x: bounds.left, y: bounds.bottom - (position - width - height - width) };
}

function getEdgeRoamPath(start: RoamTarget, bounds: RoamBounds): RoamTarget[] {
  const perimeter = perimeterLength(bounds);
  const startOnEdge = pointOnEdge(nearestEdge(start, bounds), start, bounds);
  const startDistance = edgePointToPerimeter(startOnEdge, bounds);
  const targetDistance = startDistance + perimeter * randomBetween(0.48, 0.82);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const corners = [width, width + height, width + height + width, perimeter].map((corner) =>
    corner <= startDistance ? corner + perimeter : corner,
  );
  const path = [startOnEdge];

  corners
    .filter((corner) => corner > startDistance && corner < targetDistance)
    .forEach((corner) => path.push(perimeterToPoint(corner, bounds)));
  path.push(perimeterToPoint(targetDistance, bounds));

  return path;
}

function getHorizontalEdgeRoamPath(mode: Extract<RoamMode, "top" | "bottom" | "topBottom">, start: RoamTarget, bounds: RoamBounds) {
  const currentEdge = Math.abs(start.y - bounds.top) <= Math.abs(start.y - bounds.bottom) ? "top" : "bottom";
  const edge = mode === "topBottom" ? (currentEdge === "top" ? "bottom" : "top") : mode;
  const startOnEdge = pointOnEdge(edge, start, bounds);

  return [
    startOnEdge,
    {
      x: pickOppositeEdgeCoordinate(bounds.left, bounds.right, start.x),
      y: edge === "top" ? bounds.top : bounds.bottom,
    },
  ];
}

function getVerticalEdgeRoamPath(mode: Extract<RoamMode, "left" | "right" | "leftRight">, start: RoamTarget, bounds: RoamBounds) {
  const currentEdge = Math.abs(start.x - bounds.left) <= Math.abs(start.x - bounds.right) ? "left" : "right";
  const edge = mode === "leftRight" ? (currentEdge === "left" ? "right" : "left") : mode;
  const startOnEdge = pointOnEdge(edge, start, bounds);

  return [
    startOnEdge,
    {
      x: edge === "left" ? bounds.left : bounds.right,
      y: pickOppositeEdgeCoordinate(bounds.top, bounds.bottom, start.y),
    },
  ];
}

function getRoamTarget(mode: RoamMode, bounds: RoamBounds): RoamTarget {
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const edgeBand = Math.min(90, Math.max(24, Math.min(width, height) * 0.14));
  const middleBandTop = bounds.top + height * 0.38;
  const middleBandBottom = bounds.top + height * 0.62;

  if (mode === "middle") {
    return {
      x: randomBetween(bounds.left + width * 0.2, bounds.right - width * 0.2),
      y: randomBetween(middleBandTop, middleBandBottom),
    };
  }

  if (mode === "top" || mode === "bottom" || mode === "topBottom") {
    const useTop = mode === "top" || (mode === "topBottom" && Math.random() < 0.5);
    return {
      x: randomBetween(bounds.left, bounds.right),
      y: useTop ? randomBetween(bounds.top, bounds.top + edgeBand) : randomBetween(bounds.bottom - edgeBand, bounds.bottom),
    };
  }

  if (mode === "left" || mode === "right" || mode === "leftRight") {
    const useLeft = mode === "left" || (mode === "leftRight" && Math.random() < 0.5);
    return {
      x: useLeft ? randomBetween(bounds.left, bounds.left + edgeBand) : randomBetween(bounds.right - edgeBand, bounds.right),
      y: randomBetween(bounds.top, bounds.bottom),
    };
  }

  if (mode === "edges") {
    const side = Math.floor(Math.random() * 4);
    if (side === 0) return { x: randomBetween(bounds.left, bounds.right), y: randomBetween(bounds.top, bounds.top + edgeBand) };
    if (side === 1) return { x: randomBetween(bounds.left, bounds.right), y: randomBetween(bounds.bottom - edgeBand, bounds.bottom) };
    if (side === 2) return { x: randomBetween(bounds.left, bounds.left + edgeBand), y: randomBetween(bounds.top, bounds.bottom) };
    return { x: randomBetween(bounds.right - edgeBand, bounds.right), y: randomBetween(bounds.top, bounds.bottom) };
  }

  if (Math.random() < 0.72) {
    return getRoamTarget("edges", bounds);
  }

  return {
    x: randomBetween(bounds.left, bounds.right),
    y: randomBetween(bounds.top, bounds.bottom),
  };
}

function getRoamPath(mode: RoamMode, bounds: RoamBounds, start: RoamTarget): RoamTarget[] {
  const path =
    mode === "edges"
      ? getEdgeRoamPath(start, bounds)
      : mode === "top" || mode === "bottom" || mode === "topBottom"
        ? getHorizontalEdgeRoamPath(mode, start, bounds)
        : mode === "left" || mode === "right" || mode === "leftRight"
          ? getVerticalEdgeRoamPath(mode, start, bounds)
        : [getRoamTarget(mode, bounds)];

  return path.filter((point, index) => index === 0 || distanceBetween(path[index - 1], point) > 1);
}

function getPositionOnPath(start: RoamTarget, waypoints: RoamTarget[], progress: number): RoamTarget {
  const points = [start, ...waypoints];
  const lengths = points.slice(1).map((point, index) => distanceBetween(points[index], point));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  let travelled = totalLength * progress;

  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (travelled > length && index < lengths.length - 1) {
      travelled -= length;
      continue;
    }

    const from = points[index];
    const to = points[index + 1];
    const segmentProgress = length <= 0 ? 1 : clamp(travelled / length, 0, 1);
    return {
      x: from.x + (to.x - from.x) * segmentProgress,
      y: from.y + (to.y - from.y) * segmentProgress,
    };
  }

  return waypoints[waypoints.length - 1] ?? start;
}

function shouldUseScreenEdgeBounds(mode: RoamMode) {
  return mode === "edges" || mode === "topBottom" || mode === "leftRight" || mode === "top" || mode === "bottom" || mode === "left" || mode === "right";
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
  const proactiveLineCountRef = useRef(0);
  const moodRef = useRef<PetMood>("idle");
  const composerOpenRef = useRef(false);
  const activePet = getActivePet(config);
  const petImages = activePet.images;
  const isMmdMode = activePet.displayMode === "mmd";

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
  }, [config.window.roamEnabled, config.window.roamIntervalSeconds, config.window.roamDurationSeconds, config.window.roamMode]);

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

    const idleMoves: PetMood[] = ["stretch", "wiggle", "hop", "nod"];
    const timeout = window.setTimeout(
      () => {
        const nextMood = idleMoves[Math.floor(Math.random() * idleMoves.length)];
        setMood(nextMood);
        interactionTimeoutRef.current = window.setTimeout(() => setMood("idle"), moodDurations[nextMood] ?? 900);
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

    const expressions: PetExpression[] = ["curious", "bored", "surprised", "sleepy", "shy", "happy", "petting"];
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
      "--pet-scale": isMmdMode ? activePet.mmdScale : 1,
    }) as React.CSSProperties,
    [activePet.mmdScale, config.animation.enabled, config.animation.intensity, isMmdMode],
  );

  const currentPetImage = petImages[imageIndex] ?? "";
  const hasPetVisual = isMmdMode || Boolean(currentPetImage);

  useEffect(() => {
    if (!hasPetVisual) return;

    const interval = window.setInterval(() => {
      if (composerOpenRef.current || bubble || moodRef.current === "thinking" || moodRef.current === "speaking") return;
      if (roamingRef.current && proactiveLineCountRef.current > 0) return;

      const firstLine = proactiveLineCountRef.current === 0;
      const shouldSpeak = firstLine || Math.random() < 0.58;
      if (shouldSpeak) {
        const idle = getIdleLine();
        proactiveLineCountRef.current += 1;
        setBubble(idle.text);
        setExpression(idle.expression);
        window.setTimeout(() => setExpression("neutral"), 2200);
      }
    }, proactiveLineDelays.interval);

    return () => window.clearInterval(interval);
  }, [activePet.id, bubble, hasPetVisual, petState.affection, petState.energy]);

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
    window.setTimeout(() => setMood("idle"), moodDurations[nextMood] ?? 620);
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

  function getIdleLine(): { text: string; expression: PetExpression } {
    const tiredLines = [
      { text: `${activePet.name} 有点困了。`, expression: "sleepy" as PetExpression },
      { text: "眼皮有点重。", expression: "sleepy" as PetExpression },
      { text: "我想安静待一会儿。", expression: "sleepy" as PetExpression },
    ];
    const affectionateLines = [
      { text: `${activePet.name} 正在等你摸摸。`, expression: "petting" as PetExpression },
      { text: "你刚刚是不是看我了？", expression: "curious" as PetExpression },
      { text: "我今天很乖。", expression: "happy" as PetExpression },
      { text: "陪你待着也不错。", expression: "happy" as PetExpression },
      { text: "可以靠近你一点吗？", expression: "petting" as PetExpression },
      { text: "我在这里，不会打扰你。", expression: "curious" as PetExpression },
    ];
    const personalityLines = {
      gentle: [
        { text: "休息一下眼睛吧。", expression: "curious" as PetExpression },
        { text: "我在这里陪你。", expression: "happy" as PetExpression },
        { text: "今天也慢慢来。", expression: "bored" as PetExpression },
        { text: "喝点水也不错。", expression: "curious" as PetExpression },
        { text: "不用着急，我等你。", expression: "happy" as PetExpression },
        { text: "窗外现在安静吗？", expression: "curious" as PetExpression },
      ],
      lively: [
        { text: "要不要活动一下？", expression: "happy" as PetExpression },
        { text: "我刚刚想到一个好玩的动作。", expression: "curious" as PetExpression },
        { text: "你忙完了吗？", expression: "petting" as PetExpression },
        { text: "我可以转一圈吗？", expression: "happy" as PetExpression },
        { text: "现在适合小小休息一下。", expression: "curious" as PetExpression },
        { text: "我有点想出去走走。", expression: "bored" as PetExpression },
      ],
      cool: [
        { text: "我在巡逻。", expression: "curious" as PetExpression },
        { text: "效率还不错。", expression: "happy" as PetExpression },
        { text: "有点无聊。", expression: "bored" as PetExpression },
        { text: "状态稳定。", expression: "curious" as PetExpression },
        { text: "别忘了保存。", expression: "curious" as PetExpression },
        { text: "我只是路过。", expression: "bored" as PetExpression },
      ],
      clingy: [
        { text: "你是不是忘记我了？", expression: "bored" as PetExpression },
        { text: "我可以靠近一点吗？", expression: "petting" as PetExpression },
        { text: "陪我说句话嘛。", expression: "petting" as PetExpression },
        { text: "我刚刚一直在等你。", expression: "petting" as PetExpression },
        { text: "你忙你的，我看着你。", expression: "happy" as PetExpression },
        { text: "不要太久不理我。", expression: "bored" as PetExpression },
      ],
    }[activePet.personality];
    const lines = [
      ...personalityLines,
      ...(petState.energy < 36 ? tiredLines : []),
      ...(petState.affection > 72 ? affectionateLines : []),
    ];

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

  function runInteraction(kind: "pet" | "feed" | "nap" | "play" | "chat" | "walk" | "greet" | "nod") {
    if (kind === "chat") {
      setPetMenu(null);
      setComposerOpen(true);
      return;
    }

    if (kind === "walk" || kind === "greet" || kind === "nod") {
      const action = {
        walk: { text: "我走两步给你看。", expression: "curious" as PetExpression, mood: "walk" as PetMood, energy: -2 },
        greet: { text: "嗨，我在这里。", expression: "happy" as PetExpression, mood: "greet" as PetMood, energy: -1 },
        nod: { text: "嗯嗯。", expression: "happy" as PetExpression, mood: "nod" as PetMood, energy: 0 },
      }[kind];

      commitPetState((state) => ({
        affection: clamp(state.affection + 1),
        energy: clamp(state.energy + action.energy),
        lastInteractionAt: Date.now(),
      }));
      interact(action.text, action.expression, action.mood);
      return;
    }

    const updates = {
        pet: { affection: 4, energy: 0, expression: "petting" as PetExpression, mood: "clicked" as PetMood },
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
    if (!hasPetVisual) {
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

  async function startWindowDrag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    roamingRef.current = false;
    event.currentTarget.classList.add("dragging");

    if (!isTauriRuntime()) {
      event.currentTarget.classList.remove("dragging");
      return;
    }

    const dragElement = event.currentTarget;
    const appWindow = getCurrentWindow();
    const monitor = await currentMonitor();
    const scaleFactor = monitor?.scaleFactor || 1;
    const startMouseX = event.screenX;
    const startMouseY = event.screenY;
    const startPosition = await appWindow.outerPosition();
    const startLogicalX = startPosition.x / scaleFactor;
    const startLogicalY = startPosition.y / scaleFactor;

    const moveWindow = (moveEvent: globalThis.MouseEvent) => {
      const deltaX = moveEvent.screenX - startMouseX;
      const deltaY = moveEvent.screenY - startMouseY;
      appWindow.setPosition(new LogicalPosition(startLogicalX + deltaX, startLogicalY + deltaY)).catch(() => undefined);
    };

    const stopDrag = () => {
      window.removeEventListener("mousemove", moveWindow);
      window.removeEventListener("mouseup", stopDrag);
      dragElement.classList.remove("dragging");
    };

    window.addEventListener("mousemove", moveWindow);
    window.addEventListener("mouseup", stopDrag, { once: true });
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
    const margin = shouldUseScreenEdgeBounds(config.window.roamMode) ? 0 : 28;
    const bounds: RoamBounds = {
      left: monitorLeft + margin,
      top: monitorTop + margin,
      right: Math.max(monitorLeft + margin, monitorLeft + monitorWidth - windowWidth - margin),
      bottom: Math.max(monitorTop + margin, monitorTop + monitorHeight - windowHeight - margin),
    };
    const startX = currentPosition.x / scaleFactor;
    const startY = currentPosition.y / scaleFactor;
    const start = { x: startX, y: startY };
    const waypoints = getRoamPath(config.window.roamMode, bounds, start);
    if (!waypoints.length) return;

    const duration = Math.max(1.2, config.window.roamDurationSeconds) * 1000;
    const startAt = performance.now();

    roamingRef.current = true;
    setMood("wiggle");

    const easeInOut = (value: number) => (value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2);

    const step = async (now: number) => {
      if (!roamingRef.current) return;

      const progress = Math.min(1, (now - startAt) / duration);
      const eased = easeInOut(progress);
      const nextPosition = getPositionOnPath(start, waypoints, eased);
      await appWindow.setPosition(new LogicalPosition(nextPosition.x, nextPosition.y));

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

  function renderExpressionLayer() {
    if (!config.animation.expressionEffects || expression === "neutral") return null;

    return (
      <div className={`expression-layer ${expression}`} aria-hidden="true">
        <span className="mark mark-one" />
        <span className="mark mark-two" />
        <span className="mark mark-three" />
      </div>
    );
  }

  return (
    <main
      className="pet-shell"
      style={petStyle}
      onClick={() => setPetMenu(null)}
      onContextMenu={handleContextMenu}
      onDoubleClick={openSettings}
    >
      <div className="pet-drag-region" data-tauri-drag-region />

      <div className="pet-status" aria-label="桌宠状态" data-tauri-drag-region>
        <strong>{activePet.name}</strong>
        <span>亲密 {Math.round(petState.affection)}</span>
        <span>精力 {Math.round(petState.energy)}</span>
      </div>

      {bubble && (
        <div className={`speech-bubble ${mood}`} data-tauri-drag-region>
          {bubble}
        </div>
      )}

      <div className="pet-actions" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
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

      <div
        className={`pet-stage ${mood} expression-${expression}`}
        role="button"
        tabIndex={0}
        onMouseDown={startWindowDrag}
        onClick={handlePetClick}
        title="左键摸摸，右键互动，按住拖动位置，双击设置"
      >
        {isMmdMode ? (
          <>
            <MmdPet
              modelDataUrl={activePet.mmdModelDataUrl}
              modelPath={activePet.mmdModelPath}
              motionDataUrl={activePet.mmdMotionDataUrl}
              motionPath={activePet.mmdMotionPath}
              motionName={activePet.mmdMotionName}
              modelName={activePet.mmdModelName || activePet.mmdModelPath}
              modelScale={activePet.mmdScale}
              mood={mood}
              intensity={config.animation.enabled ? config.animation.intensity : 0}
            />
            {renderExpressionLayer()}
          </>
        ) : currentPetImage ? (
          <>
            <img
              key={`${imageIndex}-${currentPetImage.length}`}
              className="pet-image"
              src={currentPetImage}
              alt={activePet.name}
              draggable={false}
            />
            {renderExpressionLayer()}
          </>
        ) : (
          <div className="pet-placeholder">
            <Settings size={34} />
            <span>打开设置</span>
          </div>
        )}
      </div>

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
          <button type="button" onClick={() => runInteraction("walk")}>
            <Footprints size={15} />
            走走路
          </button>
          <button type="button" onClick={() => runInteraction("greet")}>
            <Hand size={15} />
            打招呼
          </button>
          <button type="button" onClick={() => runInteraction("nod")}>
            <Smile size={15} />
            点点头
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
