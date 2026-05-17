import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Group,
  LoadingManager,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
  TextureLoader,
  WebGLRenderer,
  DoubleSide,
  Texture,
} from "three";
import JSZip from "jszip";
import { MMDAnimationHelper, MMDLoader } from "three-stdlib";
import { isTauriRuntime } from "./tauriRuntime";
import { PetMood } from "./types";

type MmdPetProps = {
  modelDataUrl: string;
  modelPath: string;
  motionDataUrl: string;
  motionPath: string;
  motionName: string;
  modelName: string;
  modelScale: number;
  mood: PetMood;
  intensity: number;
};

type MmdModelSource = {
  manager: LoadingManager;
  modelUrl: string;
  motionUrl: string;
  modelLabel: string;
  resourcePath: string;
  textureUrls: Map<string, string>;
  dispose: () => void;
};

type ProceduralBone = {
  bone: SkinnedMesh["skeleton"]["bones"][number];
  previousX: number;
  previousY: number;
  previousZ: number;
};

type ProceduralRig = {
  head?: ProceduralBone;
  neck?: ProceduralBone;
  upperBody?: ProceduralBone;
  upperBody2?: ProceduralBone;
  rightArm?: ProceduralBone;
  rightElbow?: ProceduralBone;
  rightWrist?: ProceduralBone;
  leftArm?: ProceduralBone;
  leftElbow?: ProceduralBone;
  leftWrist?: ProceduralBone;
  rightLeg?: ProceduralBone;
  leftLeg?: ProceduralBone;
};

function formatMmdError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const event = error as ErrorEvent & { type?: string; target?: { src?: string; responseURL?: string } };
    return event.message || event.target?.src || event.target?.responseURL || event.type || "未知错误";
  }
  return "未知错误";
}

const zipBaseUrl = "mmdzip://model/";
const fileBaseUrl = "mmdfile://model/";
const fallbackTextureDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function isMmdModelFile(file: JSZip.JSZipObject) {
  if (/\.(pmx|pmd)$/i.test(file.name)) return true;

  const bytes = new Uint8Array(await file.async("uint8array"));
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  return signature === "PMX " || signature.startsWith("Pmd");
}

function dataUrlToArrayBuffer(dataUrl: string) {
  return fetch(dataUrl).then((response) => response.arrayBuffer());
}

function getFileExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function getMimeType(name: string) {
  const extension = getFileExtension(name);
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "bmp") return "image/bmp";
  if (extension === "tga") return "image/x-tga";
  return "application/octet-stream";
}

function shouldUseFallbackTexture(path: string) {
  return /\.(bmp|tga)$/i.test(path);
}

function normalizeZipPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function getPathBaseName(path: string) {
  return normalizeZipPath(path).split("/").pop() ?? path;
}

function getDisplayFileName(path: string) {
  return getPathBaseName(path).replace(/^\d+-/, "");
}

function isZipSource(nameOrPath: string) {
  return getDisplayFileName(nameOrPath).toLowerCase().endsWith(".zip");
}

