// Convert WhatsApp voice notes (OGG/Opus) to Whisper-friendly MP3 via ffmpeg.
// Raw ogg/opus often fails or stalls OpenAI Whisper; 16 kHz mono MP3 is
// accepted reliably and uploads faster.

import { spawn } from "child_process";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const NEEDS_CONVERT = /^(ogg|oga|opus|amr|3gp|webm|audio\/ogg|audio\/opus|audio\/amr|audio\/webm)/i;

export function audioNeedsFfmpegConvert(mimeOrExt: string): boolean {
  const s = String(mimeOrExt || "").toLowerCase();
  return NEEDS_CONVERT.test(s) || s.includes("opus") || s.includes("ogg");
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

/**
 * Convert inbound voice bytes to 16 kHz mono MP3 for Whisper.
 * Returns original buffer unchanged if ffmpeg is missing or conversion fails
 * (caller still tries Whisper on the source format).
 */
export async function convertAudioForWhisper(
  input: Buffer,
  mimeOrExt: string,
): Promise<{ buffer: Buffer; mime: string; filename: string; converted: boolean }> {
  if (!audioNeedsFfmpegConvert(mimeOrExt)) {
    const ext = guessExt(mimeOrExt);
    return {
      buffer: input,
      mime: mimeOrExt.includes("/") ? mimeOrExt.split(";")[0].trim() : `audio/${ext}`,
      filename: `voice.${ext}`,
      converted: false,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "wa-voice-"));
  const inPath = join(dir, "in.ogg");
  const outPath = join(dir, "out.mp3");
  try {
    await writeFile(inPath, input);
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "48k",
      "-f",
      "mp3",
      outPath,
    ]);
    const out = await readFile(outPath);
    if (!out.length) {
      throw new Error("ffmpeg produced empty mp3");
    }
    return {
      buffer: out,
      mime: "audio/mpeg",
      filename: "voice.mp3",
      converted: true,
    };
  } catch (e) {
    console.warn(
      "[ffmpeg] convert failed, sending original to Whisper:",
      e instanceof Error ? e.message : e,
    );
    return {
      buffer: input,
      mime: "audio/ogg",
      filename: "voice.ogg",
      converted: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function guessExt(mimeOrExt: string): string {
  const s = String(mimeOrExt || "").toLowerCase();
  if (s.includes("mpeg") || s.includes("mp3")) return "mp3";
  if (s.includes("mp4") || s.includes("m4a")) return "m4a";
  if (s.includes("wav")) return "wav";
  if (s.includes("amr")) return "amr";
  if (s.includes("webm")) return "webm";
  return "ogg";
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `ffmpeg not runnable (${err.message}). Install ffmpeg or set FFMPEG_PATH.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}
