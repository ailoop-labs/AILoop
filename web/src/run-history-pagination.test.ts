import { describe, expect, test } from "bun:test";
import { paginateRunHistory } from "./run-history-pagination";

describe("paginateRunHistory", () => {
  test("returns 5 items on the first page by default", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({ id: index + 1 }));
    const result = paginateRunHistory(runs, 1);

    expect(result.items).toHaveLength(5);
    expect(result.items[0]?.id).toBe(1);
    expect(result.items[4]?.id).toBe(5);
    expect(result.totalPages).toBe(3);
    expect(result.currentPage).toBe(1);
    expect(result.startIndex).toBe(0);
  });

  test("returns the last partial page when data is not divisible by page size", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({ id: index + 1 }));
    const result = paginateRunHistory(runs, 3);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).toBe(11);
    expect(result.items[1]?.id).toBe(12);
    expect(result.currentPage).toBe(3);
    expect(result.startIndex).toBe(10);
  });

  test("clamps page number when it is out of bounds", () => {
    const runs = Array.from({ length: 3 }, (_, index) => ({ id: index + 1 }));
    const result = paginateRunHistory(runs, 99);

    expect(result.totalPages).toBe(1);
    expect(result.currentPage).toBe(1);
    expect(result.items).toHaveLength(3);
    expect(result.startIndex).toBe(0);
  });
});