function toRelativePath(path: string, root: string) {
  const normalized = normalizeZipPath(path);
  return root && normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

async function prepareMmdSource(modelDataUrl: string, motionDataUrl: string, modelName: string): Promise<MmdModelSource> {
  const manager = new LoadingManager();
  const objectUrls = new Map<string, string>();
  const lowerCaseObjectUrls = new Map<string, string>();
  const textureUrls = new Map<string, string>();
  const dispose = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    lowerCaseObjectUrls.clear();
  };

  if (isZipSource(modelName)) {
    const zip = await JSZip.loadAsync(await dataUrlToArrayBuffer(modelDataUrl));
    const files = Object.values(zip.files).filter((file) => !file.dir);
    let modelFile = files.find((file) => /\.(pmx|pmd)$/i.test(file.name));
    if (!modelFile) {
      const modelCandidates = await Promise.all(files.map(async (file) => ((await isMmdModelFile(file)) ? file : null)));
      modelFile = modelCandidates.find(Boolean) ?? undefined;
    }
    if (!modelFile) throw new Error("zip 里没有找到 .pmx 或 .pmd 模型文件");

    const modelRoot = normalizeZipPath(modelFile.name).replace(/[^/]+$/, "");
    const modelExtension = getFileExtension(modelFile.name) || "pmx";
    const modelAlias = `model.${modelExtension}`;
    await Promise.all(
      files.map(async (file) => {
        const relativePath = toRelativePath(file.name, modelRoot);
        const blob = await file.async("blob");
        const objectUrl = URL.createObjectURL(new Blob([blob], { type: getMimeType(file.name) }));
        objectUrls.set(relativePath, objectUrl);
        lowerCaseObjectUrls.set(relativePath.toLowerCase(), objectUrl);
        textureUrls.set(relativePath, objectUrl);
        textureUrls.set(relativePath.toLowerCase(), objectUrl);
        textureUrls.set(getPathBaseName(relativePath), objectUrl);
        textureUrls.set(getPathBaseName(relativePath).toLowerCase(), objectUrl);
        if (file.name === modelFile.name) {
          objectUrls.set(modelAlias, objectUrl);
          lowerCaseObjectUrls.set(modelAlias, objectUrl);
        }
      }),
    );

    manager.setURLModifier((url) => {
      const relativePath = normalizeZipPath(url.startsWith(zipBaseUrl) ? url.slice(zipBaseUrl.length) : url);
      if (shouldUseFallbackTexture(relativePath)) return fallbackTextureDataUrl;
      return objectUrls.get(relativePath) ?? lowerCaseObjectUrls.get(relativePath.toLowerCase()) ?? url;
    });

    const modelUrl = `${zipBaseUrl}${modelAlias}`;
    const zipMotion = files.find((file) => /\.vmd$/i.test(file.name));
    let motionUrl = motionDataUrl;
    if (!motionUrl && zipMotion) {
      const motionBlobUrl = objectUrls.get(toRelativePath(zipMotion.name, modelRoot));
      if (motionBlobUrl) {
        objectUrls.set("motion.vmd", motionBlobUrl);
        lowerCaseObjectUrls.set("motion.vmd", motionBlobUrl);
        motionUrl = `${zipBaseUrl}motion.vmd`;
      }
    }
    return { manager, modelUrl, motionUrl, modelLabel: toRelativePath(modelFile.name, modelRoot) || getDisplayFileName(modelName), resourcePath: zipBaseUrl, textureUrls, dispose };
  }

  const extension = getFileExtension(modelName);
  const modelBlobUrl = URL.createObjectURL(new Blob([await dataUrlToArrayBuffer(modelDataUrl)], { type: "application/octet-stream" }));
  objectUrls.set(`model.${extension}`, modelBlobUrl);

  let motionUrl = motionDataUrl;
  if (motionDataUrl) {
    const motionBlobUrl = URL.createObjectURL(new Blob([await dataUrlToArrayBuffer(motionDataUrl)], { type: "application/octet-stream" }));
    objectUrls.set("motion.vmd", motionBlobUrl);
    motionUrl = `${fileBaseUrl}motion.vmd`;
  }

  manager.setURLModifier((url) => {
    const relativePath = normalizeZipPath(url.startsWith(fileBaseUrl) ? url.slice(fileBaseUrl.length) : url);
    if (shouldUseFallbackTexture(relativePath)) return fallbackTextureDataUrl;
    return objectUrls.get(relativePath) ?? url;
  });

  return { manager, modelUrl: `${fileBaseUrl}model.${extension}`, motionUrl, modelLabel: `model.${extension}`, resourcePath: fileBaseUrl, textureUrls, dispose };
}

function loadMmdMesh(loader: MMDLoader, source: MmdModelSource, onLoad: (mesh: SkinnedMesh) => void, onError: (error: unknown) => void) {
  const extension = getFileExtension(source.modelUrl);
  const loadModelData = extension === "pmd" ? loader.loadPMD.bind(loader) : loader.loadPMX.bind(loader);

  loadModelData(
    source.modelUrl,
    (data) => {
      try {
        const meshBuilder = (loader as unknown as { meshBuilder: { setCrossOrigin: (crossOrigin: string) => { build: (...args: unknown[]) => SkinnedMesh } } }).meshBuilder;
        const crossOrigin = (loader as unknown as { crossOrigin: string }).crossOrigin;
        const mesh = meshBuilder.setCrossOrigin(crossOrigin).build(data, source.resourcePath, undefined, onError);
        const modelData = data as {
          materials?: Array<{ textureIndex?: number }>;
          textures?: string[];
        };
        mesh.userData.materialTextureUrls = modelData.materials?.map((material) => {
          if (material.textureIndex === undefined || material.textureIndex < 0) return "";
          const texturePath = normalizeZipPath(modelData.textures?.[material.textureIndex] ?? "");
          const textureBaseName = getPathBaseName(texturePath);
          return (
            source.textureUrls.get(texturePath) ??
            source.textureUrls.get(texturePath.toLowerCase()) ??
            source.textureUrls.get(textureBaseName) ??
            source.textureUrls.get(textureBaseName.toLowerCase()) ??
            ""
          );
        });
        onLoad(mesh);
      } catch (error) {
        onError(error);
      }
    },
    undefined,
    onError,
  );
}

