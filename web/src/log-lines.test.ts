import { describe, expect, test } from "bun:test";
import { buildLogViewerText, normalizeLogLinesForDisplay } from "./log-lines";

describe("normalizeLogLinesForDisplay", () => {
  test("splits regular newline characters into separate lines", () => {
    expect(normalizeLogLinesForDisplay(["a\nb", "c"])).toEqual(["a", "b", "c"]);
  });

  test("splits escaped newline sequences into separate lines", () => {
    expect(normalizeLogLinesForDisplay(["a\\nb", "c\\r\\nd"])).toEqual(["a", "b", "c", "d"]);
  });

  test("splits carriage return line breaks into separate lines", () => {
    expect(normalizeLogLinesForDisplay(["a\rb"])).toEqual(["a", "b"]);
  });

  test("keeps empty state text when no logs exist", () => {
    expect(normalizeLogLinesForDisplay([])).toEqual([]);
  });
});

describe("buildLogViewerText", () => {
  test("converts mixed line break styles to newline-delimited text", () => {
    expect(buildLogViewerText(["a\\nb", "c\r\nd", "e"])).toBe("a\nb\nc\nd\ne");
  });
});
