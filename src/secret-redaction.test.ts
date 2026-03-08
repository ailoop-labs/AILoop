import { describe, expect, test } from "bun:test";
import { redactSecretEnvValues } from "./secret-redaction";

describe("redactSecretEnvValues", () => {
  test("masks values whose env-style keys contain TOKEN, KEY, or SECRET", () => {
    expect(
      redactSecretEnvValues({
        OPENAI_API_KEY: "sk-test-secret",
        GITHUB_TOKEN: "ghp_test_token",
        SESSION_SECRET: "super-secret-value",
        LOG_LEVEL: "debug"
      })
    ).toEqual({
      OPENAI_API_KEY: "[REDACTED]",
      GITHUB_TOKEN: "[REDACTED]",
      SESSION_SECRET: "[REDACTED]",
      LOG_LEVEL: "debug"
    });
  });
});