async function resolveAssetSource(path: string, dataUrl: string) {
  if (path && isTauriRuntime()) return invoke<string>("read_mmd_asset", { path });
  return dataUrl;
}

function fitObjectToView(object: Group | SkinnedMesh, camera: PerspectiveCamera, modelScale: number) {
  object.rotation.set(0, 0, 0);
  object.scale.setScalar(1);

  const bounds = new Box3().setFromObject(object);
  const size = new Vector3();
  const center = new Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const height = Math.max(size.y, 0.001);
  const width = Math.max(size.x, 0.001);
  const distance = camera.position.z;
  const verticalView = 2 * Math.tan((camera.fov * Math.PI) / 360) * distance;
  const horizontalView = verticalView * camera.aspect;
  const scale = Math.min((verticalView * 0.82) / height, (horizontalView * 0.82) / width) * modelScale;
  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -center.y * scale - verticalView * 0.03, -center.z * scale);

  return { height, scale, width };
}

function createFallbackModel() {
  const group = new Group();
  const body = new Mesh(
    new BoxGeometry(0.85, 1.45, 0.45),
    new MeshStandardMaterial({ color: new Color("#6fc29a"), roughness: 0.55, metalness: 0.05 }),
  );
  const head = new Mesh(
    new BoxGeometry(0.95, 0.75, 0.52),
    new MeshStandardMaterial({ color: new Color("#f3d4b7"), roughness: 0.65 }),
  );
  const hair = new Mesh(
    new BoxGeometry(1.02, 0.32, 0.56),
    new MeshStandardMaterial({ color: new Color("#2f3a35"), roughness: 0.7 }),
  );

  body.position.y = -0.55;
  head.position.y = 0.65;
  hair.position.y = 1.05;
  group.add(body, head, hair);
  return group;
}

function createEnhancedTexture(texture: Texture) {
  const image = texture.image as CanvasImageSource | undefined;
  if (!image || !("width" in image) || !("height" in image) || !image.width || !image.height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Number(image.width);
  canvas.height = Number(image.height);

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  let luminanceSum = 0;

  for (let index = 0; index < data.length; index += 4) {
    luminanceSum += data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
  }

  const averageLuminance = luminanceSum / Math.max(1, data.length / 4);
  const gain = averageLuminance < 45 ? 1.55 : averageLuminance < 95 ? 1.22 : 1;
  const lift = averageLuminance < 45 ? 16 : averageLuminance < 95 ? 8 : 0;

  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.min(255, data[index] * gain + lift);
    data[index + 1] = Math.min(255, data[index + 1] * gain + lift);
    data[index + 2] = Math.min(255, data[index + 2] * gain + lift);
    data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);

  const enhancedTexture = new CanvasTexture(canvas);
  enhancedTexture.flipY = false;
  enhancedTexture.colorSpace = SRGBColorSpace;
  enhancedTexture.needsUpdate = true;
  return enhancedTexture;
}

function setEnhancedTextureWhenReady(material: MeshBasicMaterial, texture: Texture, onApplied?: () => void) {
  let attempts = 0;

  const applyTexture = () => {
    const enhancedTexture = createEnhancedTexture(texture);
    if (!enhancedTexture) {
      attempts += 1;
      if (attempts < 180) window.requestAnimationFrame(applyTexture);
      return;
    }
    material.map = enhancedTexture;
    material.color.set("#ffffff");
    material.needsUpdate = true;
    onApplied?.();
  };

  applyTexture();

  const textureWithCallbacks = texture as Texture & { readyCallbacks?: Array<() => void> };
  if (textureWithCallbacks.readyCallbacks) {
    textureWithCallbacks.readyCallbacks.push(applyTexture);
  }
}

