import { CACHE_DIR, CELLS_X, GRID_H, GRID_W, MAX_SAMPLE_SECONDS } from "./config.js";
import type { CollectUIPost } from "./api.js";
import {
  contactSheet,
  extractRGB,
  frameAt,
  probe,
  rawFrameAt,
  rgbToGray,
  sceneCuts,
  type Probe,
  type Rect,
} from "./ffmpeg.js";
import { analyzeMotion, selectKeyframes, type MotionAnalysis } from "./analysis/motion.js";
import { describeTheme, extractPalette, type Swatch } from "./analysis/color.js";
import { analyzeLayout, detectContentBox, type LayoutAnalysis } from "./analysis/layout.js";

export interface Keyframe {
  t: number;
  why: string;
  jpeg?: Buffer;
}

export interface MediaAnalysis {
  probe: Probe;
  /** Content box the analysis was run inside, in source pixels (null = whole frame). */
  crop: Rect | null;
  palette: Swatch[];
  theme: string;
  layout: LayoutAnalysis;
  motion: MotionAnalysis | null;
  cuts: number[];
  keyframes: Keyframe[];
  sheet: { buffer: Buffer; cols: number; rows: number } | null;
  sampledFps: number;
}

export interface AnalyzeOptions {
  maxFrames: number;
  includeImages: boolean;
  includeContactSheet: boolean;
  /** Width of attached frames — the main lever on image token cost. */
  frameWidth?: number;
  /** Crop away a flat presentation matte before analysing. */
  autoCrop?: boolean;
  detectSceneCuts?: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** More temporal resolution for short clips, where a 200ms transition is the whole story. */
function chooseSampleFps(duration: number, sourceFps: number): number {
  const target = clamp(Math.round(400 / Math.max(duration, 0.2)), 12, 50);
  return Math.max(8, Math.min(target, sourceFps || target));
}

export async function analyzeMediaFile(
  file: string,
  opts: AnalyzeOptions,
): Promise<MediaAnalysis> {
  const p = await probe(file);
  const autoCrop = opts.autoCrop ?? true;

  // --- 1. Find the real content box, so a presentation matte doesn't dominate --
  let crop: Rect | null = null;
  let appliedMatte: LayoutAnalysis["matte"] = null;
  if (autoCrop) {
    const probeW = 160;
    const probeH = even((probeW * p.height) / p.width);
    // Sample near the end: by then whatever animates has usually revealed itself.
    const at = p.animated ? Math.max(0, p.duration * 0.75) : 0;
    const box = await rawFrameAt(file, at, probeW, probeH)
      .then((buf) => detectContentBox(buf, probeW, probeH, p.width, p.height))
      .catch(() => null);
    if (box) {
      crop = box.rect;
      appliedMatte = box.matte;
    }
  }

  const boxW = crop?.w ?? p.width;
  const boxH = crop?.h ?? p.height;

  // --- 2. One decode pass: rgb frames serve both motion and palette -----------
  const gridW = GRID_W;
  const gridH = even((GRID_W * boxH) / boxW) || GRID_H;
  const sampledFps = p.animated ? chooseSampleFps(p.duration, p.fps) : 1;

  let motion: MotionAnalysis | null = null;
  let paletteBuf: Buffer;

  if (p.animated) {
    const rgb = await extractRGB(file, gridW, gridH, sampledFps, MAX_SAMPLE_SECONDS, crop);
    const grayFrames = {
      frames: rgb.frames.map(rgbToGray),
      w: rgb.w,
      h: rgb.h,
      fps: rgb.fps,
      times: rgb.times,
    };
    motion = analyzeMotion(grayFrames, boxW, boxH);
    // Sample the palette across the timeline, not from one arbitrary frame.
    const stride = Math.max(1, Math.floor(rgb.frames.length / 24));
    paletteBuf = Buffer.concat(rgb.frames.filter((_, i) => i % stride === 0));
  } else {
    paletteBuf = await rawFrameAt(file, 0, 64, even((64 * boxH) / boxW), crop);
  }

  const palette = extractPalette(paletteBuf, 6);
  const theme = describeTheme(palette);

  // --- 3. Layout from a settled, higher-resolution frame ----------------------
  const lastHold = motion ? [...motion.segments].reverse().find((s) => s.kind === "hold") : undefined;
  const settleTime = lastHold
    ? lastHold.start + lastHold.duration / 2
    : motion
      ? Math.max(0, motion.duration - 0.05)
      : 0;

  const lw = 160;
  const lh = even((lw * boxH) / boxW);
  const layoutRGB = await rawFrameAt(file, settleTime, lw, lh, crop);
  const layout = analyzeLayout(rgbToGray(layoutRGB), layoutRGB, lw, lh, boxW, boxH, appliedMatte);

  // --- 4. Optional hard-cut detection (a full extra decode pass) --------------
  const cuts = opts.detectSceneCuts && p.animated
    ? (await sceneCuts(file).catch(() => [])).filter((t) => t > 0.02)
    : [];

  // --- 5. Frames worth showing ------------------------------------------------
  const picks: Keyframe[] = motion
    ? selectKeyframes(motion, opts.maxFrames)
    : [{ t: 0, why: "the still itself" }];

  const frameWidth = opts.frameWidth ?? 720;
  if (opts.includeImages) {
    for (const k of picks) {
      k.jpeg = await frameAt(file, k.t, frameWidth, "jpeg", crop).catch(() => undefined);
    }
  }

  let sheet: MediaAnalysis["sheet"] = null;
  if (opts.includeContactSheet && motion && picks.length > 1) {
    sheet = await contactSheet(
      file,
      picks.map((k) => k.t),
      CACHE_DIR,
      Math.min(4, picks.length),
      420,
      crop,
    ).catch(() => null);
  }

  return { probe: p, crop, palette, theme, layout, motion, cuts, keyframes: picks, sheet, sampledFps };
}

/* ------------------------------------------------------------------ *
 * Markdown rendering
 * ------------------------------------------------------------------ */

const ms = (s: number) => `${Math.round(s * 1000)}ms`;
const pct = (v: number) => (v >= 0.01 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(2)}%`);

function paletteTable(palette: Swatch[]): string {
  const rows = palette
    .map(
      (s) =>
        `| \`${s.hex}\` | hsl(${s.hsl[0]}, ${s.hsl[1]}%, ${s.hsl[2]}%) | ${pct(s.coverage)} | ${s.role} |`,
    )
    .join("\n");
  return `| hex | hsl | coverage | role (inferred) |\n|---|---|---|---|\n${rows}`;
}

