import { describe, expect, test } from "bun:test";
import { normalizeLogLinesForDisplay } from "./log-lines";

describe("normalizeLogLinesForDisplay", () => {
  test("splits regular newline characters into separate lines", () => {
    expect(normalizeLogLinesForDisplay(["a\nb", "c"])).toEqual(["a", "b", "c"]);
  });

  test("splits escaped newline sequences into separate lines", () => {
    expect(normalizeLogLinesForDisplay(["a\\nb", "c\\r\\nd"])).toEqual(["a", "b", "c", "d"]);
  });

  test("keeps empty state text when no logs exist", () => {
    expect(normalizeLogLinesForDisplay([])).toEqual([]);
  });
});
