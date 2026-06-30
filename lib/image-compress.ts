// Client-only image compression for outbound media. Shrinks pasted
// screenshots / camera photos before they leave the browser so the upload to
// our server + Meta is fast. WhatsApp only accepts image/jpeg + image/png, so
// we only ever output those two formats (never webp).
//
// Rules (see notes inline):
//  - downscale longest side to MAX_DIM (never upscale)
//  - JPEG q≈0.82 for photos/opaque images; keep PNG when it has real
//    transparency, else convert opaque PNG → white-flattened JPEG (big win)
//  - skip work entirely for already-small jpeg/png within bounds
//  - correct EXIF rotation via createImageBitmap so phone photos aren't sideways
//  - any failure → return the original file untouched

const MAX_DIM = 1600;
const JPEG_QUALITY = 0.82;
const SKIP_BELOW_BYTES = 300 * 1024; // already-small jpeg/png isn't worth recompressing

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// True if any pixel is non-opaque — tells us whether a JPEG conversion would
// lose transparency (and so needs white-flattening or should stay PNG).
function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

function swapExt(name: string, type: string): string {
  const ext = type === "image/png" ? "png" : "jpg";
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}.${ext}`;
}

export async function compressImageFile(file: File): Promise<File> {
  if (typeof window === "undefined") return file;
  if (!file.type.startsWith("image/")) return file; // video/pdf/etc untouched
  if (typeof createImageBitmap !== "function") return file;

  const acceptedFormat = file.type === "image/jpeg" || file.type === "image/png";

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    const needsResize = scale < 1;

    // Already small + an accepted format + no resize → ship as-is. Recompressing
    // would only add artifacts.
    if (acceptedFormat && !needsResize && file.size <= SKIP_BELOW_BYTES) {
      bitmap.close();
      return file;
    }

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    // Decide output format. Only PNG/webp/gif sources can carry alpha; JPEG
    // never does, so skip the (costly) pixel scan for it.
    let outType = "image/jpeg";
    const couldHaveAlpha = file.type !== "image/jpeg";
    const alpha = couldHaveAlpha && hasTransparency(ctx, w, h);
    if (alpha && file.type === "image/png") {
      outType = "image/png"; // preserve genuine transparency, resize only
    } else if (alpha) {
      // Converting a transparent source (e.g. webp) to JPEG — paint white
      // behind the existing pixels so transparency doesn't flatten to black.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }

    const blob = await toBlob(canvas, outType, outType === "image/jpeg" ? JPEG_QUALITY : undefined);
    if (!blob) return file;

    // Keep the original whenever our output isn't actually smaller. Meta
    // accepts png + jpeg equally, so bytes — not format — are the tiebreaker
    // (a force-converted JPEG that came out bigger would just waste bandwidth
    // and add artifacts to text/graphics).
    if (blob.size >= file.size) return file;

    return new File([blob], swapExt(file.name, outType), {
      type: outType,
      lastModified: file.lastModified,
    });
  } catch {
    return file; // unsupported browser / decode failure → original
  }
}