function motionSection(m: MotionAnalysis, cuts: number[], boxW: number, boxH: number): string {
  const lines: string[] = [];
  lines.push(
    `**${m.summary}** Sampled at ${m.sampledFps}fps (${m.frameCount} frames analysed).`,
    "",
    `- Loop: ${
      m.loop.seamless
        ? `**seamless** — the last frame returns to the first (similarity ${pct(m.loop.similarity)}), so this is built to repeat`
        : `not seamless (end-vs-start similarity ${pct(m.loop.similarity)}) — it plays once and rests`
    }`,
    `- Timeline held still: ${pct(m.staticRatio)} of frames`,
    `- Busiest moment: ${m.busiestTime.toFixed(2)}s`,
  );
  if (m.loop.period) {
    lines.push(`- Repeating rhythm with a period of ~${ms(m.loop.period)} (a pulse or cycling element)`);
  }
  if (cuts.length) {
    lines.push(`- Hard scene cuts at: ${cuts.map((c) => `${c.toFixed(2)}s`).join(", ")}`);
  }

  lines.push("", "### Timeline", "");
  for (const s of m.segments) {
    lines.push(
      `**${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s** · \`${s.kind.toUpperCase()}\` · ${ms(s.duration)} · ${s.character}`,
      "",
    );
    if (s.kind === "hold") {
      lines.push("  Nothing moves. A stable state — good to screenshot or snapshot-test.", "");
      continue;
    }
    lines.push(`  - Change focused on the **${s.focus}** (${pct(s.concentration)} of the change energy)`);
    if (s.translation) {
      lines.push(
        `  - Displacement: **dx ${s.translation.dx >= 0 ? "+" : ""}${s.translation.dx}px, dy ${
          s.translation.dy >= 0 ? "+" : ""
        }${s.translation.dy}px** (within the ${boxW}×${boxH} content box) — ${s.translation.label}`,
      );
    }
    if (Math.abs(s.luminanceDelta) > 4) {
      lines.push(
        `  - Brightness ${s.luminanceDelta > 0 ? "rises" : "falls"} by ${Math.abs(s.luminanceDelta).toFixed(1)}/255 across the segment`,
      );
    }
    if (s.overshoot !== null) {
      lines.push(
        `  - **Overshoot of ${s.overshoot.toFixed(0)}%** — motion passes its resting point and settles back: a spring, not a plain ease`,
      );
    }
    if (s.easing.length) {
      const best = s.easing[0];
      const weak = s.samples < 5;
      lines.push(
        `  - Best-fit easing: **${best.name}** → \`${best.css}\` (R²=${best.r2.toFixed(2)}${
          weak ? `, low confidence — only ${s.samples} samples at ${m.sampledFps}fps` : ""
        })` + (s.easing[1] ? `; next best: ${s.easing.slice(1).map((e) => e.name).join(", ")}` : ""),
      );
    }
    lines.push("", "  Where the movement happens:", "", "```", s.asciiMap, "```", "");
  }

  lines.push(
    "### Aggregate motion map",
    "",
    `Change energy across the whole clip, ${CELLS_X} columns wide over the content box (\`█\` busiest, blank = never changes):`,
    "",
    "```",
    m.overallAsciiMap,
    "```",
    "",
  );
  return lines.join("\n");
}

