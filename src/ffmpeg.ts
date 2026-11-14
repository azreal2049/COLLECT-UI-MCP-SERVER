import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, FFPROBE } from "./config.js";

const run = promisify(execFile);

const BIG = 1024 * 1024 * 512; // frame buffers can be large; don't truncate them

async function ff(bin: string, args: string[], encoding: "buffer" | "utf8" = "utf8") {
  try {
    const { stdout } = await run(bin, args, {
      maxBuffer: BIG,
      encoding: encoding as never,
      timeout: 120_000,
    });
    return stdout as unknown as Buffer | string;
  } catch (err: unknown) {
    const e = err as { stderr?: string | Buffer; message?: string; code?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        `${bin} not found. Install ffmpeg (macOS: \`brew install ffmpeg\`) or set FFMPEG_PATH/FFPROBE_PATH.`,
      );
    }
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    throw new Error(`${bin} failed: ${stderr.trim().split("\n").slice(-4).join(" | ") || e.message}`);
  }
}

export interface Probe {
  width: number;
  height: number;
  fps: number;
  /** Seconds. 0 for still images. */
  duration: number;
  codec: string;
  nbFrames: number;
  hasAudio: boolean;
  /** True when the file carries real temporal content (video / animated GIF). */
  animated: boolean;
}

function parseRational(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  if (!d) return n || 0;
  return d === 0 ? 0 : n / d;
}

export async function probe(file: string): Promise<Probe> {
  const out = (await ff(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ])) as string;

  const json = JSON.parse(out) as {
    streams?: Array<Record<string, string>>;
    format?: Record<string, string>;
  };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("No video/image stream found in media.");

  const fps = parseRational(v.avg_frame_rate) || parseRational(v.r_frame_rate) || 0;
  const duration =
    Number(v.duration) || Number(json.format?.duration) || 0;
  const nbFrames = Number(v.nb_frames) || (fps && duration ? Math.round(fps * duration) : 1);

  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: Number.isFinite(fps) ? fps : 0,
    duration: Number.isFinite(duration) ? duration : 0,
    codec: v.codec_name ?? "unknown",
    nbFrames,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    animated: nbFrames > 1 && duration > 0.05,
  };
}

/** A crop rectangle in source-pixel coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const cropFilter = (c: Rect | null) =>
  c ? `crop=${Math.round(c.w)}:${Math.round(c.h)}:${Math.round(c.x)}:${Math.round(c.y)},` : "";

export interface RawFrames {
  /** One entry per sampled frame, each `w*h` bytes (gray) or `w*h*3` (rgb). */
  frames: Buffer[];
  w: number;
  h: number;
  fps: number;
  /** Timestamp (seconds) of each sampled frame. */
  times: number[];
}

async function extractRaw(
  file: string,
  pixFmt: "gray" | "rgb24",
  w: number,
  h: number,
  fps: number,
  maxSeconds: number,
  crop: Rect | null = null,
): Promise<RawFrames> {
  const bytesPerPixel = pixFmt === "gray" ? 1 : 3;
  const frameSize = w * h * bytesPerPixel;

  const buf = (await ff(
    FFMPEG,
    [
      "-v",
      "error",
      "-t",
      String(maxSeconds),
      "-i",
      file,
      "-vf",
      `${cropFilter(crop)}fps=${fps},scale=${w}:${h}:flags=area`,
      "-pix_fmt",
      pixFmt,
      "-f",
      "rawvideo",
      "-",
    ],
    "buffer",
  )) as Buffer;

  const count = Math.floor(buf.length / frameSize);
  const frames: Buffer[] = [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(buf.subarray(i * frameSize, (i + 1) * frameSize));
    times.push(i / fps);
  }
  if (!frames.length) throw new Error("ffmpeg produced no frames — unsupported or corrupt media.");
  return { frames, w, h, fps, times };
}

export const extractGray = (
  file: string,
  w: number,
  h: number,
  fps: number,
  maxSeconds: number,
  crop: Rect | null = null,
) => extractRaw(file, "gray", w, h, fps, maxSeconds, crop);