function fixMmdMaterials(object: Group | SkinnedMesh, onTextureApplied?: () => void) {
  let materialCount = 0;
  let existingMaps = 0;
  let directTextureUrls = 0;
  const materialTextureUrls = object.userData.materialTextureUrls as string[] | undefined;
  const textureLoader = new TextureLoader();

  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.visible = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materialCount += materials.length;

    const fixedMaterials = materials.map((material, materialIndex) => {
      const fixedMaterial = material as Material & {
        color?: Color;
        map?: Texture | null;
        opacity?: number;
        transparent?: boolean;
        name?: string;
      };
      if (fixedMaterial.map) {
        existingMaps += 1;
        fixedMaterial.map.flipY = false;
        fixedMaterial.map.colorSpace = SRGBColorSpace;
        fixedMaterial.map.needsUpdate = true;
      }

      const fallbackColor = fixedMaterial.color?.clone() ?? new Color("#d9b38c");
      if (fallbackColor.r + fallbackColor.g + fallbackColor.b < 0.18) fallbackColor.set("#d9b38c");

      const materialCompat = new MeshBasicMaterial({
        name: fixedMaterial.name,
        color: fallbackColor,
        map: null,
        side: DoubleSide,
        transparent: false,
        opacity: 1,
        alphaTest: 0,
        depthWrite: true,
        toneMapped: false,
      });

      const directTextureUrl = materialTextureUrls?.[materialIndex];
      if (directTextureUrl) {
        directTextureUrls += 1;
        textureLoader.load(directTextureUrl, (texture) => {
          texture.flipY = false;
          texture.colorSpace = SRGBColorSpace;
          setEnhancedTextureWhenReady(materialCompat, texture, onTextureApplied);
        });
      } else if (fixedMaterial.map) {
        setEnhancedTextureWhenReady(materialCompat, fixedMaterial.map, onTextureApplied);
      }

      return materialCompat;
    });

    mesh.material = Array.isArray(mesh.material) ? fixedMaterials : fixedMaterials[0];
    mesh.frustumCulled = false;
  });

  return { materialCount, existingMaps, directTextureUrls };
}

function createProceduralBone(mesh: SkinnedMesh, names: string[]): ProceduralBone | undefined {
  const bone = mesh.skeleton?.bones.find((candidate) => names.includes(candidate.name));
  return bone ? { bone, previousX: 0, previousY: 0, previousZ: 0 } : undefined;
}

function createProceduralRig(mesh: SkinnedMesh): ProceduralRig {
  return {
    head: createProceduralBone(mesh, ["頭", "head", "Head"]),
    neck: createProceduralBone(mesh, ["首", "neck", "Neck"]),
    upperBody: createProceduralBone(mesh, ["上半身", "upper body", "UpperBody", "Spine"]),
    upperBody2: createProceduralBone(mesh, ["上半身2", "upper body2", "UpperBody2", "Chest"]),
    rightArm: createProceduralBone(mesh, ["右腕", "右腕捩", "right arm", "RightArm", "Right_arm"]),
    rightElbow: createProceduralBone(mesh, ["右ひじ", "right elbow", "RightForeArm", "Right_forearm"]),
    rightWrist: createProceduralBone(mesh, ["右手首", "right wrist", "RightHand", "Right_hand"]),
    leftArm: createProceduralBone(mesh, ["左腕", "左腕捩", "left arm", "LeftArm", "Left_arm"]),
    leftElbow: createProceduralBone(mesh, ["左ひじ", "left elbow", "LeftForeArm", "Left_forearm"]),
    leftWrist: createProceduralBone(mesh, ["左手首", "left wrist", "LeftHand", "Left_hand"]),
    rightLeg: createProceduralBone(mesh, ["右足", "right leg", "RightUpLeg", "Right_leg"]),
    leftLeg: createProceduralBone(mesh, ["左足", "left leg", "LeftUpLeg", "Left_leg"]),
  };
}

function getProceduralBoneCount(rig: ProceduralRig) {
  return Object.values(rig).filter(Boolean).length;
}

function resetProceduralBone(bone?: ProceduralBone) {
  if (!bone) return;
  bone.bone.rotation.x -= bone.previousX;
  bone.bone.rotation.y -= bone.previousY;
  bone.bone.rotation.z -= bone.previousZ;
  bone.previousX = 0;
  bone.previousY = 0;
  bone.previousZ = 0;
}

