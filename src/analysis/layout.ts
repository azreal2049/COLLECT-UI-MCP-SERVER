export interface Band {
  /** Pixel coordinates in the source image. */
  from: number;
  to: number;
  size: number;
  /** Fraction of the frame this band occupies. */
  share: number;
  density: "empty" | "sparse" | "dense";
}

export interface LayoutAnalysis {
  aspect: string;
  format: string;
  /** Inset of actual content when the shot is matted on a flat background. */
  matte: { top: number; right: number; bottom: number; left: number; color: string } | null;
  horizontalBands: Band[];
  verticalSplits: number[];
  rhythm: string;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function classifyAspect(w: number, h: number): { aspect: string; format: string } {
  const r = w / h;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  const aspect = `${w}×${h} (${w / g}:${h / g}, ratio ${r.toFixed(2)})`;

  let format: string;
  if (r < 0.6) format = "tall portrait — phone screen recording";
  else if (r < 0.9) format = "portrait — mobile or card-shaped surface";
  else if (r < 1.15) format = "square — social / component close-up";
  else if (r < 1.5) format = "landscape 4:3-ish — tablet or cropped desktop";
  else if (r < 2.0) format = "landscape 16:9-ish — desktop UI or presentation frame";
  else format = "ultra-wide — banner, hero strip, or side-by-side comparison";

  return { aspect, format };
}

/**
 * Detect a flat matte around the artwork: designers usually present a UI on a
 * solid background, and knowing the real content box stops an agent from
 * copying the presentation padding into the build.
 */
export function detectMatte(
  rgb: Buffer,
  w: number,
  h: number,
  scaleX: number,
  scaleY: number,
): LayoutAnalysis["matte"] {
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * 3;
    return [rgb[i], rgb[i + 1], rgb[i + 2]];
  };
  const corner = at(0, 0);
  const close = (c: [number, number, number]) =>
    Math.abs(c[0] - corner[0]) + Math.abs(c[1] - corner[1]) + Math.abs(c[2] - corner[2]) < 24;

  const rowUniform = (y: number) => {
    for (let x = 0; x < w; x++) if (!close(at(x, y))) return false;
    return true;
  };
  const colUniform = (x: number) => {
    for (let y = 0; y < h; y++) if (!close(at(x, y))) return false;
    return true;
  };

  let top = 0;
  while (top < h / 2 && rowUniform(top)) top++;
  let bottom = 0;
  while (bottom < h / 2 && rowUniform(h - 1 - bottom)) bottom++;
  let left = 0;
  while (left < w / 2 && colUniform(left)) left++;
  let right = 0;
  while (right < w / 2 && colUniform(w - 1 - right)) right++;

  if (top + bottom + left + right < 2) return null;

  const hex =
    "#" + corner.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return {
    top: Math.round(top * scaleY),
    right: Math.round(right * scaleX),
    bottom: Math.round(bottom * scaleY),
    left: Math.round(left * scaleX),
    color: hex,
  };
}

export interface ContentBox {
  rect: { x: number; y: number; w: number; h: number };
  matte: NonNullable<LayoutAnalysis["matte"]>;
}

/**
 * Turn a detected matte into a source-pixel content rectangle, or null when the
 * artwork already fills the frame. A small safety margin is kept so a soft
 * shadow at the artwork's edge isn't sliced off.
 */
export function detectContentBox(
  rgb: Buffer,
  w: number,
  h: number,
  sourceW: number,
  sourceH: number,
): ContentBox | null {
  const scaleX = sourceW / w;
  const scaleY = sourceH / h;
  const matte = detectMatte(rgb, w, h, scaleX, scaleY);
  if (!matte) return null;

  const marginX = Math.round(sourceW * 0.01);
  const marginY = Math.round(sourceH * 0.01);
  const x = Math.max(0, matte.left - marginX);
  const y = Math.max(0, matte.top - marginY);
  const right = Math.max(0, matte.right - marginX);
  const bottom = Math.max(0, matte.bottom - marginY);
  const boxW = sourceW - x - right;
  const boxH = sourceH - y - bottom;

  // Only worth cropping if it removes real area and leaves a usable frame.
  const area = (boxW * boxH) / (sourceW * sourceH);
  if (area > 0.92 || area < 0.02 || boxW < 32 || boxH < 32) return null;

  return {
    rect: {
      x: Math.round(x / 2) * 2,
      y: Math.round(y / 2) * 2,
      w: Math.round(boxW / 2) * 2,
      h: Math.round(boxH / 2) * 2,
    },
    matte,
  };
}

