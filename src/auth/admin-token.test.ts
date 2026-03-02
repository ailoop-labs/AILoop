import { describe, expect, test } from "bun:test";
import { isDateBasedAdminTokenExpired } from "./admin-token";

describe("isDateBasedAdminTokenExpired", () => {
  test("returns false when auth is disabled", () => {
    expect(
      isDateBasedAdminTokenExpired({
        tokenAuthEnabled: false,
        adminTokenIssuedDate: "2026-03-01",
        now: new Date("2026-03-10T00:00:00.000Z")
      })
    ).toBe(false);
  });

  test("returns false when issued date is missing", () => {
    expect(
      isDateBasedAdminTokenExpired({
        tokenAuthEnabled: true,
        adminTokenIssuedDate: "",
        now: new Date("2026-03-10T00:00:00.000Z")
      })
    ).toBe(false);
  });

  test("keeps token valid through the first 7 UTC days", () => {
    expect(
      isDateBasedAdminTokenExpired({
        tokenAuthEnabled: true,
        adminTokenIssuedDate: "2026-03-02",
        now: new Date("2026-03-08T23:59:59.000Z")
      })
    ).toBe(false);
  });

  test("expires token on the 8th UTC day", () => {
    expect(
      isDateBasedAdminTokenExpired({
        tokenAuthEnabled: true,
        adminTokenIssuedDate: "2026-03-02",
        now: new Date("2026-03-09T00:00:00.000Z")
      })
    ).toBe(true);
  });

  test("treats invalid issued date as expired", () => {
    expect(
      isDateBasedAdminTokenExpired({
        tokenAuthEnabled: true,
        adminTokenIssuedDate: "not-a-date",
        now: new Date("2026-03-10T00:00:00.000Z")
      })
    ).toBe(true);
  });
});
