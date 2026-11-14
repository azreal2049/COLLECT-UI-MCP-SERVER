#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  classify,
  getPostById,
  listCategories,
  listByCategory,
  listByDesigner,
  listLatest,
  listTrending,
  resolve,
  searchPosts,
  type CollectUIPost,
} from "./api.js";
import { fetchMedia } from "./media.js";
import { analyzeMediaFile, renderPack } from "./pack.js";
import { frameAt, probe } from "./ffmpeg.js";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const text = (t: string): Content => ({ type: "text", text: t });
const image = (b: Buffer): Content => ({
  type: "image",
  data: b.toString("base64"),
  mimeType: "image/jpeg",
});

const ok = (content: Content[]) => ({ content });
const fail = (message: string) => ({ content: [text(`Error: ${message}`)], isError: true });

function postLine(p: CollectUIPost, i: number): string {
  const author = p.metadata?.author?.username ?? p.designer_username ?? "unknown";
  const cats = p.categories?.length ? ` · ${p.categories.slice(0, 4).join(", ")}` : "";
  return (
    `${i + 1}. **${p.title ?? "Untitled"}** — ${p.media_type}${cats}\n` +
    `   id: \`${p.id}\` · @${author}${p.published_at ? ` · ${p.published_at.slice(0, 10)}` : ""}`
  );
}

function listingText(posts: CollectUIPost[], heading: string): string {
  if (!posts.length) return `${heading}\n\nNo posts matched.`;
  return (
    `${heading}\n\n${posts.map(postLine).join("\n")}\n\n` +
    `Call \`get_design_context\` with one of the ids above (or re-call this link with \`pick: <n>\`) to get the full breakdown of a single design.`
  );
}

async function mediaUrlFor(post: CollectUIPost): Promise<string> {
  const url = post.media_url ?? post.original_media_url ?? post.thumbnail;
  if (!url) throw new Error(`Post ${post.id} has no media URL.`);
  return url;
}

const server = new McpServer(
  { name: "collectui-mcp", version: "0.1.0" },
  {
    instructions:
      "Turns CollectUI links (and any image/GIF/video URL) into a measured design + motion brief: " +
      "palette, layout bands, a segmented motion timeline with durations, easing fits, displacement " +
      "and spatial motion maps, plus a handful of purposefully chosen keyframes. " +
      "Prefer `get_design_context` for a single design; use `browse_designs` to find one first. " +
      "The motion timeline is the point — do not ask for dozens of frames when the timeline already " +
      "states durations, easings and directions.",
  },
);

/* ------------------------------------------------------------------ *
 * get_design_context — the main entry point
 * ------------------------------------------------------------------ */

