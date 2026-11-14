import fs from "node:fs/promises";
import path, { posix } from "node:path";
import {
  CACHE_DIR,
  CATEGORIES_TABLE,
  POSTS_TABLE,
  SITE,
  SUPABASE_ANON_KEY_ENV,
  SUPABASE_URL,
  UA,
} from "./config.js";

export interface CollectUIPost {
  id: string;
  title: string | null;
  source_url: string | null;
  media_url: string | null;
  original_media_url?: string | null;
  thumbnail?: string | null;
  media_type: "video" | "image" | string;
  categories: string[] | null;
  created_at: string | null;
  published_at: string | null;
  featured?: boolean;
  designer_username?: string | null;
  metadata?: {
    author?: {
      name?: string;
      username?: string;
      bio?: string;
      profile_image_url?: string;
      statistics?: Record<string, number>;
    };
    entities?: unknown;
    [k: string]: unknown;
  } | null;
}

const KEY_CACHE = path.join(CACHE_DIR, "anon-key.txt");
let cachedKey: string | null = null;

async function readCachedKey(): Promise<string | null> {
  try {
    const k = (await fs.readFile(KEY_CACHE, "utf8")).trim();
    return k || null;
  } catch {
    return null;
  }
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
const MAX_CHUNK_FETCHES = 80;

/** Resolve an ES import specifier against the module that declared it. */
function resolveChunk(fromPath: string, spec: string): string | null {
  if (!spec.endsWith(".js")) return null;
  if (spec.startsWith("_app/")) return spec;
  if (!spec.startsWith(".")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  return joined.startsWith("_app/") ? joined : null;
}

/**
 * Read CollectUI's public anon key from the live site bundle — the same value
 * their web app hands to every browser. Walking the import graph (rather than
 * pinning a copy in this repo) means we never republish their credential and
 * never break when they rotate it.
 */
async function discoverAnonKey(): Promise<string | null> {
  try {
    const html = await fetch(SITE, { headers: { "User-Agent": UA } }).then((r) => r.text());

    const entries: string[] = [];
    for (const m of html.matchAll(/["'](?:\.\/)?(_app\/immutable\/[^"']+\.js)["']/g)) {
      if (!entries.includes(m[1])) entries.push(m[1]);
    }
    if (!entries.length) return null;

    const seen = new Set<string>(entries);
    const queue = [...entries];
    let budget = MAX_CHUNK_FETCHES;
    let found: string | null = null;

    const importsIn = (from: string, body: string) => {
      for (const m of body.matchAll(/["']((?:\.\.?\/|_app\/)[^"']*\.js)["']/g)) {
        const resolved = resolveChunk(from, m[1]);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          queue.push(resolved);
        }
      }
    };

    // Bounded pool of workers sharing one queue; the first key found wins and
    // every other worker stops on its next turn.
    const worker = async () => {
      while (!found && budget > 0) {
        const p = queue.shift();
        if (!p) return; // nothing queued right now
        budget--;
        const body = await fetch(`${SITE}/${p}`, { headers: { "User-Agent": UA } })
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "");
        if (!body) continue;
        const hit = body.match(JWT_RE);
        if (hit) {
          found = hit[0];
          return;
        }
        importsIn(p, body);
      }
    };

    // Seed with the entry files first so the import graph is populated, then fan out.
    await Promise.all(entries.map(() => worker()));
    if (!found && queue.length) {
      await Promise.all(Array.from({ length: 12 }, () => worker()));
    }
    return found;
  } catch {
    /* caller reports the failure */
  }
  return null;
}

async function getKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (SUPABASE_ANON_KEY_ENV) {
    cachedKey = SUPABASE_ANON_KEY_ENV;
    return cachedKey;
  }
  const disk = await readCachedKey();
  if (disk) {
    cachedKey = disk;
    return disk;
  }
  const fresh = await rotateKey();
  if (fresh) return fresh;
  throw new Error(
    "Could not read CollectUI's public API key from their site bundle. Their front-end may have " +
      "changed. Set COLLECTUI_SUPABASE_ANON_KEY to override, or pass a direct media URL — media " +
      "analysis works without the catalogue API.",
  );
}

async function rotateKey(): Promise<string | null> {
  const fresh = await discoverAnonKey();
  if (!fresh) return null;
  cachedKey = fresh;
  await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(KEY_CACHE, fresh, "utf8").catch(() => {});
  return fresh;
}

async function rest<T>(table: string, query: string, retry = true): Promise<T> {
  const key = await getKey();
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "User-Agent": UA },
  });

  if ((res.status === 401 || res.status === 403) && retry) {
    const fresh = await rotateKey();
    if (fresh) return rest<T>(table, query, false);
  }
  if (!res.ok) {
    throw new Error(
      `CollectUI data request failed (${res.status}). ${await res.text().catch(() => "")}`.trim(),
    );
  }
  return (await res.json()) as T;
}

const SELECT = "*";