export const extractRGB = (
  file: string,
  w: number,
  h: number,
  fps: number,
  maxSeconds: number,
  crop: Rect | null = null,
) => extractRaw(file, "rgb24", w, h, fps, maxSeconds, crop);

/** Luma plane derived from an rgb24 buffer — saves a second decode pass. */
export function rgbToGray(rgb: Buffer): Buffer {
  const n = rgb.length / 3;
  const gray = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    gray[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) | 0;
  }
  return gray;
}

/** One frame at time `t` as raw rgb24 at exactly `w`×`h` — for pixel analysis, not display. */
export async function rawFrameAt(
  file: string,
  t: number,
  w: number,
  h: number,
  crop: Rect | null = null,
): Promise<Buffer> {
  const buf = (await ff(
    FFMPEG,
    [
      "-v",
      "error",
      ...(t > 0 ? ["-ss", t.toFixed(3)] : []),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `${cropFilter(crop)}scale=${w}:${h}:flags=area`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    "buffer",
  )) as Buffer;
  if (buf.length < w * h * 3) throw new Error("ffmpeg returned a short frame buffer.");
  return buf.subarray(0, w * h * 3);
}

/** Encode a single frame at time `t` as a JPEG/PNG buffer, capped to `maxW` wide. */
export async function frameAt(
  file: string,
  t: number,
  maxW = 900,
  format: "jpeg" | "png" = "jpeg",
  crop: Rect | null = null,
): Promise<Buffer> {
  const codecArgs =
    format === "jpeg" ? ["-c:v", "mjpeg", "-q:v", "4"] : ["-c:v", "png"];
  return (await ff(
    FFMPEG,
    [
      "-v",
      "error",
      // seek before -i where possible; for stills t is 0 and this is a no-op
      ...(t > 0 ? ["-ss", t.toFixed(3)] : []),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `${cropFilter(crop)}scale='min(${maxW},iw)':-2:flags=lanczos`,
      ...codecArgs,
      "-f",
      "image2pipe",
      "-",
    ],
    "buffer",
  )) as Buffer;
}

/**
 * Build a single contact-sheet image from the given timestamps.
 * ffmpeg's `drawtext` needs libfreetype, which many builds lack, so the sheet
 * carries no burnt-in labels — the accompanying text names each tile in order.
 */
export async function contactSheet(
  file: string,
  times: number[],
  workDir: string,
  cols = 4,
  tileW = 420,
  crop: Rect | null = null,
): Promise<{ buffer: Buffer; cols: number; rows: number }> {
  const dir = path.join(workDir, `sheet-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    for (let i = 0; i < times.length; i++) {
      const png = await frameAt(file, times[i], tileW, "png", crop);
      await fs.writeFile(path.join(dir, `f${String(i).padStart(3, "0")}.png`), png);
    }
    const rows = Math.ceil(times.length / cols);
    const buffer = (await ff(
      FFMPEG,
      [
        "-v",
        "error",
        "-i",
        path.join(dir, "f%03d.png"),
        "-vf",
        `scale=${tileW}:-2:flags=lanczos,pad=${tileW}:ih+8:0:4:color=0x1a1a1a,tile=${cols}x${rows}:padding=6:margin=6:color=0x1a1a1a`,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "4",
        "-f",
        "image2pipe",
        "-",
      ],
      "buffer",
    )) as Buffer;
    return { buffer, cols, rows };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Scene-cut timestamps reported by ffmpeg's own scene-change score.
 * `showinfo` writes to stderr on a successful run, so read it from there.
 */
export async function sceneCuts(file: string, threshold = 0.25): Promise<number[]> {
  let stderr = "";
  try {
    const res = await run(
      FFMPEG,
      ["-v", "info", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
      { maxBuffer: BIG, timeout: 120_000 },
    );
    stderr = res.stderr ?? "";
  } catch (err) {
    // Non-zero exit still leaves usable showinfo lines behind.
    stderr = (err as { stderr?: string }).stderr ?? "";
  }
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times;
}
