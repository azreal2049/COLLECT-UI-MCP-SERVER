import os from "node:os";
import path from "node:path";

/** Where downloaded media + derived frames are cached between calls. */
export const CACHE_DIR =
  process.env.COLLECTUI_CACHE_DIR ?? path.join(os.tmpdir(), "collectui-mcp-cache");

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export const SITE = "https://collectui.com";

/**
 * CollectUI serves its catalogue from a public Supabase project — the same
 * read-only endpoint its own web app calls from the browser.
 *
 * We deliberately do NOT ship a copy of their public key in this repo. It is
 * read at runtime from the live site bundle (the same place a browser gets it)
 * and cached locally, so this project never republishes someone else's
 * credential and never goes stale when they rotate it. Set
 * COLLECTUI_SUPABASE_ANON_KEY to skip discovery entirely.
 */
export const SUPABASE_URL =
  process.env.COLLECTUI_SUPABASE_URL ?? "https://tuzpqmdnxvlzwqthgseg.supabase.co";

export const SUPABASE_ANON_KEY_ENV = process.env.COLLECTUI_SUPABASE_ANON_KEY ?? null;

export const POSTS_TABLE = "collectui_posts";
export const CATEGORIES_TABLE = "collectui_categories";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Analysis resolution knobs. Small on purpose: motion structure survives downsampling. */
export const GRID_W = 64; // luma sampling width
export const GRID_H = 36; // luma sampling height
export const CELLS_X = 8; // motion-map columns
export const CELLS_Y = 5; // motion-map rows
export const SAMPLE_FPS = 20;
export const MAX_SAMPLE_SECONDS = 30;
