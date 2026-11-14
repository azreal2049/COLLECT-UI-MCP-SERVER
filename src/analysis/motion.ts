import { CELLS_X, CELLS_Y } from "../config.js";
import type { RawFrames } from "../ffmpeg.js";

/* ------------------------------------------------------------------ *
 * Easing vocabulary
 * ------------------------------------------------------------------ */

export interface EasingCandidate {
  name: string;
  css: string;
  p: [number, number, number, number];
}

const EASINGS: EasingCandidate[] = [
  { name: "linear", css: "linear", p: [0, 0, 1, 1] },
  { name: "ease", css: "cubic-bezier(0.25, 0.1, 0.25, 1)", p: [0.25, 0.1, 0.25, 1] },
  { name: "ease-in", css: "cubic-bezier(0.42, 0, 1, 1)", p: [0.42, 0, 1, 1] },
  { name: "ease-out", css: "cubic-bezier(0, 0, 0.58, 1)", p: [0, 0, 0.58, 1] },
  { name: "ease-in-out", css: "cubic-bezier(0.42, 0, 0.58, 1)", p: [0.42, 0, 0.58, 1] },
  { name: "material-standard", css: "cubic-bezier(0.4, 0, 0.2, 1)", p: [0.4, 0, 0.2, 1] },
  { name: "material-decelerate", css: "cubic-bezier(0, 0, 0.2, 1)", p: [0, 0, 0.2, 1] },
  { name: "material-accelerate", css: "cubic-bezier(0.4, 0, 1, 1)", p: [0.4, 0, 1, 1] },
  { name: "quint-out (iOS-like)", css: "cubic-bezier(0.22, 1, 0.36, 1)", p: [0.22, 1, 0.36, 1] },
  { name: "expo-out (snappy)", css: "cubic-bezier(0.16, 1, 0.3, 1)", p: [0.16, 1, 0.3, 1] },
  { name: "circ-out", css: "cubic-bezier(0, 0.55, 0.45, 1)", p: [0, 0.55, 0.45, 1] },
  { name: "quart-in-out", css: "cubic-bezier(0.76, 0, 0.24, 1)", p: [0.76, 0, 0.24, 1] },
  { name: "back-out (overshoot)", css: "cubic-bezier(0.34, 1.56, 0.64, 1)", p: [0.34, 1.56, 0.64, 1] },
  { name: "anticipate (back-in)", css: "cubic-bezier(0.36, 0, 0.66, -0.56)", p: [0.36, 0, 0.66, -0.56] },
];

const bezAxis = (t: number, a: number, b: number) => {
  const mt = 1 - t;
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
};

/** Solve x(s) = target for s, then return y(s). Bisection: robust for any control points. */
function bezierAt(x: number, [x1, y1, x2, y2]: [number, number, number, number]): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let s = x;
  for (let i = 0; i < 40; i++) {
    s = (lo + hi) / 2;
    const cx = bezAxis(s, x1, x2);
    if (cx < x) lo = s;
    else hi = s;
  }
  return bezAxis(s, y1, y2);
}

export interface EasingFit {
  name: string;
  css: string;
  rmse: number;
  /** Coefficient of determination against the observed progress curve. */
  r2: number;
}

/** Fit observed normalised progress (time 0..1 → progress 0..1) against the easing library. */
export function fitEasing(progress: Array<{ t: number; p: number }>): EasingFit[] {
  if (progress.length < 4) return [];
  const mean = progress.reduce((s, q) => s + q.p, 0) / progress.length;
  const ssTot = progress.reduce((s, q) => s + (q.p - mean) ** 2, 0) || 1e-9;

  return EASINGS.map((e) => {
    let ssRes = 0;
    for (const { t, p } of progress) ssRes += (p - bezierAt(t, e.p)) ** 2;
    return {
      name: e.name,
      css: e.css,
      rmse: Math.sqrt(ssRes / progress.length),
      r2: 1 - ssRes / ssTot,
    };
  }).sort((a, b) => a.rmse - b.rmse);
}

