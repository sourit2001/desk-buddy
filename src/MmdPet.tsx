import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Group,
  LoadingManager,
  LoopOnce,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
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
  gaze: { x: number; y: number };
  gazeFollowMouse: boolean;
};

type HelperMeshState = {
  mixer?: AnimationMixer;
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
  baseX: number;
  baseY: number;
  baseZ: number;
  previousX: number;
  previousY: number;
  previousZ: number;
};

type ProceduralRig = {
  root?: ProceduralBone;
  center?: ProceduralBone;
  groove?: ProceduralBone;
  head?: ProceduralBone;
  neck?: ProceduralBone;
  bothEyes?: ProceduralBone;
  rightEye?: ProceduralBone;
  leftEye?: ProceduralBone;
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

type BoneRestPose = {
  bone: SkinnedMesh["skeleton"]["bones"][number];
  positionX: number;
  positionY: number;
  positionZ: number;
  quaternionX: number;
  quaternionY: number;
  quaternionZ: number;
  quaternionW: number;
};

type BlinkMorphTarget = {
  influences: number[];
  index: number;
};

type MorphRestPose = {
  influences: number[];
  values: number[];
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

function formatLoadProgress(event?: ProgressEvent<EventTarget>) {
  if (!event || !event.lengthComputable || event.total <= 0) return "";
  return ` ${Math.round((event.loaded / event.total) * 100)}%`;
}

const zipBaseUrl = "mmdzip://model/";
const fileBaseUrl = "mmdfile://model/";
const fallbackTextureDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const builtInMotionUrls: Partial<Record<PetMood, string>> = {
  clicked: "/mmd-motions/petting.vmd",
  happy: "/mmd-motions/happy.vmd",
  thinking: "/mmd-motions/thinking.vmd",
  speaking: "/mmd-motions/happy.vmd",
  stretch: "/mmd-motions/stretch.vmd",
  hop: "/mmd-motions/happy.vmd",
  kiss: "/mmd-motions/kiss.vmd",
  chinRest: "/mmd-motions/thinking.vmd",
  work: "/mmd-motions/thinking.vmd",
};

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
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
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

function loadMmdMesh(
  loader: MMDLoader,
  source: MmdModelSource,
  onLoad: (mesh: SkinnedMesh) => void,
  onError: (error: unknown) => void,
  onProgress?: (event: ProgressEvent<EventTarget>) => void,
) {
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
    onProgress,
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
  const scale = Math.min((verticalView * 0.9) / height, (horizontalView * 0.88) / width) * modelScale;
  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -center.y * scale + verticalView * 0.1, -center.z * scale);

  return { height, scale, width };
}

function keepObjectInView(object: Group | SkinnedMesh, camera: PerspectiveCamera) {
  const bounds = new Box3().setFromObject(object);
  const size = new Vector3();
  const center = new Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const distance = Math.max(0.1, camera.position.z - center.z);
  const verticalView = 2 * Math.tan((camera.fov * Math.PI) / 360) * distance;
  const horizontalView = verticalView * camera.aspect;
  const paddingX = horizontalView * 0.08;
  const paddingTop = verticalView * 0.01;
  const paddingBottom = verticalView * 0.13;
  const minX = -horizontalView / 2 + paddingX;
  const maxX = horizontalView / 2 - paddingX;
  const minY = -verticalView / 2 + paddingBottom;
  const maxY = verticalView / 2 - paddingTop;
  let offsetX = 0;
  let offsetY = 0;

  if (size.x >= maxX - minX) {
    offsetX = -center.x;
  } else if (bounds.min.x < minX) {
    offsetX = minX - bounds.min.x;
  } else if (bounds.max.x > maxX) {
    offsetX = maxX - bounds.max.x;
  }

  if (size.y >= maxY - minY) {
    offsetY = (minY + maxY) / 2 - center.y;
  } else if (bounds.min.y < minY) {
    offsetY = minY - bounds.min.y;
  } else if (bounds.max.y > maxY) {
    offsetY = maxY - bounds.max.y;
  }

  object.position.x += offsetX;
  object.position.y += offsetY;
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
  return bone
    ? {
        bone,
        baseX: bone.rotation.x,
        baseY: bone.rotation.y,
        baseZ: bone.rotation.z,
        previousX: 0,
        previousY: 0,
        previousZ: 0,
      }
    : undefined;
}

function createProceduralRig(mesh: SkinnedMesh): ProceduralRig {
  return {
    root: createProceduralBone(mesh, ["全ての親", "全親", "root", "Root", "全親ボーン"]),
    center: createProceduralBone(mesh, ["センター", "中心", "center", "Center"]),
    groove: createProceduralBone(mesh, ["グルーブ", "groove", "Groove"]),
    head: createProceduralBone(mesh, ["頭", "head", "Head"]),
    neck: createProceduralBone(mesh, ["首", "neck", "Neck"]),
    bothEyes: createProceduralBone(mesh, ["両目", "両眼", "eyes", "Eyes", "BothEyes", "Both_eyes"]),
    rightEye: createProceduralBone(mesh, ["右目", "右眼", "right eye", "RightEye", "Right_eye"]),
    leftEye: createProceduralBone(mesh, ["左目", "左眼", "left eye", "LeftEye", "Left_eye"]),
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

function captureRestPose(mesh: SkinnedMesh): BoneRestPose[] {
  return (
    mesh.skeleton?.bones.map((bone) => ({
      bone,
      positionX: bone.position.x,
      positionY: bone.position.y,
      positionZ: bone.position.z,
      quaternionX: bone.quaternion.x,
      quaternionY: bone.quaternion.y,
      quaternionZ: bone.quaternion.z,
      quaternionW: bone.quaternion.w,
    })) ?? []
  );
}

function restoreRestPose(restPose: BoneRestPose[]) {
  restPose.forEach((pose) => {
    pose.bone.position.set(pose.positionX, pose.positionY, pose.positionZ);
    pose.bone.quaternion.set(pose.quaternionX, pose.quaternionY, pose.quaternionZ, pose.quaternionW);
    pose.bone.updateMatrixWorld(true);
  });
}

function captureMorphRestPose(mesh: SkinnedMesh): MorphRestPose[] {
  const restPose: MorphRestPose[] = [];

  mesh.traverse((child) => {
    const morphMesh = child as Mesh & { morphTargetInfluences?: number[] };
    if (morphMesh.morphTargetInfluences) {
      restPose.push({ influences: morphMesh.morphTargetInfluences, values: [...morphMesh.morphTargetInfluences] });
    }
  });

  return restPose;
}

function restoreMorphRestPose(restPose: MorphRestPose[]) {
  restPose.forEach((pose) => {
    pose.values.forEach((value, index) => {
      pose.influences[index] = value;
    });
  });
}

function findBlinkMorphTargets(mesh: SkinnedMesh): BlinkMorphTarget[] {
  const blinkNames = ["まばたき", "瞬き", "blink", "Blink", "BLINK", "eyeclose", "EyeClose", "eye close"];
  const targets: BlinkMorphTarget[] = [];

  mesh.traverse((child) => {
    const morphMesh = child as Mesh & {
      morphTargetDictionary?: Record<string, number>;
      morphTargetInfluences?: number[];
    };
    if (!morphMesh.morphTargetDictionary || !morphMesh.morphTargetInfluences) return;

    const match = blinkNames
      .map((name) => morphMesh.morphTargetDictionary?.[name])
      .find((index): index is number => typeof index === "number");

    if (match !== undefined) {
      targets.push({ influences: morphMesh.morphTargetInfluences, index: match });
    }
  });

  return targets;
}

function applyBlinkMorph(targets: BlinkMorphTarget[], elapsed: number, blinkStartedAt: number) {
  if (!targets.length) return;
  const blinkElapsed = elapsed - blinkStartedAt;
  const closeDuration = 0.045;
  const openDuration = 0.085;
  const blinkDuration = closeDuration + openDuration;
  let value = 0;

  if (blinkElapsed >= 0 && blinkElapsed <= closeDuration) {
    value = smoothStep(blinkElapsed / closeDuration);
  } else if (blinkElapsed > closeDuration && blinkElapsed <= blinkDuration) {
    value = 1 - smoothStep((blinkElapsed - closeDuration) / openDuration);
  }

  targets.forEach((target) => {
    target.influences[target.index] = value;
  });
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
  bone.previousX += x;
  bone.previousY += y;
  bone.previousZ += z;
}

function resetProceduralRig(rig: ProceduralRig | null) {
  if (!rig) return;
  Object.values(rig).forEach(resetProceduralBone);
}

function smoothStep(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function addPoseBoneRotation(bone: ProceduralBone | undefined, weight: number, x = 0, y = 0, z = 0) {
  addProceduralBoneRotation(bone, x * weight, y * weight, z * weight);
}

function stabilizeFacing(rig: ProceduralRig | null) {
  if (!rig) return;

  [rig.root, rig.center, rig.groove].forEach((bone) => {
    if (!bone) return;
    const yaw = bone.bone.rotation.y;
    if (Math.abs(yaw) > 0.55) bone.bone.rotation.y -= yaw;
  });
}

function neutralizeEyePose(rig: ProceduralRig | null) {
  if (!rig) return;

  [rig.bothEyes, rig.leftEye, rig.rightEye].forEach((bone) => {
    if (!bone) return;
    bone.bone.rotation.x = bone.baseX;
    bone.bone.rotation.y = bone.baseY;
    bone.bone.rotation.z = bone.baseZ;
    bone.previousX = 0;
    bone.previousY = 0;
    bone.previousZ = 0;
  });
}

function applyProceduralRig(
  rig: ProceduralRig | null,
  mood: PetMood,
  elapsed: number,
  poseElapsed: number,
  intensity: number,
  gaze: { x: number; y: number },
) {
  if (!rig) return;

  const strength = Math.max(0.35, intensity);
  const gazeStrength = Math.min(1, 0.42 + strength * 0.38);
  const screenEyeLift = 0.58;
  const eyeGazeY = gaze.y + screenEyeLift;
  addProceduralBoneRotation(rig.neck, -gaze.y * 0.1 * gazeStrength, gaze.x * 0.18 * gazeStrength, 0);
  addProceduralBoneRotation(rig.head, -gaze.y * 0.26 * gazeStrength, gaze.x * 0.38 * gazeStrength, -gaze.x * 0.05 * gazeStrength);
  if (rig.bothEyes) {
    addProceduralBoneRotation(rig.bothEyes, eyeGazeY * 0.14 * gazeStrength, gaze.x * 0.26 * gazeStrength, 0);
  } else {
    addProceduralBoneRotation(rig.leftEye, eyeGazeY * 0.12 * gazeStrength, gaze.x * 0.22 * gazeStrength, 0);
    addProceduralBoneRotation(rig.rightEye, eyeGazeY * 0.12 * gazeStrength, gaze.x * 0.22 * gazeStrength, 0);
  }

  const poseWeight = smoothStep(poseElapsed / 0.72) * strength;
  const poseWave = Math.sin(poseElapsed * 2.2);
  const slowWave = Math.sin(poseElapsed * 1.25);

  if (mood === "idle") {
    addPoseBoneRotation(rig.upperBody, poseWeight, 0.025, 0, 0);
    addPoseBoneRotation(rig.upperBody2, poseWeight, 0.018, 0, 0);
    addPoseBoneRotation(rig.neck, poseWeight, -0.025, 0, 0);
    addPoseBoneRotation(rig.head, poseWeight, -0.035, 0, 0);
    addPoseBoneRotation(rig.rightArm, poseWeight, -0.2, -0.035, -0.08);
    addPoseBoneRotation(rig.leftArm, poseWeight, -0.2, 0.035, 0.08);
    addPoseBoneRotation(rig.rightElbow, poseWeight, -0.12, 0, 0.025);
    addPoseBoneRotation(rig.leftElbow, poseWeight, -0.12, 0, -0.025);
    addPoseBoneRotation(rig.rightWrist, poseWeight, -0.035, 0, -0.025);
    addPoseBoneRotation(rig.leftWrist, poseWeight, -0.035, 0, 0.025);
  } else if (mood === "greet" || mood === "kiss") {
    const wave = Math.sin(poseElapsed * 12);
    const sway = Math.sin(poseElapsed * 7);
    addPoseBoneRotation(rig.upperBody2 ?? rig.upperBody, poseWeight, 0, 0, sway * 0.07);
    addPoseBoneRotation(rig.rightArm, poseWeight, -0.58, 0.1, -0.34 + wave * 0.12);
    addPoseBoneRotation(rig.rightElbow, poseWeight, -0.62 + wave * 0.16, 0, 0);
    addPoseBoneRotation(rig.rightWrist, poseWeight, wave * 0.2, 0, wave * 0.2);
  } else if (mood === "nod") {
    const bob = Math.sin(poseElapsed * 10);
    addPoseBoneRotation(rig.neck, poseWeight, bob * 0.1, 0, 0);
    addPoseBoneRotation(rig.head, poseWeight, bob * 0.16, 0, 0);
    addPoseBoneRotation(rig.upperBody2 ?? rig.upperBody, poseWeight, bob * 0.04, 0, 0);
  } else if (mood === "walk") {
    const step = Math.sin(poseElapsed * 9);
    const lift = Math.abs(step);
    addPoseBoneRotation(rig.upperBody, poseWeight, 0.035, 0, step * 0.075);
    addPoseBoneRotation(rig.upperBody2, poseWeight, 0.018, 0, -step * 0.045);
    addPoseBoneRotation(rig.rightLeg, poseWeight, step * 0.3, 0, lift * 0.035);
    addPoseBoneRotation(rig.leftLeg, poseWeight, -step * 0.3, 0, -lift * 0.035);
    addPoseBoneRotation(rig.rightArm, poseWeight, -step * 0.2, 0, -0.04);
    addPoseBoneRotation(rig.leftArm, poseWeight, step * 0.2, 0, 0.04);
  } else if (mood === "chinRest") {
    addPoseBoneRotation(rig.upperBody, poseWeight, 0.1 + poseWave * 0.012, -0.035, -0.035);
    addPoseBoneRotation(rig.upperBody2, poseWeight, 0.075 + poseWave * 0.01, -0.025, -0.03);
    addPoseBoneRotation(rig.neck, poseWeight, 0.09 + poseWave * 0.018, 0.035 + slowWave * 0.012, -0.025);
    addPoseBoneRotation(rig.head, poseWeight, 0.13 + poseWave * 0.025, 0.06 + slowWave * 0.018, -0.08);
    addPoseBoneRotation(rig.rightArm, poseWeight, -0.48, -0.12, -0.26);
    addPoseBoneRotation(rig.rightElbow, poseWeight, -0.72, 0.05, 0.1 + poseWave * 0.025);
    addPoseBoneRotation(rig.rightWrist, poseWeight, -0.12 + poseWave * 0.025, -0.08, 0.14);
    addPoseBoneRotation(rig.leftArm, poseWeight, -0.18, 0.035, 0.1);
    addPoseBoneRotation(rig.leftElbow, poseWeight, -0.18, 0, 0.04);
  } else if (mood === "work") {
    const tap = Math.sin(poseElapsed * 16);
    const glance = Math.sin(poseElapsed * 2.7);
    addPoseBoneRotation(rig.upperBody, poseWeight, 0.09 + poseWave * 0.01, 0, 0);
    addPoseBoneRotation(rig.upperBody2, poseWeight, 0.06, glance * 0.025, 0);
    addPoseBoneRotation(rig.neck, poseWeight, 0.09 + poseWave * 0.012, glance * 0.045, 0);
    addPoseBoneRotation(rig.head, poseWeight, 0.14 + poseWave * 0.016, glance * 0.065, 0);
    addPoseBoneRotation(rig.rightArm, poseWeight, -0.42, -0.04, -0.1);
    addPoseBoneRotation(rig.leftArm, poseWeight, -0.42, 0.04, 0.1);
    addPoseBoneRotation(rig.rightElbow, poseWeight, -0.42, 0, 0.04);
    addPoseBoneRotation(rig.leftElbow, poseWeight, -0.42, 0, -0.04);
    addPoseBoneRotation(rig.rightWrist, poseWeight, tap * 0.09, 0, -0.045);
    addPoseBoneRotation(rig.leftWrist, poseWeight, -tap * 0.08, 0, 0.045);
  }
}

function setShadowCasting(object: Group | SkinnedMesh, castShadow: boolean, receiveShadow: boolean) {
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
  });
}

function getHelperMeshState(helper: MMDAnimationHelper, mesh: SkinnedMesh): HelperMeshState | undefined {
  return (helper as unknown as { objects: WeakMap<SkinnedMesh, HelperMeshState> }).objects.get(mesh);
}

function getOrCreateMixer(helper: MMDAnimationHelper, mesh: SkinnedMesh) {
  const state = getHelperMeshState(helper, mesh);
  if (!state) return null;
  if (!state.mixer) state.mixer = new AnimationMixer(mesh);
  return state.mixer;
}

function playMotionClip(helper: MMDAnimationHelper, mesh: SkinnedMesh | null, clip: AnimationClip | undefined, loop: boolean) {
  if (!mesh || !clip) return false;
  const mixer = getOrCreateMixer(helper, mesh);
  if (!mixer) return false;

  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset();
  action.enabled = true;
  action.clampWhenFinished = !loop;
  if (!loop) action.setLoop(LoopOnce, 1);
  action.play();
  return true;
}

function stopMotionClip(helper: MMDAnimationHelper, mesh: SkinnedMesh | null) {
  if (!mesh) return;
  const mixer = getOrCreateMixer(helper, mesh);
  if (!mixer) return;
  mixer.stopAllAction();
  mixer.update(0);
  mixer.uncacheRoot(mesh);
}

export function MmdPet({ modelDataUrl, modelPath, motionDataUrl, motionPath, motionName, modelName, modelScale, mood, intensity, gaze, gazeFollowMouse }: MmdPetProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const moodRef = useRef(mood);
  const gazeRef = useRef(gaze);
  const [status, setStatus] = useState(modelPath || modelDataUrl ? "加载 MMD" : "MMD 预览");

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    gazeRef.current = gaze;
  }, [gaze]);

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
    let restPose: BoneRestPose[] = [];
    let morphRestPose: MorphRestPose[] = [];
    let blinkMorphTargets: BlinkMorphTarget[] = [];
    let activeMesh: SkinnedMesh | null = null;
    let activeMotionMood: PetMood | null = null;
    let previousMotionMood: PetMood | null = null;
    let defaultMotionClip: AnimationClip | undefined;
    const builtInMotionClips = new Map<PetMood, AnimationClip>();
    const currentGaze = { x: 0, y: 0 };
    const idleLook = { x: 0, y: 0 };
    const idleLookTarget = { x: 0, y: 0 };
    let currentPoseMood: PetMood = moodRef.current;
    let poseStartedAt = 0;
    let nextIdleLookAt = 0;
    let blinkStartedAt = -10;
    let nextBlinkAt = 1.8 + Math.random() * 2.4;

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    camera.position.set(0, 0.25, 7.2);
    scene.add(new AmbientLight(0xffffff, 1.15));

    const keyLight = new DirectionalLight(0xffffff, 1.55);
    keyLight.position.set(2.4, 3.2, 4.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 12;
    keyLight.shadow.camera.left = -3.5;
    keyLight.shadow.camera.right = 3.5;
    keyLight.shadow.camera.top = 3.5;
    keyLight.shadow.camera.bottom = -3.5;
    scene.add(keyLight);

    const rimLight = new DirectionalLight(0x9fd8ff, 0.85);
    rimLight.position.set(-2.8, 2.4, -2.2);
    scene.add(rimLight);

    const groundShadow = new Mesh(
      new PlaneGeometry(3.2, 1.25),
      new ShadowMaterial({ color: 0x000000, opacity: 0.2, transparent: true }),
    );
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.set(0, -2.05, 0.05);
    groundShadow.receiveShadow = true;
    scene.add(groundShadow);

    scene.add(fallback);
    setShadowCasting(fallback, true, false);
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
      if (activeMesh && currentMood !== activeMotionMood) {
        previousMotionMood = activeMotionMood;
        activeMotionMood = currentMood;
        const clip = builtInMotionClips.get(currentMood);
        if (clip) {
          playMotionClip(helper, activeMesh, clip, false);
        } else if (currentMood === "idle") {
          stopMotionClip(helper, activeMesh);
        }
      }
      if (currentMood !== currentPoseMood) {
        currentPoseMood = currentMood;
        poseStartedAt = elapsed;
      }
      const poseElapsed = elapsed - poseStartedAt;
      const poseWeight = smoothStep(poseElapsed / 0.72);
      const moodBoost = currentMood === "speaking" || currentMood === "happy" || currentMood === "wiggle" ? 1.8 : 1;
      const motion = Math.max(0, intensity) * moodBoost;
      let rotationX = 0;
      let rotationY = 0;
      let rotationZ = 0;
      let positionX = 0;
      let positionY = activeBaseY;

      resetProceduralRig(proceduralRig);
      if (helper.meshes.length > 0) helper.update(delta);
      if (elapsed >= nextBlinkAt) {
        blinkStartedAt = elapsed;
        nextBlinkAt = elapsed + 2.2 + Math.random() * 3.6;
      }
      stabilizeFacing(proceduralRig);
      neutralizeEyePose(proceduralRig);
      if (currentMood === "idle" && elapsed >= nextIdleLookAt) {
        idleLookTarget.x = (Math.random() - 0.5) * 0.08;
        idleLookTarget.y = Math.random() * 0.06;
        nextIdleLookAt = elapsed + 1.8 + Math.random() * 2.4;
      } else if (currentMood !== "idle") {
        idleLookTarget.x = 0;
        idleLookTarget.y = 0;
      }
      idleLook.x += (idleLookTarget.x - idleLook.x) * Math.min(1, delta * 1.6);
      idleLook.y += (idleLookTarget.y - idleLook.y) * Math.min(1, delta * 1.6);
      const targetGaze = currentMood === "idle" && !gazeFollowMouse ? idleLook : gazeRef.current;
      currentGaze.x += (targetGaze.x - currentGaze.x) * Math.min(1, delta * 7);
      currentGaze.y += (targetGaze.y - currentGaze.y) * Math.min(1, delta * 7);

      if (currentMood === "walk") {
        positionX = Math.sin(poseElapsed * 8) * 0.12 * Math.max(0.3, intensity) * poseWeight;
        positionY = activeBaseY + Math.abs(Math.sin(poseElapsed * 8)) * 0.055 * Math.max(0.3, intensity) * poseWeight;
        rotationY = Math.sin(poseElapsed * 8) * 0.16 * Math.max(0.3, intensity) * poseWeight;
        rotationZ = Math.sin(poseElapsed * 8) * 0.055 * Math.max(0.3, intensity) * poseWeight;
      } else if (currentMood === "greet" || currentMood === "kiss") {
        rotationY = Math.sin(poseElapsed * 9) * 0.24 * Math.max(0.3, intensity) * poseWeight;
        rotationZ = Math.sin(poseElapsed * 9) * 0.075 * Math.max(0.3, intensity) * poseWeight;
        positionY = activeBaseY + Math.sin(poseElapsed * 7) * 0.035 * Math.max(0.3, intensity) * poseWeight;
      } else if (currentMood === "nod") {
        rotationX = Math.sin(poseElapsed * 10) * 0.13 * Math.max(0.3, intensity) * poseWeight;
        positionY = activeBaseY + Math.sin(poseElapsed * 10) * 0.03 * Math.max(0.3, intensity) * poseWeight;
      } else if (currentMood === "chinRest") {
        rotationY = (-0.06 + Math.sin(poseElapsed * 1.8) * 0.018 * Math.max(0.3, intensity)) * poseWeight;
        rotationZ = -0.025 * poseWeight;
        positionY = activeBaseY + (-0.02 + Math.sin(poseElapsed * 2.2) * 0.009 * Math.max(0.3, intensity)) * poseWeight;
      } else if (currentMood === "work") {
        rotationX = (-0.025 + Math.sin(poseElapsed * 4.2) * 0.012 * Math.max(0.3, intensity)) * poseWeight;
        rotationY = Math.sin(poseElapsed * 2.7) * 0.055 * Math.max(0.3, intensity) * poseWeight;
        positionY = activeBaseY + Math.sin(poseElapsed * 10) * 0.007 * Math.max(0.3, intensity) * poseWeight;
      }

      activeObject.position.x = positionX;
      activeObject.position.y = positionY;
      activeObject.rotation.x = rotationX;
      activeObject.rotation.y = rotationY;
      activeObject.rotation.z = rotationZ;
      applyProceduralRig(proceduralRig, currentMood, elapsed, poseElapsed, intensity, currentGaze);
      applyBlinkMorph(blinkMorphTargets, elapsed, blinkStartedAt);
      keepObjectInView(activeObject, camera);
      groundShadow.position.x = activeObject.position.x;
      groundShadow.position.y = activeBaseY - 0.02;
      groundShadow.scale.setScalar(1 + Math.abs(positionY - activeBaseY) * 0.35);
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    render();

    if (modelPath || modelDataUrl) {
      const motionLabel = motionName || "motion.vmd";
      setStatus("准备 MMD 资源");
      Promise.all([resolveAssetSource(modelPath, modelDataUrl), resolveAssetSource(motionPath, motionDataUrl)])
        .then(([modelSource, motionSource]) => prepareMmdSource(modelSource, motionSource, modelName))
        .then((preparedSource) => {
          if (disposed) {
            preparedSource.dispose();
            return;
          }

          source = preparedSource;
          setStatus(`正在加载模型：${preparedSource.modelLabel}`);
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
                setShadowCasting(mesh, true, true);
                scene.add(mesh);
                activeObject = mesh;
                activeMesh = mesh;
                activeBaseY = mesh.position.y;
                proceduralRig = createProceduralRig(mesh);
                restPose = captureRestPose(mesh);
                morphRestPose = captureMorphRestPose(mesh);
                blinkMorphTargets = findBlinkMorphTargets(mesh);
                const proceduralBoneCount = getProceduralBoneCount(proceduralRig);
                setStatus(`模型已显示，贴图 ${appliedTextures}/${materialStats.materialCount}`);

                helper.add(mesh, { physics: false });

                Object.entries(builtInMotionUrls).forEach(([motionMood, motionUrl]) => {
                  loader.loadAnimation(
                    motionUrl,
                    mesh,
                    (animation) => {
                      if (disposed) return;
                      builtInMotionClips.set(motionMood as PetMood, animation as AnimationClip);
                      setStatus(`内置动作 ${builtInMotionClips.size}/${Object.keys(builtInMotionUrls).length}，关节补动 ${proceduralBoneCount}`);
                    },
                    undefined,
                    () => undefined,
                  );
                });

                if (preparedSource.motionUrl) {
                  setStatus(`正在解析动作：${motionLabel}`);
                  loader.loadAnimation(
                    preparedSource.motionUrl,
                    mesh,
                    (animation) => {
                      if (disposed) return;
                      defaultMotionClip = animation as AnimationClip;
                      setStatus(`动作已加载：${motionLabel}，关节补动 ${proceduralBoneCount}`);
                    },
                    (event) => {
                      if (!disposed) setStatus(`正在读取动作：${motionLabel}${formatLoadProgress(event)}`);
                    },
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
            (event) => {
              if (!disposed) setStatus(`正在读取模型：${preparedSource.modelLabel}${formatLoadProgress(event)}`);
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
  }, [modelDataUrl, modelPath, motionDataUrl, motionPath, motionName, modelName, modelScale, intensity, gazeFollowMouse]);

  return <div className="mmd-stage" ref={mountRef} aria-label={status} />;
}