function implementationHints(a: MediaAnalysis): string {
  const lines: string[] = [];
  const m = a.motion;
  if (!m) {
    return "This is a still. Build it as static layout — the palette and band structure above are the actionable parts.";
  }

  const moves = m.segments.filter((s) => s.kind !== "hold");
  if (!moves.length) return "No meaningful motion — treat the media as a still.";

  lines.push("Starting points derived from the measurements above:", "", "```css");
  moves.forEach((s, i) => {
    const e = s.easing[0];
    lines.push(`/* Segment ${i + 1}: ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s — ${s.character} */`);
    lines.push(`.segment-${i + 1} {`);
    lines.push(`  transition-duration: ${ms(s.duration)};`);
    if (e) lines.push(`  transition-timing-function: ${e.css}; /* ${e.name} */`);
    if (s.translation) {
      lines.push(
        `  transform: translate(${s.translation.dx}px, ${s.translation.dy}px); /* measured in a ${
          a.crop?.w ?? a.probe.width
        }×${a.crop?.h ?? a.probe.height} box — rescale to your own layout */`,
      );
    }
    if (s.start > 0.01) lines.push(`  transition-delay: ${ms(s.start)}; /* if chained from t=0 */`);
    lines.push("}");
  });
  lines.push("```", "");

  const springy = moves.filter((s) => s.overshoot !== null);
  if (springy.length) {
    lines.push(
      `${springy.length === 1 ? "One segment overshoots" : `${springy.length} segments overshoot`} the resting point, so a spring reads closer than a bezier:`,
      "",
      "```js",
      "// framer-motion / motion",
      `transition={{ type: "spring", stiffness: 260, damping: ${springy[0].overshoot! > 12 ? 14 : 20}, mass: 1 }}`,
      "```",
      "",
    );
  }

  if (m.loop.seamless) {
    lines.push(
      "The clip loops seamlessly — implement as an infinite animation (`animation-iteration-count: infinite`) rather than a one-shot transition.",
      "",
    );
  }
  return lines.join("\n");
}

