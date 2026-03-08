export const SECRET_ENV_KEY_PATTERN = /TOKEN|KEY|SECRET/i;

export const REDACTED_SECRET_VALUE = "[REDACTED]";

const SECRET_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET)[A-Z0-9_]*)\s*=\s*([^\s|;,:]+)/gi;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_PATTERN.test(key);
}

export function redactSecretLikeText(input: string): string {
  return input.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED_SECRET_VALUE}`);
}

export function redactSecretEnvValues<T extends Record<string, string | undefined>>(values: T): T {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (isSecretEnvKey(key) && value) {
        return [key, REDACTED_SECRET_VALUE];
      }

      return [key, value];
    })
  ) as T;
}