/* ------------------------------------------------------------------ *
 * Frame-level primitives
 * ------------------------------------------------------------------ */

/** Mean absolute luma difference between two gray frames, 0..255. */
function frameDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Per-cell absolute difference energy on a CELLS_X × CELLS_Y grid. */
function cellDiff(a: Buffer, b: Buffer, w: number, h: number): number[] {
  const cells = new Array(CELLS_X * CELLS_Y).fill(0);
  const counts = new Array(CELLS_X * CELLS_Y).fill(0);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(CELLS_Y - 1, Math.floor((y / h) * CELLS_Y));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(CELLS_X - 1, Math.floor((x / w) * CELLS_X));
      const idx = cy * CELLS_X + cx;
      cells[idx] += Math.abs(a[y * w + x] - b[y * w + x]);
      counts[idx]++;
    }
  }
  return cells.map((v, i) => v / (counts[i] || 1));
}

const meanLuma = (f: Buffer) => {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i];
  return s / f.length;
};

/**
 * Estimate whole-frame translation between two frames by minimising SAD over a
 * shift grid. Returns null when no shift meaningfully beats "no shift" — i.e.
 * the change is not a translation (a fade, a reveal, a colour change).
 */
function estimateShift(
  a: Buffer,
  b: Buffer,
  w: number,
  h: number,
  radius = 6,
): { dx: number; dy: number; confidence: number } | null {
  const sad = (dx: number, dy: number) => {
    let sum = 0;
    let n = 0;
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
      for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
        sum += Math.abs(a[y * w + x] - b[(y + dy) * w + (x + dx)]);
        n++;
      }
    }
    return n ? sum / n : Infinity;
  };

  const zero = sad(0, 0);
  let best = { dx: 0, dy: 0, score: zero };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!dx && !dy) continue;
      const s = sad(dx, dy);
      if (s < best.score) best = { dx, dy, score: s };
    }
  }
  if (best.dx === 0 && best.dy === 0) return null;
  // Require a clear improvement over the stationary hypothesis.
  const improvement = (zero - best.score) / (zero || 1);
  if (improvement < 0.15) return null;
  return { dx: best.dx, dy: best.dy, confidence: improvement };
}

/* ------------------------------------------------------------------ *
 * Segmentation
 * ------------------------------------------------------------------ */

export type SegmentKind = "hold" | "transition" | "sustained";

export interface MotionSegment {
  kind: SegmentKind;
  start: number;
  end: number;
  duration: number;
  peakEnergy: number;
  peakTime: number;
  meanEnergy: number;
  /** Normalised 0..1 energy per grid cell, row-major CELLS_Y × CELLS_X. */
  cellEnergy: number[];
  asciiMap: string;
  focus: string;
  /** Share of change energy inside the top quartile of cells. */
  concentration: number;
  translation: { dx: number; dy: number; label: string } | null;
  luminanceDelta: number;
  easing: EasingFit[];
  overshoot: number | null;
  /** How many sampled frames back this segment — few samples means a soft easing fit. */
  samples: number;
  /** Best guess at what kind of change this is. */
  character: string;
}

export interface MotionAnalysis {
  duration: number;
  sampledFps: number;
  frameCount: number;
  energy: number[];
  times: number[];
  segments: MotionSegment[];
  loop: { seamless: boolean; similarity: number; period: number | null };
  staticRatio: number;
  busiestTime: number;
  overallAsciiMap: string;
  summary: string;
}

const RAMP = " ░▒▓█";

function asciiMap(cells: number[]): string {
  const max = Math.max(...cells, 1e-6);
  const lines: string[] = [];
  for (let y = 0; y < CELLS_Y; y++) {
    let line = "";
    for (let x = 0; x < CELLS_X; x++) {
      const v = cells[y * CELLS_X + x] / max;
      line += RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))];
    }
    lines.push(`  |${line}|`);
  }
  return lines.join("\n");
}

