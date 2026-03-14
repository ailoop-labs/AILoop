export {
  REDACTED_SECRET_VALUE,
  isSecretEnvKey,
  SECRET_ENV_KEY_PATTERN
} from "./secret-redaction";

import { redactSecretEnvValues } from "./secret-redaction";

export function redactSecrets<T extends Record<string, string | undefined>>(values: T): T {
  return redactSecretEnvValues(values);
}
