type Rgb = {
  r: number;
  g: number;
  b: number;
};

type Pixel = {
  x: number;
  y: number;
};

export async function removeImageBackground(dataUrl: string, tolerance: number): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return dataUrl;

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const background = sampleBackground(imageData.data, canvas.width, canvas.height);
  removeConnectedBackground(imageData.data, canvas.width, canvas.height, background, tolerance);
  context.putImageData(imageData, 0, 0);

  return canvas.toDataURL("image/png");
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = dataUrl;
  });
}

function sampleBackground(data: Uint8ClampedArray, width: number, height: number): Rgb {
  const sampleSize = Math.min(12, Math.floor(Math.min(width, height) / 4));
  const corners: Pixel[] = [];

  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      corners.push({ x, y });
      corners.push({ x: width - 1 - x, y });
      corners.push({ x, y: height - 1 - y });
      corners.push({ x: width - 1 - x, y: height - 1 - y });
    }
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (const pixel of corners) {
    const index = pixelIndex(pixel.x, pixel.y, width);
    if (data[index + 3] < 12) continue;
    r += data[index];
    g += data[index + 1];
    b += data[index + 2];
    count += 1;
  }

  if (!count) return { r: 255, g: 255, b: 255 };
  return { r: r / count, g: g / count, b: b / count };
}

function removeConnectedBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  background: Rgb,
  tolerance: number,
) {
  const visited = new Uint8Array(width * height);
  const queue: Pixel[] = [];
  const threshold = Math.max(4, tolerance);
  const featherThreshold = threshold + 24;

  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const flatIndex = y * width + x;
    if (visited[flatIndex]) return;

    const index = pixelIndex(x, y, width);
    const alpha = data[index + 3];
    if (alpha < 8 || colorDistance(data, index, background) <= threshold) {
      visited[flatIndex] = 1;
      queue.push({ x, y });
    }
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { x, y } = queue[cursor];
    const index = pixelIndex(x, y, width);
    data[index + 3] = 0;

    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  for (const { x, y } of queue) {
    softenEdge(data, width, height, x + 1, y, background, featherThreshold);
    softenEdge(data, width, height, x - 1, y, background, featherThreshold);
    softenEdge(data, width, height, x, y + 1, background, featherThreshold);
    softenEdge(data, width, height, x, y - 1, background, featherThreshold);
  }
}

function softenEdge(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  background: Rgb,
  featherThreshold: number,
) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;

  const index = pixelIndex(x, y, width);
  if (data[index + 3] === 0) return;

  const distance = colorDistance(data, index, background);
  if (distance >= featherThreshold) return;

  const opacity = Math.max(0.35, distance / featherThreshold);
  data[index + 3] = Math.round(data[index + 3] * opacity);
}

function pixelIndex(x: number, y: number, width: number) {
  return (y * width + x) * 4;
}

function colorDistance(data: Uint8ClampedArray, index: number, background: Rgb) {
  const red = data[index] - background.r;
  const green = data[index + 1] - background.g;
  const blue = data[index + 2] - background.b;
  return Math.sqrt(red * red + green * green + blue * blue);
}

export async function trimImageTransparency(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return dataUrl;

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixelIndex(x, y, width);
      const alpha = data[index + 3];
      if (alpha > 5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1 || maxY === -1) {
    return dataUrl;
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;
  const cropContext = cropCanvas.getContext("2d");
  if (!cropContext) return dataUrl;

  cropContext.drawImage(
    canvas,
    minX,
    minY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );

  return cropCanvas.toDataURL("image/png");
}

export async function trimImagesTransparencyUniformly(dataUrls: string[]): Promise<string[]> {
  if (dataUrls.length === 0) return [];

  const images = await Promise.all(dataUrls.map((url) => loadImage(url)));

  let globalMinX = Infinity;
  let globalMinY = Infinity;
  let globalMaxX = -1;
  let globalMaxY = -1;

  const canvasList = images.map((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const { data, width, height } = imageData;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = pixelIndex(x, y, width);
          const alpha = data[index + 3];
          if (alpha > 5) {
            if (x < globalMinX) globalMinX = x;
            if (x > globalMaxX) globalMaxX = x;
            if (y < globalMinY) globalMinY = y;
            if (y > globalMaxY) globalMaxY = y;
          }
        }
      }
    }
    return canvas;
  });

  if (globalMaxX === -1 || globalMaxY === -1) {
    return dataUrls;
  }

  return canvasList.map((canvas, idx) => {
    const cropWidth = globalMaxX - globalMinX + 1;
    const cropHeight = globalMaxY - globalMinY + 1;

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropContext = cropCanvas.getContext("2d");
    if (!cropContext) return dataUrls[idx];

    cropContext.drawImage(
      canvas,
      globalMinX,
      globalMinY,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );

    return cropCanvas.toDataURL("image/png");
  });
}