function describeFocus(cells: number[]): { focus: string; concentration: number } {
  const total = cells.reduce((s, v) => s + v, 0) || 1e-9;
  const sorted = [...cells].sort((a, b) => b - a);
  const topCount = Math.max(1, Math.round(cells.length * 0.25));
  const concentration = sorted.slice(0, topCount).reduce((s, v) => s + v, 0) / total;

  let sx = 0;
  let sy = 0;
  for (let y = 0; y < CELLS_Y; y++) {
    for (let x = 0; x < CELLS_X; x++) {
      const v = cells[y * CELLS_X + x];
      sx += ((x + 0.5) / CELLS_X) * v;
      sy += ((y + 0.5) / CELLS_Y) * v;
    }
  }
  const cx = sx / total;
  const cy = sy / total;

  if (concentration < 0.45) return { focus: "full-frame (change spread evenly)", concentration };

  const vert = cy < 0.28 ? "top" : cy < 0.45 ? "upper" : cy < 0.62 ? "middle" : cy < 0.8 ? "lower" : "bottom";
  const horiz = cx < 0.28 ? "left" : cx < 0.45 ? "centre-left" : cx < 0.62 ? "centre" : cx < 0.8 ? "centre-right" : "right";
  return { focus: `${vert}-${horiz}`, concentration };
}

function translationLabel(dx: number, dy: number): string {
  const parts: string[] = [];
  if (Math.abs(dx) >= 1) parts.push(dx > 0 ? `right ${Math.abs(dx)}px` : `left ${Math.abs(dx)}px`);
  if (Math.abs(dy) >= 1) parts.push(dy > 0 ? `down ${Math.abs(dy)}px` : `up ${Math.abs(dy)}px`);
  return parts.length ? `content travels ${parts.join(" + ")}` : "sub-pixel drift";
}

/** Dominant repeat period (seconds) of the energy curve via autocorrelation. */
function dominantPeriod(energy: number[], fps: number): number | null {
  if (energy.length < 12) return null;
  const mean = energy.reduce((s, v) => s + v, 0) / energy.length;
  const centred = energy.map((v) => v - mean);
  const denom = centred.reduce((s, v) => s + v * v, 0) || 1e-9;

  let best: { lag: number; score: number } | null = null;
  const maxLag = Math.floor(energy.length / 2);
  // Ignore lags under ~250ms: at high sample rates those are frame-to-frame
  // noise, not a rhythm anyone would perceive or implement.
  const minLag = Math.max(2, Math.round(fps * 0.25));
  if (minLag >= maxLag) return null;
  for (let lag = minLag; lag < maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < centred.length; i++) s += centred[i] * centred[i + lag];
    const score = s / denom;
    if (!best || score > best.score) best = { lag, score };
  }
  if (!best || best.score < 0.4) return null;
  return best.lag / fps;
}