server.registerTool(
  "get_design_context",
  {
    title: "Get full design context for a CollectUI post or media URL",
    description:
      "Give it a CollectUI link (home, /designs/<category>, /designers/<user>, /trending), a CollectUI " +
      "post id, the original x.com post URL, or any direct image/GIF/video URL. Returns a structured " +
      "brief: format and composition, colour palette with inferred roles, a segmented motion timeline " +
      "(durations, best-fit easing curves, pixel displacement, overshoot/spring detection, loop " +
      "detection, ASCII maps of where on screen the movement happens), implementation hints as CSS/" +
      "framer-motion starting points, and a small set of deliberately chosen keyframes. " +
      "If the link points at a listing, it returns the index of posts instead — pass `pick` to drill in.",
    inputSchema: {
      url: z
        .string()
        .describe("CollectUI URL, post id (uuid), x.com source URL, or a direct media URL."),
      pick: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("When the URL is a listing, analyse this 1-based entry instead of returning the index."),
      detail: z
        .enum(["brief", "standard", "full"])
        .default("standard")
        .describe(
          "Cost tier. 'brief' = measurements only, no images (~2k tokens) and usually enough, because " +
            "the motion timeline already states durations, easings, directions and where on screen things " +
            "move. 'standard' = brief + 3 keyframes (~6k tokens). 'full' = brief + 6 keyframes at higher " +
            "resolution + a contact sheet (~12k tokens); reach for it only when you must see fine visual detail.",
        ),
      frames: z
        .number()
        .int()
        .min(0)
        .max(12)
        .optional()
        .describe("Override the frame count implied by `detail` (0 for a text-only brief)."),
      contact_sheet: z
        .boolean()
        .optional()
        .describe("Override whether a single tiled contact sheet of the keyframes is attached."),
      listing_limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(24)
        .describe("How many posts to list when the URL points at a listing."),
      auto_crop: z
        .boolean()
        .default(true)
        .describe(
          "Crop away a flat presentation matte so the analysis describes the UI, not the backdrop. Set false to analyse the raw frame.",
        ),
      scene_cuts: z
        .boolean()
        .default(false)
        .describe("Also run hard-cut detection (an extra full decode pass; only useful for multi-shot videos)."),
    },
  },
  async ({ url, pick, detail, frames, contact_sheet, listing_limit, auto_crop, scene_cuts }) => {
    try {
      const target = classify(url);
      const tier = {
        brief: { frames: 0, width: 720, sheet: false },
        standard: { frames: 3, width: 720, sheet: false },
        full: { frames: 6, width: 900, sheet: true },
      }[detail];

      const frameCount = frames ?? tier.frames;
      const analyzeOpts = {
        maxFrames: Math.max(1, frameCount || 1),
        includeImages: frameCount > 0,
        includeContactSheet: contact_sheet ?? tier.sheet,
        frameWidth: tier.width,
        autoCrop: auto_crop,
        detectSceneCuts: scene_cuts,
      };

      // Direct media: no CollectUI lookup at all.
      if (target.kind === "media") {
        const media = await fetchMedia(target.url);
        const analysis = await analyzeMediaFile(media.path, analyzeOpts);
        const content: Content[] = [text(renderPack(analysis, null, target.url))];
        if (frameCount > 0) for (const k of analysis.keyframes) if (k.jpeg) content.push(image(k.jpeg));
        if (analysis.sheet) content.push(image(analysis.sheet.buffer));
        return ok(content);
      }

      const { posts } = await resolve(url, listing_limit);
      if (!posts.length) {
        return fail(
          `Nothing found for "${url}". If this is a design you can see on the site, try passing its ` +
            `media URL directly, or use \`browse_designs\` to locate it.`,
        );
      }

      const isListing = target.kind === "category" || target.kind === "feed" || target.kind === "designer" || target.kind === "search";
      if (isListing && !pick) {
        const heading =
          target.kind === "category"
            ? `# CollectUI — category "${target.slug}" (${posts.length} posts)`
            : target.kind === "designer"
              ? `# CollectUI — designs by @${target.username} (${posts.length})`
              : target.kind === "feed"
                ? `# CollectUI — ${target.feed} (${posts.length})`
                : `# CollectUI — search "${target.term}" (${posts.length})`;
        return ok([text(listingText(posts, heading))]);
      }

      const post = isListing ? posts[(pick ?? 1) - 1] : posts[0];
      if (!post) return fail(`pick ${pick} is out of range (${posts.length} results).`);

      const mediaUrl = await mediaUrlFor(post);
      const media = await fetchMedia(mediaUrl);
      const analysis = await analyzeMediaFile(media.path, analyzeOpts);

      const content: Content[] = [text(renderPack(analysis, post, mediaUrl))];
      if (frameCount > 0) for (const k of analysis.keyframes) if (k.jpeg) content.push(image(k.jpeg));
      if (analysis.sheet) content.push(image(analysis.sheet.buffer));
      return ok(content);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

/* ------------------------------------------------------------------ *
 * browse_designs
 * ------------------------------------------------------------------ */

server.registerTool(
  "browse_designs",
  {
    title: "Browse or search CollectUI",
    description:
      "Find designs by keyword, category, designer, or feed. Returns a compact index of post ids to " +
      "feed into `get_design_context`. Use this when you want inspiration of a particular kind " +
      "(e.g. category 'ui-interaction' for motion-heavy work) rather than a specific link.",
    inputSchema: {
      query: z.string().optional().describe("Free-text match against post titles."),
      category: z.string().optional().describe("Category slug, e.g. 'ui-interaction', 'dashboard', 'onboarding'."),
      designer: z.string().optional().describe("Designer username."),
      feed: z.enum(["latest", "trending"]).optional().describe("Browse a feed instead of searching."),
      media_type: z.enum(["video", "image"]).optional().describe("Restrict to animated or still designs."),
      limit: z.number().int().min(1).max(60).default(24),
    },
  },
  async ({ query, category, designer, feed, media_type, limit }) => {
    try {
      let posts: CollectUIPost[];
      let heading: string;
      if (category) {
        posts = await listByCategory(category, limit);
        heading = `# Category "${category}"`;
      } else if (designer) {
        posts = await listByDesigner(designer, limit);
        heading = `# Designs by @${designer}`;
      } else if (query) {
        posts = await searchPosts(query, limit, media_type);
        heading = `# Search "${query}"`;
      } else if (feed === "trending") {
        posts = await listTrending(limit);
        heading = "# Trending";
      } else {
        posts = await listLatest(limit);
        heading = "# Latest";
      }
      if (media_type) posts = posts.filter((p) => p.media_type === media_type);
      return ok([text(listingText(posts, `${heading} — ${posts.length} result(s)`))]);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

/* ------------------------------------------------------------------ *
 * list_categories
 * ------------------------------------------------------------------ */

server.registerTool(
  "list_categories",
  {
    title: "List CollectUI categories",
    description: "The category vocabulary the site organises designs by — useful before calling browse_designs.",
    inputSchema: {},
  },
  async () => {
    try {
      const cats = await listCategories();
      const names = cats
        .map((c) => (c.slug ?? c.name ?? c.title) as string)
        .filter(Boolean)
        .map((s) => `- \`${s}\``);
      return ok([text(`# CollectUI categories (${names.length})\n\n${names.join("\n")}`)]);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

/* ------------------------------------------------------------------ *
 * get_frames — targeted follow-up look
 * ------------------------------------------------------------------ */

server.registerTool(
  "get_frames",
  {
    title: "Pull specific frames from a design",
    description:
      "Follow-up tool: once the motion timeline tells you a moment matters, pull exact frames at " +
      "specific timestamps (seconds) to inspect them closely. Accepts a post id, CollectUI URL, or " +
      "direct media URL.",
    inputSchema: {
      url: z.string().describe("CollectUI post id/URL or direct media URL."),
      timestamps: z
        .array(z.number().min(0))
        .min(1)
        .max(10)
        .describe("Times in seconds to extract."),
      width: z.number().int().min(200).max(1600).default(900).describe("Max width of returned frames."),
    },
  },
  async ({ url, timestamps, width }) => {
    try {
      const target = classify(url);
      let mediaUrl: string;
      let label = "";
      if (target.kind === "media") {
        mediaUrl = target.url;
      } else {
        const post =
          target.kind === "post" ? await getPostById(target.id) : (await resolve(url, 1)).posts[0];
        if (!post) return fail(`No post found for "${url}".`);
        mediaUrl = await mediaUrlFor(post);
        label = post.title ? ` from "${post.title}"` : "";
      }

      const media = await fetchMedia(mediaUrl);
      const p = await probe(media.path);
      const content: Content[] = [
        text(
          `Frames${label} (${p.width}×${p.height}${p.animated ? `, ${p.duration.toFixed(2)}s` : ""}), in order: ` +
            timestamps.map((t) => `${t.toFixed(2)}s`).join(", "),
        ),
      ];
      for (const t of timestamps) {
        if (p.animated && t > p.duration) {
          content.push(text(`(skipped ${t.toFixed(2)}s — past the end of a ${p.duration.toFixed(2)}s clip)`));
          continue;
        }
        const buf = await frameAt(media.path, t, width, "jpeg");
        content.push(image(buf));
      }
      return ok(content);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
