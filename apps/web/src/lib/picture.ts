export const PICTURE_SIDE = 256;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export class PictureError extends Error {}

export async function toProfilePicture(file: File): Promise<{ readonly base64: string; readonly blob: Blob }> {
  if (file.size > MAX_SOURCE_BYTES) throw new PictureError("That picture is over 25MB. Choose a smaller one.");
  const source = await decode(file);
  const width = "naturalWidth" in source ? source.naturalWidth : source.width;
  const height = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (!width || !height) throw new PictureError("That picture could not be read. Try a JPG or PNG.");

  const side = Math.min(width, height);
  const sx = (width - side) / 2;
  const sy = (height - side) / 2;
  let canvas = draw(source, sx, sy, side, side, Math.min(side, PICTURE_SIDE * 4));
  if (canvas.width > PICTURE_SIDE) canvas = draw(canvas, 0, 0, canvas.width, canvas.height, PICTURE_SIDE);
  if ("close" in source) source.close();

  let blob = await encode(canvas, "image/webp", 0.88);
  // A browser that cannot write WebP returns PNG instead; JPEG is smaller.
  if (!blob || blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg", 0.9);
  if (!blob) throw new PictureError("That picture could not be prepared. Try another.");
  return { base64: await toBase64(blob), blob };
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      // Turned the way the camera held it, as a photo app would show it.
      return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    } catch {
      // Fall through to an image element, which some formats need.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new PictureError("That picture could not be read here. Try a JPG or PNG.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  size: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new PictureError("This browser cannot prepare pictures.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, sx, sy, sw, sh, 0, 0, size, size);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new PictureError("That picture could not be prepared. Try another."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(blob);
  });
}
