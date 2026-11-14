export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  hsl: [number, number, number];
  /** Share of sampled pixels, 0..1. */
  coverage: number;
  role: string;
}

const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

const srgbToLin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Bucket pixels into a coarse RGB grid, then refine the most populated buckets
 * into true centroids. Cheap, deterministic, and stable across frames — which
 * matters because the same shot must not yield a different palette each call.
 */
export function extractPalette(rgb: Buffer, topN = 6): Swatch[] {
  const BITS = 4; // 16 levels per channel
  const SHIFT = 8 - BITS;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();

  const pixels = rgb.length / 3;
  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    const e = buckets.get(key);
    if (e) {
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  }

  const centroids = [...buckets.values()]
    .map((e) => ({
      n: e.n,
      rgb: [e.r / e.n, e.g / e.n, e.b / e.n] as [number, number, number],
    }))
    .sort((a, b) => b.n - a.n);

  // Merge centroids that are perceptually adjacent so the palette isn't 6 greys.
  const kept: Array<{ n: number; rgb: [number, number, number] }> = [];
  const near = (a: [number, number, number], b: [number, number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 34;

  for (const c of centroids) {
    const hit = kept.find((k) => near(k.rgb, c.rgb));
    if (hit) {
      const total = hit.n + c.n;
      hit.rgb = [
        (hit.rgb[0] * hit.n + c.rgb[0] * c.n) / total,
        (hit.rgb[1] * hit.n + c.rgb[1] * c.n) / total,
        (hit.rgb[2] * hit.n + c.rgb[2] * c.n) / total,
      ];
      hit.n = total;
    } else if (kept.length < topN * 3) {
      kept.push({ n: c.n, rgb: [...c.rgb] as [number, number, number] });
    }
  }

  kept.sort((a, b) => b.n - a.n);
  const top = kept.slice(0, topN);
  const bg = top[0];

  return top.map((c, i) => {
    const rgbInt: [number, number, number] = [
      Math.round(c.rgb[0]),
      Math.round(c.rgb[1]),
      Math.round(c.rgb[2]),
    ];
    const hsl = rgbToHsl(...rgbInt);
    const coverage = c.n / pixels;

    let role: string;
    if (i === 0) {
      role = hsl[2] < 45 ? "background (dark surface)" : "background (light surface)";
    } else {
      const contrast = contrastRatio(rgbInt, [
        Math.round(bg.rgb[0]),
        Math.round(bg.rgb[1]),
        Math.round(bg.rgb[2]),
      ]);
      if (hsl[1] > 45 && coverage < 0.2) role = `accent (contrast ${contrast.toFixed(1)}:1 vs bg)`;
      else if (contrast >= 4.5) role = `foreground / text-safe (contrast ${contrast.toFixed(1)}:1)`;
      else role = `surface / muted (contrast ${contrast.toFixed(1)}:1)`;
    }

    return { hex: toHex(...rgbInt), rgb: rgbInt, hsl, coverage, role };
  });
}

export function describeTheme(palette: Swatch[]): string {
  if (!palette.length) return "unknown";
  const bg = palette[0];
  const sat = palette.filter((p) => p.hsl[1] > 40);
  const tone = bg.hsl[2] < 25 ? "dark" : bg.hsl[2] < 55 ? "mid-tone" : "light";
  const chroma =
    sat.length === 0 ? "monochrome" : sat.length === 1 ? "single-accent" : `${sat.length}-colour accent set`;
  return `${tone} theme, ${chroma}`;
}
