// Theme engine. Every colour in the Desk is a CSS variable named after its dark hex
// (--c161A20, --w07 …), so a theme is just a variable map applied to <html>.
// Dark is the default and lives in globals.css; this file only produces overrides.

export type ThemeName = "dark" | "light" | "system" | "glass";
export type ResolvedTheme = "dark" | "light" | "glass";

export const THEME_KEY = "hermes.theme.v1";
export const GLASS_KEY = "hermes.glass.v1";
export const DEFAULT_GLASS_ALPHA = 0.52;

export const THEME_LIST: ReadonlyArray<readonly [ThemeName, string, string]> = [
  ["dark", "DARK", "Graphite dark"],
  ["light", "LIGHT", "Light"],
  ["system", "SYS", "Follow system setting"],
  ["glass", "GLASS", "Frosted glass"],
];

const ALPHAS = ["03", "04", "05", "06", "07", "08", "09", "10", "12", "14", "25", "30"];

const LIGHT: Record<string, string> = {
  "0F1216": "#ECEEF2", "12161B": "#F3F5F8", "161A20": "#FFFFFF", "171C22": "#FFFFFF", "191E25": "#F7F8FA",
  "1A1F26": "#FBFCFD", "1E242C": "#F0F3F6",
  F2F5F7: "#10141A", EDF1F4: "#141920", E6EAEE: "#181D24", E1E7ED: "#1E242C", D5DCE2: "#28303A",
  C9D2DA: "#323A44", C1CAD2: "#38414B", B4BEC7: "#434D58", A9B3BC: "#4C5661", "98A3AD": "#56616C",
  "9AA5B1": "#56616C", "8C97A2": "#616C78", "7C8894": "#6B7783", "6B7681": "#717D89", "5D6873": "#7B8692",
  "4E5862": "#87929D", "3F4750": "#9AA4AE",
  FF9E2C: "#C46A00", FFB255: "#D97A00", FFC078: "#A85E00", FFB13D: "#A86400",
  "3ECF8E": "#0E8A54", FF7A7A: "#CC3131", FF8E8E: "#C22F2F", FF9A9A: "#C22F2F", FF5B5B: "#D93C3C",
  "14110C": "#FFFFFF",
};

const GLASS_BASE: Record<string, string> = {
  "0F1216":
    "radial-gradient(1100px 680px at 8% -12%, rgba(255,158,44,0.16), transparent 62%), radial-gradient(900px 620px at 105% 110%, rgba(86,118,168,0.22), transparent 60%), #0A0C10",
  "12161B": "rgba(0,0,0,0.28)",
  "161A20": "rgba(26,31,39,0.52)",
  "171C22": "rgba(26,31,39,0.82)",
  "191E25": "rgba(255,255,255,0.03)",
  "1A1F26": "rgba(255,255,255,0.045)",
  "1E242C": "rgba(255,255,255,0.08)",
};

export function themeVars(name: ResolvedTheme, glassAlpha: number): Record<string, string> {
  const g = glassAlpha;
  const v: Record<string, string> = {};
  if (name === "light") {
    for (const h of Object.keys(LIGHT)) v["--c" + h] = LIGHT[h];
    for (const a of ALPHAS) v["--w" + a] = "rgba(16,24,40," + Math.min(0.5, (parseInt(a, 10) / 100) * 1.3).toFixed(3) + ")";
    v["--glass"] = "none";
  } else if (name === "glass") {
    for (const h of Object.keys(GLASS_BASE)) v["--c" + h] = GLASS_BASE[h];
    v["--c161A20"] = "rgba(26,31,39," + g.toFixed(2) + ")";
    v["--c171C22"] = "rgba(26,31,39," + Math.min(0.97, g + 0.3).toFixed(2) + ")";
    v["--c191E25"] = "rgba(255,255,255," + (0.01 + g * 0.04).toFixed(3) + ")";
    v["--c1A1F26"] = "rgba(255,255,255," + (0.02 + g * 0.05).toFixed(3) + ")";
    v["--c12161B"] = "rgba(0,0,0," + (0.12 + g * 0.3).toFixed(2) + ")";
    v["--glass"] = "blur(18px) saturate(140%)";
  } else {
    v["--glass"] = "none";
  }
  return v;
}

/** Page background painted on <html>, so overscroll and pre-hydration match the theme. */
export function pageBackground(name: ResolvedTheme): string {
  return name === "light" ? "#ECEEF2" : "#0A0C10";
}