/* ------------------------------------------------------------------ *
 * URL classification
 * ------------------------------------------------------------------ */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MEDIA_EXT_RE = /\.(mp4|webm|mov|m4v|gif|apng|avif|webp|png|jpe?g)(\?|#|$)/i;

export type Target =
  | { kind: "post"; id: string }
  | { kind: "source"; url: string }
  | { kind: "media"; url: string }
  | { kind: "category"; slug: string }
  | { kind: "designer"; username: string }
  | { kind: "feed"; feed: "latest" | "trending" | "featured" }
  | { kind: "search"; term: string };

export function classify(input: string): Target {
  const raw = input.trim();

  if (UUID_RE.test(raw) && !/^https?:\/\/(?!collectui\.com)/i.test(raw)) {
    const id = raw.match(UUID_RE)![0];
    return { kind: "post", id };
  }

  let u: URL | null = null;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return { kind: "search", term: raw };
  }

  const host = u.hostname.replace(/^www\./, "");
  const segs = u.pathname.split("/").filter(Boolean);

  if (host === "x.com" || host === "twitter.com") return { kind: "source", url: u.toString() };

  if (host !== "collectui.com") {
    if (MEDIA_EXT_RE.test(u.pathname)) return { kind: "media", url: u.toString() };
    return { kind: "media", url: u.toString() };
  }

  // collectui.com itself
  const qPost = u.searchParams.get("post") ?? u.searchParams.get("id");
  if (qPost && UUID_RE.test(qPost)) return { kind: "post", id: qPost.match(UUID_RE)![0] };
  if (u.hash && UUID_RE.test(u.hash)) return { kind: "post", id: u.hash.match(UUID_RE)![0] };

  if (!segs.length) return { kind: "feed", feed: "latest" };
  if (segs[0] === "trending") return { kind: "feed", feed: "trending" };
  if (segs[0] === "designers" && segs[1]) return { kind: "designer", username: segs[1] };
  if (segs[0] === "designs" && segs[1]) {
    return { kind: "category", slug: segs[1].replace(/-ui-design-inspiration$/, "") };
  }
  if (segs[0] === "categories") return { kind: "feed", feed: "latest" };
  return { kind: "search", term: segs.join(" ") };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

const published = "status=eq.Published";
const newest = "order=published_at.desc.nullslast,created_at.desc,id.desc";

export const getPostById = async (id: string): Promise<CollectUIPost | null> =>
  (await rest<CollectUIPost[]>(POSTS_TABLE, `select=${SELECT}&id=eq.${encodeURIComponent(id)}&limit=1`))[0] ??
  null;

export async function getPostBySourceUrl(url: string): Promise<CollectUIPost | null> {
  const statusId = url.match(/status\/(\d+)/)?.[1];
  const pattern = statusId ? `*status/${statusId}*` : `*${url.replace(/^https?:\/\//, "")}*`;
  const rows = await rest<CollectUIPost[]>(
    POSTS_TABLE,
    `select=${SELECT}&source_url=ilike.${encodeURIComponent(pattern)}&limit=1`,
  );
  return rows[0] ?? null;
}

export const listLatest = (limit: number, offset = 0) =>
  rest<CollectUIPost[]>(POSTS_TABLE, `select=${SELECT}&${published}&${newest}&offset=${offset}&limit=${limit}`);

export const listTrending = (limit: number) =>
  rest<CollectUIPost[]>(
    POSTS_TABLE,
    `select=${SELECT}&${published}&featured=eq.true&${newest}&limit=${limit}`,
  );

export const listByCategory = (slug: string, limit: number, offset = 0) =>
  rest<CollectUIPost[]>(
    POSTS_TABLE,
    `select=${SELECT}&${published}&categories=cs.${encodeURIComponent(`{${slug}}`)}&${newest}&offset=${offset}&limit=${limit}`,
  );

export const listByDesigner = (username: string, limit: number) =>
  rest<CollectUIPost[]>(
    POSTS_TABLE,
    `select=${SELECT}&${published}&designer_username=eq.${encodeURIComponent(username)}&${newest}&limit=${limit}`,
  );

export const searchPosts = (term: string, limit: number, mediaType?: string) =>
  rest<CollectUIPost[]>(
    POSTS_TABLE,
    `select=${SELECT}&${published}&title=ilike.${encodeURIComponent(`*${term}*`)}` +
      (mediaType ? `&media_type=eq.${encodeURIComponent(mediaType)}` : "") +
      `&${newest}&limit=${limit}`,
  );

export const listCategories = () =>
  rest<Array<Record<string, unknown>>>(CATEGORIES_TABLE, `select=*&order=order.asc`);

/** Resolve any supported input to the posts it refers to. */
export async function resolve(
  input: string,
  limit: number,
): Promise<{ target: Target; posts: CollectUIPost[] }> {
  const target = classify(input);
  switch (target.kind) {
    case "post": {
      const p = await getPostById(target.id);
      return { target, posts: p ? [p] : [] };
    }
    case "source": {
      const p = await getPostBySourceUrl(target.url);
      return { target, posts: p ? [p] : [] };
    }
    case "media":
      return { target, posts: [] };
    case "category":
      return { target, posts: await listByCategory(target.slug, limit) };
    case "designer":
      return { target, posts: await listByDesigner(target.username, limit) };
    case "feed":
      return {
        target,
        posts: target.feed === "latest" ? await listLatest(limit) : await listTrending(limit),
      };
    case "search":
      return { target, posts: await searchPosts(target.term, limit) };
  }
}