function addProceduralBoneRotation(bone: ProceduralBone | undefined, x = 0, y = 0, z = 0) {
  if (!bone) return;
  bone.bone.rotation.x += x;
  bone.bone.rotation.y += y;
  bone.bone.rotation.z += z;
  bone.previousX = x;
  bone.previousY = y;
  bone.previousZ = z;
}

function resetProceduralRig(rig: ProceduralRig | null) {
  if (!rig) return;
  Object.values(rig).forEach(resetProceduralBone);
}

function applyProceduralRig(rig: ProceduralRig | null, mood: PetMood, elapsed: number, intensity: number) {
  if (!rig) return;

  const strength = Math.max(0.35, intensity);
  if (mood === "greet") {
    const wave = Math.sin(elapsed * 12);
    const sway = Math.sin(elapsed * 7);
    addProceduralBoneRotation(rig.upperBody2 ?? rig.upperBody, 0, 0, sway * 0.08 * strength);
    addProceduralBoneRotation(rig.rightArm, -0.75 * strength, 0.15 * strength, -0.45 * strength + wave * 0.16 * strength);
    addProceduralBoneRotation(rig.rightElbow, -0.82 * strength + wave * 0.2 * strength, 0, 0);
    addProceduralBoneRotation(rig.rightWrist, wave * 0.28 * strength, 0, wave * 0.25 * strength);
  } else if (mood === "nod") {
    const bob = Math.sin(elapsed * 10);
    addProceduralBoneRotation(rig.neck, bob * 0.13 * strength, 0, 0);
    addProceduralBoneRotation(rig.head, bob * 0.2 * strength, 0, 0);
    addProceduralBoneRotation(rig.upperBody2 ?? rig.upperBody, bob * 0.05 * strength, 0, 0);
  } else if (mood === "walk") {
    const step = Math.sin(elapsed * 9);
    addProceduralBoneRotation(rig.upperBody, 0, 0, step * 0.06 * strength);
    addProceduralBoneRotation(rig.rightLeg, step * 0.24 * strength, 0, 0);
    addProceduralBoneRotation(rig.leftLeg, -step * 0.24 * strength, 0, 0);
    addProceduralBoneRotation(rig.rightArm, -step * 0.14 * strength, 0, 0);
    addProceduralBoneRotation(rig.leftArm, step * 0.14 * strength, 0, 0);
  }
}