export function renderPack(a: MediaAnalysis, post: CollectUIPost | null, mediaUrl: string): string {
  const p = a.probe;
  const out: string[] = [];
  const boxW = a.crop?.w ?? p.width;
  const boxH = a.crop?.h ?? p.height;

  out.push(`# Design context — ${post?.title ?? "Untitled media"}`, "");

  if (post) {
    const author = post.metadata?.author;
    const meta = [
      `- **CollectUI post id**: \`${post.id}\``,
      `- **Original source**: ${post.source_url ?? "unknown"}`,
      author?.username
        ? `- **Designer**: ${author.name ?? ""} (@${author.username})${
            author.bio ? ` — ${author.bio.replace(/\s+/g, " ").slice(0, 140)}` : ""
          }`
        : post.designer_username
          ? `- **Designer**: @${post.designer_username}`
          : "",
      post.categories?.length ? `- **Categories**: ${post.categories.join(", ")}` : "",
      post.published_at ? `- **Published**: ${post.published_at.slice(0, 10)}` : "",
    ].filter(Boolean);
    out.push(...meta);
  }

  out.push(
    `- **Media**: ${mediaUrl}`,
    `- **Technical**: ${p.codec} · ${p.width}×${p.height}` +
      (p.animated
        ? ` · ${p.duration.toFixed(2)}s · ${p.fps.toFixed(1)}fps · ${p.nbFrames} frames`
        : " · still image"),
    a.crop
      ? `- **Analysed region**: cropped to the ${a.crop.w}×${a.crop.h} content box at (${a.crop.x}, ${a.crop.y}); the surrounding flat matte is presentation only. Attached frames are cropped to match.`
      : `- **Analysed region**: the full frame (no presentation matte detected)`,
    "",
  );

  out.push("## 1. Format & composition", "");
  out.push(
    `- **Content box**: ${a.layout.aspect}`,
    `- **Reads as**: ${a.layout.format}`,
    `- **Structure**: ${a.layout.rhythm}`,
  );
  for (const n of a.layout.notes) out.push(`- ${n}`);
  if (a.layout.horizontalBands.length > 1) {
    out.push("", "Horizontal bands (content-box pixels, top to bottom):", "");
    out.push("| band | y-range | height | share | density |", "|---|---|---|---|---|");
    a.layout.horizontalBands.forEach((b, i) =>
      out.push(`| ${i + 1} | ${b.from}–${b.to} | ${b.size}px | ${pct(b.share)} | ${b.density} |`),
    );
  }
  out.push("");

  out.push("## 2. Palette", "", `**Theme**: ${a.theme}`, "", paletteTable(a.palette), "");
  const bg = a.palette[0];
  const fg = a.palette.find((s) => s.role.startsWith("foreground"));
  if (bg && fg) out.push(`Primary pairing \`${bg.hex}\` / \`${fg.hex}\` — surface and body text.`, "");

  let n = 3;
  if (a.motion) {
    out.push(`## ${n++}. Motion`, "", motionSection(a.motion, a.cuts, boxW, boxH));
  }
  out.push(`## ${n++}. Implementation hints`, "", implementationHints(a), "");
  out.push(`## ${n}. Frames attached`, "");

  a.keyframes.forEach((k, i) => out.push(`${i + 1}. **t=${k.t.toFixed(2)}s** — ${k.why}`));
  if (a.sheet) {
    out.push(
      "",
      `A contact sheet is attached as the final image: ${a.sheet.cols}×${a.sheet.rows} tiles, row-major, in the order listed above.`,
    );
  }
  out.push("");

  out.push(
    "## Reliability",
    "",
    "- Timings, dimensions, colours, crop box and loop detection are **measured** from the file.",
    "- Easing names, spring constants and element roles are **inferred** from pixel motion — starting points, not ground truth.",
    "- Displacement comes from whole-frame block matching, so it reports the dominant movement; several elements moving different ways at once will average out.",
    "- Region labels describe *where in the frame* change happens, not what the element is called.",
    "",
  );

  return out.join("\n");
}
