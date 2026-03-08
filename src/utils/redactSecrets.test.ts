import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redactSecrets";

describe("redactSecrets", () => {
  test("masks env-style secret fields and leaves non-secret fields unchanged", () => {
    const input = {
      OPENAI_API_KEY: "sk-test-secret",
      GITHUB_TOKEN: "ghp_test_token",
      SESSION_SECRET: "super-secret-value",
      LOG_LEVEL: "debug",
      APP_NAME: "ailoop"
    };

    expect(redactSecrets(input)).toEqual({
      OPENAI_API_KEY: "[REDACTED]",
      GITHUB_TOKEN: "[REDACTED]",
      SESSION_SECRET: "[REDACTED]",
      LOG_LEVEL: "debug",
      APP_NAME: "ailoop"
    });
  });
});
