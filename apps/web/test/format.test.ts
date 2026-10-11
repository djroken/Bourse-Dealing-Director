import { describe, expect, it } from "vitest";
import { cm, fmt, fmtQty, hms, money, path, walk } from "../lib/desk/format";

describe("format", () => {
  it("fmt groups digits, fixes decimals and dashes out bad input", () => {
    expect(fmt(86712.5, 2)).toBe("86,712.50");
    expect(fmt(0, 0)).toBe("0");
    expect(fmt(null, 2)).toBe("—");
    expect(fmt(undefined, 2)).toBe("—");
    expect(fmt(Number.NaN, 2)).toBe("—");
  });
  it("money is signed and rounded", () => {
    expect(money(1234.6)).toBe("+$1,235");
    expect(money(-1234.4)).toBe("-$1,234");
    expect(money(0)).toBe("+$0");
  });
  it("cm compacts to k / M / B", () => {
    expect(cm(95)).toBe("$95");
    expect(cm(620_000)).toBe("$620.0k");
    expect(cm(1_840_000)).toBe("$1.84M");
    expect(cm(-2_500_000_000)).toBe("$2.50B");
  });
  it("fmtQty keeps precision for small sizes", () => {
    expect(fmtQty(0.0992)).toBe("0.0992");
    expect(fmtQty(7.2)).toBe("7.20");
    expect(fmtQty(30000)).toBe("30,000");
  });
  it("hms is UTC", () => {
    expect(hms(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("03:04:05");
  });
});

describe("path / walk", () => {
  it("builds a path that fits the box", () => {
    const d = path([1, 2, 3, 2], 100, 30, false);
    expect(d.startsWith("M")).toBe(true);
    const ys = [...d.matchAll(/ (-?\d+\.\d)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(30);
  });
  it("closes the area fill when asked", () => {
    expect(path([1, 2], 10, 10, true)).toMatch(/Z$/);
  });
  it("survives a flat or single-point series", () => {
    expect(path([5, 5, 5], 10, 10, false)).not.toMatch(/NaN/);
    expect(path([5], 10, 10, false)).not.toMatch(/NaN/);
  });
  it("walk is deterministic and finite", () => {
    const a = walk(50, 7, 0.1);
    expect(a).toEqual(walk(50, 7, 0.1));
    expect(a).toHaveLength(50);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(walk(50, 8, 0.1)).not.toEqual(a);
  });
});
