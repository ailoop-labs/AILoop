const SECRET_ENV_KEY_PATTERN = /TOKEN|KEY|SECRET/i;

export const REDACTED_SECRET_VALUE = "[REDACTED]";

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_PATTERN.test(key);
}

export function redactSecrets<T extends Record<string, string | undefined>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (isSecretEnvKey(key) && value) {
        return [key, REDACTED_SECRET_VALUE];
      }

      return [key, value];
    })
  ) as T;
}