export function MmdPet({ modelDataUrl, modelPath, motionDataUrl, motionPath, motionName, modelName, modelScale, mood, intensity }: MmdPetProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const moodRef = useRef(mood);
  const [status, setStatus] = useState(modelPath || modelDataUrl ? "加载 MMD" : "MMD 预览");

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new Scene();
    const camera = new PerspectiveCamera(28, 1, 0.1, 100);
    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    const clock = new Clock();
    const helper = new MMDAnimationHelper({ afterglow: 0 });
    const fallback = createFallbackModel();
    let activeObject: Group | SkinnedMesh = fallback;
    let activeBaseY = -1;
    let disposed = false;
    let animationFrame = 0;
    let source: MmdModelSource | null = null;
    let proceduralRig: ProceduralRig | null = null;

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    camera.position.set(0, 0.25, 7.2);
    scene.add(new AmbientLight(0xffffff, 1.15));

    const keyLight = new DirectionalLight(0xffffff, 1.55);
    keyLight.position.set(2.4, 3.2, 4.2);
    scene.add(keyLight);

    const rimLight = new DirectionalLight(0x9fd8ff, 0.85);
    rimLight.position.set(-2.8, 2.4, -2.2);
    scene.add(rimLight);

    scene.add(fallback);
    fitObjectToView(fallback, camera, modelScale);
    activeBaseY = fallback.position.y;

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const render = () => {
      const delta = clock.getDelta();
      const elapsed = clock.elapsedTime;
      const currentMood = moodRef.current;
      const moodBoost = currentMood === "speaking" || currentMood === "wiggle" ? 1.8 : 1;
      const motion = Math.max(0, intensity) * moodBoost;
      let rotationX = 0;
      let rotationY = Math.sin(elapsed * 0.8) * 0.16 * motion;
      let rotationZ = 0;
      let positionX = 0;
      let positionY = activeBaseY + Math.sin(elapsed * 2.2) * 0.035 * motion;

      resetProceduralRig(proceduralRig);
      if (helper.meshes.length > 0) helper.update(delta);

      if (currentMood === "walk") {
        positionX = Math.sin(elapsed * 8) * 0.18 * Math.max(0.3, intensity);
        positionY = activeBaseY + Math.abs(Math.sin(elapsed * 8)) * 0.08 * Math.max(0.3, intensity);
        rotationY = Math.sin(elapsed * 8) * 0.22 * Math.max(0.3, intensity);
        rotationZ = Math.sin(elapsed * 8) * 0.08 * Math.max(0.3, intensity);
      } else if (currentMood === "greet") {
        rotationY = Math.sin(elapsed * 9) * 0.34 * Math.max(0.3, intensity);
        rotationZ = Math.sin(elapsed * 9) * 0.11 * Math.max(0.3, intensity);
        positionY = activeBaseY + Math.sin(elapsed * 7) * 0.045 * Math.max(0.3, intensity);
      } else if (currentMood === "nod") {
        rotationX = Math.sin(elapsed * 10) * 0.18 * Math.max(0.3, intensity);
        positionY = activeBaseY + Math.sin(elapsed * 10) * 0.045 * Math.max(0.3, intensity);
      }

      activeObject.position.x = positionX;
      activeObject.position.y = positionY;
      activeObject.rotation.x = rotationX;
      activeObject.rotation.y = rotationY;
      activeObject.rotation.z = rotationZ;
      applyProceduralRig(proceduralRig, currentMood, elapsed, intensity);
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    render();

    if (modelPath || modelDataUrl) {
      setStatus("加载 MMD");
      Promise.all([resolveAssetSource(modelPath, modelDataUrl), resolveAssetSource(motionPath, motionDataUrl)])
        .then(([modelSource, motionSource]) => prepareMmdSource(modelSource, motionSource, modelName))
        .then((preparedSource) => {
          if (disposed) {
            preparedSource.dispose();
            return;
          }

          source = preparedSource;
          setStatus(`加载 ${preparedSource.modelLabel}`);
          const loader = new MMDLoader(preparedSource.manager);
          loader.setResourcePath(isZipSource(modelName) ? zipBaseUrl : fileBaseUrl);
          loadMmdMesh(
            loader,
            preparedSource,
            (mesh) => {
              try {
                if (disposed) return;
                scene.remove(fallback);
                const fit = fitObjectToView(mesh, camera, modelScale);
                let appliedTextures = 0;
                const materialStats = fixMmdMaterials(mesh, () => {
                  appliedTextures += 1;
                  if (!disposed) setStatus(`m${materialStats.materialCount} u${materialStats.directTextureUrls} a${appliedTextures}`);
                });
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                scene.add(mesh);
                activeObject = mesh;
                activeBaseY = mesh.position.y;
                proceduralRig = createProceduralRig(mesh);
                const proceduralBoneCount = getProceduralBoneCount(proceduralRig);
                setStatus(`m${materialStats.materialCount} u${materialStats.directTextureUrls} a${appliedTextures}`);

                if (preparedSource.motionUrl) {
                  loader.loadAnimation(
                    preparedSource.motionUrl,
                    mesh,
                    (animation) => {
                      if (disposed) return;
                      helper.add(mesh, { animation, physics: false });
                      setStatus(`动作已加载：${motionName || "motion.vmd"}，关节补动 ${proceduralBoneCount}`);
                    },
                    undefined,
                    (error) => {
                      if (!disposed) setStatus(`动作加载失败：${formatMmdError(error)}`);
                    },
                  );
                } else if (!disposed) {
                  setStatus(`未选择 VMD，使用程序化关节动作 ${proceduralBoneCount}`);
                }
              } catch (error) {
                if (!disposed) setStatus(`模型显示失败：${formatMmdError(error)}`);
              }
            },
            (error) => {
              if (!disposed) setStatus(`模型加载失败：${formatMmdError(error)}`);
            },
          );
        })
        .catch((error) => {
          if (!disposed) setStatus(`模型准备失败：${formatMmdError(error)}`);
        });
    }

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      helper.meshes.slice().forEach((mesh) => helper.remove(mesh));
      renderer.dispose();
      renderer.domElement.remove();
      scene.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      source?.dispose();
    };
  }, [modelDataUrl, modelPath, motionDataUrl, motionPath, motionName, modelName, modelScale, intensity]);

  return (
    <div className="mmd-stage" ref={mountRef} aria-label={status}>
      <span>{status}</span>
    </div>
  );
}