/** Peak-pick a 1-D signal, returning indices that stand clearly above the local floor. */
function peaks(signal: number[], minProminence: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] >= signal[i - 1] && signal[i] > signal[i + 1] && signal[i] > minProminence) {
      out.push(i);
    }
  }
  return out;
}

export function analyzeLayout(
  gray: Buffer,
  rgb: Buffer,
  w: number,
  h: number,
  sourceW: number,
  sourceH: number,
  /** Matte already removed by cropping, if any — reported rather than re-detected. */
  appliedMatte: LayoutAnalysis["matte"] = null,
): LayoutAnalysis {
  const scaleX = sourceW / w;
  const scaleY = sourceH / h;
  const { aspect, format } = classifyAspect(sourceW, sourceH);
  const notes: string[] = [];

  // Row/column gradient energy → structural edges.
  const rowEdge: number[] = [];
  for (let y = 0; y < h - 1; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += Math.abs(gray[y * w + x] - gray[(y + 1) * w + x]);
    rowEdge.push(s / w);
  }
  const colEdge: number[] = [];
  for (let x = 0; x < w - 1; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += Math.abs(gray[y * w + x] - gray[y * w + x + 1]);
    colEdge.push(s / h);
  }

  const rowMean = rowEdge.reduce((s, v) => s + v, 0) / (rowEdge.length || 1);
  const colMean = colEdge.reduce((s, v) => s + v, 0) / (colEdge.length || 1);

  const bandBoundaries = [0, ...peaks(rowEdge, rowMean * 2.2), h - 1];
  const verticalSplits = peaks(colEdge, colMean * 2.6).map((x) => Math.round(x * scaleX));

  // Per-row content density → tell whitespace apart from populated bands.
  const rowVariance: number[] = [];
  for (let y = 0; y < h; y++) {
    let sum = 0;
    let sq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      sum += v;
      sq += v * v;
    }
    const m = sum / w;
    rowVariance.push(Math.sqrt(Math.max(0, sq / w - m * m)));
  }
  const varMax = Math.max(...rowVariance, 1);

  const horizontalBands: Band[] = [];
  for (let i = 0; i < bandBoundaries.length - 1; i++) {
    const a = bandBoundaries[i];
    const b = bandBoundaries[i + 1];
    if (b - a < Math.max(2, h * 0.03)) continue; // ignore hairline splits
    let v = 0;
    for (let y = a; y <= b; y++) v += rowVariance[y];
    const density = v / (b - a + 1) / varMax;
    horizontalBands.push({
      from: Math.round(a * scaleY),
      to: Math.round(b * scaleY),
      size: Math.round((b - a) * scaleY),
      share: (b - a) / h,
      density: density < 0.12 ? "empty" : density < 0.4 ? "sparse" : "dense",
    });
  }

  const matte = appliedMatte ?? detectMatte(rgb, w, h, scaleX, scaleY);
  if (matte) {
    notes.push(
      `Artwork sits on a flat ${matte.color} matte (inset T${matte.top} R${matte.right} B${matte.bottom} L${matte.left}px in the original frame) — that padding is presentation, not part of the UI.`,
    );
  }

  const gaps = horizontalBands.filter((b) => b.density === "empty");
  if (gaps.length >= 2) {
    const sizes = gaps.map((g) => g.size).sort((a, b) => a - b);
    const mid = sizes[Math.floor(sizes.length / 2)];
    notes.push(`Recurring vertical whitespace around ${mid}px — a plausible spacing unit.`);
  }
  if (verticalSplits.length >= 1 && verticalSplits.length <= 4) {
    notes.push(
      `Strong vertical edges at x≈${verticalSplits.join(", ")}px — likely column or sidebar boundaries.`,
    );
  }

  const dense = horizontalBands.filter((b) => b.density === "dense").length;
  const rhythm =
    horizontalBands.length <= 2
      ? "single-block composition"
      : `${horizontalBands.length} horizontal bands (${dense} content-dense), reading top-to-bottom`;

  return {
    aspect,
    format,
    matte,
    horizontalBands: horizontalBands.slice(0, 12),
    verticalSplits: verticalSplits.slice(0, 8),
    rhythm,
    notes,
  };
}

export const clampInt = clamp;