export function analyzeMotion(raw: RawFrames, sourceWidth: number, sourceHeight: number): MotionAnalysis {
  const { frames, w, h, fps, times } = raw;
  const scaleX = sourceWidth / w;
  const scaleY = sourceHeight / h;

  // 1. Energy curve (one value per frame transition, indexed to the later frame).
  const energy: number[] = [0];
  const cellSeries: number[][] = [new Array(CELLS_X * CELLS_Y).fill(0)];
  for (let i = 1; i < frames.length; i++) {
    energy.push(frameDiff(frames[i - 1], frames[i]));
    cellSeries.push(cellDiff(frames[i - 1], frames[i], w, h));
  }

  // 2. Adaptive threshold: separate "moving" from "still" frames.
  const sorted = [...energy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const peak = sorted[sorted.length - 1];
  const threshold = Math.max(median * 2.5, peak * 0.08, 0.35);

  const moving = energy.map((e) => e > threshold);

  // 3. Run-length segmentation, then drop runs too short to be meaningful.
  const minFrames = Math.max(2, Math.round(fps * 0.1));
  const runs: Array<{ moving: boolean; from: number; to: number }> = [];
  let cur = { moving: moving[0], from: 0, to: 0 };
  for (let i = 1; i < moving.length; i++) {
    if (moving[i] === cur.moving) cur.to = i;
    else {
      runs.push({ ...cur });
      cur = { moving: moving[i], from: i, to: i };
    }
  }
  runs.push({ ...cur });

  const absorbed: typeof runs = [];
  for (const r of runs) {
    const len = r.to - r.from + 1;
    if (absorbed.length && len < minFrames) absorbed[absorbed.length - 1].to = r.to;
    else absorbed.push({ ...r });
  }

  // Absorbing a blip can leave two same-kind runs touching; fuse them.
  const merged: typeof runs = [];
  for (const r of absorbed) {
    const last = merged[merged.length - 1];
    if (last && last.moving === r.moving) last.to = r.to;
    else merged.push({ ...r });
  }

  // 4. Per-segment characterisation.
  const segments: MotionSegment[] = merged.map((r) => {
    const idx = Array.from({ length: r.to - r.from + 1 }, (_, k) => r.from + k);
    const segEnergy = idx.map((i) => energy[i]);
    const meanEnergy = segEnergy.reduce((s, v) => s + v, 0) / segEnergy.length;
    const peakEnergy = Math.max(...segEnergy);
    const peakTime = times[idx[segEnergy.indexOf(peakEnergy)]] ?? times[r.from];

    const cells = new Array(CELLS_X * CELLS_Y).fill(0);
    for (const i of idx) for (let c = 0; c < cells.length; c++) cells[c] += cellSeries[i][c];

    const { focus, concentration } = describeFocus(cells);
    const start = times[r.from];
    const end = times[r.to] + 1 / fps;
    const duration = end - start;

    // Cumulative-energy progress curve → easing fit.
    const total = segEnergy.reduce((s, v) => s + v, 0);
    const progress: Array<{ t: number; p: number }> = [];
    let acc = 0;
    for (let k = 0; k < idx.length; k++) {
      acc += segEnergy[k];
      progress.push({ t: (k + 1) / idx.length, p: total ? acc / total : 0 });
    }

    // Translation: accumulate frame-to-frame shift estimates across the segment.
    let dx = 0;
    let dy = 0;
    let shiftVotes = 0;
    const displacement: number[] = [0];
    for (const i of idx) {
      if (i < 1) continue;
      const s = estimateShift(frames[i - 1], frames[i], w, h);
      if (s) {
        dx += s.dx;
        dy += s.dy;
        shiftVotes++;
      }
      displacement.push(Math.hypot(dx, dy));
    }
    const translation =
      shiftVotes >= Math.max(2, idx.length * 0.3)
        ? {
            dx: Math.round(dx * scaleX),
            dy: Math.round(dy * scaleY),
            label: translationLabel(Math.round(dx * scaleX), Math.round(dy * scaleY)),
          }
        : null;

    // Overshoot: peak displacement beyond the settled value.
    let overshoot: number | null = null;
    if (displacement.length > 3) {
      const finalD = displacement[displacement.length - 1];
      const maxD = Math.max(...displacement);
      if (finalD > 0.5 && maxD > finalD * 1.03) overshoot = (maxD / finalD - 1) * 100;
    }

    const luminanceDelta = meanLuma(frames[r.to]) - meanLuma(frames[r.from]);

    const isMoving = r.moving;
    const kind: SegmentKind = !isMoving ? "hold" : duration > 0.9 ? "sustained" : "transition";

    let character: string;
    if (!isMoving) {
      character = "static hold — nothing animates";
    } else if (translation) {
      character = `translation — ${translation.label}`;
    } else if (Math.abs(luminanceDelta) > 6 && concentration < 0.5) {
      character = luminanceDelta > 0 ? "global fade-in / brighten" : "global fade-out / darken";
    } else if (concentration > 0.7) {
      character = "localised change — element enters, morphs, or toggles in place";
    } else {
      character = "multi-region change — several elements animate together";
    }

    return {
      kind,
      start,
      end,
      duration,
      peakEnergy,
      peakTime,
      meanEnergy,
      cellEnergy: cells,
      asciiMap: asciiMap(cells),
      focus,
      concentration,
      translation,
      luminanceDelta,
      easing: isMoving ? fitEasing(progress).slice(0, 3) : [],
      overshoot,
      samples: idx.length,
      character,
    };
  });

  // 5. Loop detection: does the last frame return to the first?
  const first = frames[0];
  const last = frames[frames.length - 1];
  const loopDiff = frameDiff(first, last);
  const seamless = loopDiff < Math.max(threshold, 2.0);

  const totalCells = new Array(CELLS_X * CELLS_Y).fill(0);
  for (const cs of cellSeries) for (let c = 0; c < totalCells.length; c++) totalCells[c] += cs[c];

  const staticFrames = moving.filter((m) => !m).length;
  const busiest = energy.indexOf(Math.max(...energy));

  const movingSegments = segments.filter((s) => s.kind !== "hold");
  const summary =
    movingSegments.length === 0
      ? "No motion detected — treat as a still frame."
      : `${movingSegments.length} animated passage${movingSegments.length === 1 ? "" : "s"} across ` +
        `${(raw.times[raw.times.length - 1] + 1 / fps).toFixed(2)}s; ` +
        `${Math.round((staticFrames / moving.length) * 100)}% of the timeline is held still.`;

  return {
    duration: times[times.length - 1] + 1 / fps,
    sampledFps: fps,
    frameCount: frames.length,
    energy,
    times,
    segments,
    loop: {
      seamless,
      similarity: Math.max(0, 1 - loopDiff / 32),
      period: dominantPeriod(energy, fps),
    },
    staticRatio: staticFrames / moving.length,
    busiestTime: times[busiest] ?? 0,
    overallAsciiMap: asciiMap(totalCells),
    summary,
  };
}

/**
 * Choose the frames worth actually looking at: segment boundaries, energy peaks
 * and the middle of each hold — never a uniform sample.
 */
export function selectKeyframes(m: MotionAnalysis, max = 8): Array<{ t: number; why: string }> {
  const picks: Array<{ t: number; why: string }> = [];
  const push = (t: number, why: string) => {
    if (t < 0 || t > m.duration) return;
    if (picks.some((p) => Math.abs(p.t - t) < Math.max(0.06, m.duration * 0.02))) return;
    picks.push({ t, why });
  };

  push(0, "opening frame — the resting state before anything moves");
  for (const s of m.segments) {
    if (s.kind === "hold") {
      push(s.start + s.duration / 2, `held state ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`);
    } else {
      push(s.start, `start of ${s.kind} at ${s.start.toFixed(2)}s`);
      push(s.peakTime, `peak of motion (${s.character.split(" — ")[0]})`);
      push(Math.max(0, s.end - 1 / m.sampledFps), `settled state after ${s.start.toFixed(2)}s ${s.kind}`);
    }
  }
  push(Math.max(0, m.duration - 1 / m.sampledFps), "final frame — the end state");

  picks.sort((a, b) => a.t - b.t);
  if (picks.length <= max) return picks;

  // Thin evenly across the timeline while keeping first and last.
  const keep = [picks[0]];
  const step = (picks.length - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) keep.push(picks[Math.round(i * step)]);
  keep.push(picks[picks.length - 1]);
  return keep.filter((p, i, a) => i === 0 || p.t !== a[i - 1].t);
}
