import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, UA } from "./config.js";

const MAX_BYTES = 120 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

export interface LocalMedia {
  path: string;
  bytes: number;
  contentType: string;
  url: string;
  cached: boolean;
}

/** Download (or reuse a cached copy of) a remote media file. */
export async function fetchMedia(url: string): Promise<LocalMedia> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);

  // Reuse whatever extension we stored it under last time.
  const existing = (await fs.readdir(CACHE_DIR).catch(() => [] as string[])).find((f) =>
    f.startsWith(`m-${hash}.`),
  );
  if (existing) {
    const p = path.join(CACHE_DIR, existing);
    const st = await fs.stat(p);
    if (st.size > 0) {
      return {
        path: p,
        bytes: st.size,
        contentType: EXT_BY_TYPE[existing.split(".").pop() ?? ""] ?? "",
        url,
        cached: true,
      };
    }
  }

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://collectui.com/", Accept: "*/*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Could not download media (${res.status} ${res.statusText}): ${url}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`Media is ${(declared / 1e6).toFixed(1)}MB, above the ${MAX_BYTES / 1e6}MB cap.`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`Media is ${(buf.length / 1e6).toFixed(1)}MB, above the ${MAX_BYTES / 1e6}MB cap.`);
  }

  const urlExt = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const ext =
    EXT_BY_TYPE[contentType] ??
    (["mp4", "mov", "webm", "gif", "avif", "webp", "png", "jpg", "jpeg"].includes(urlExt)
      ? urlExt
      : "bin");

  const out = path.join(CACHE_DIR, `m-${hash}.${ext}`);
  await fs.writeFile(out, buf);
  return { path: out, bytes: buf.length, contentType, url, cached: false };
}

export const mimeForPath = (p: string): string => {
  const ext = p.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    gif: "image/gif",
    avif: "image/avif",
    webp: "image/webp",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
};
