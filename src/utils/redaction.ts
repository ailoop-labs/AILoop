import { redactSecretLikeText } from "../secret-redaction";

const SECRET_ASSIGNMENT_IDENTIFIER_PATTERN =
  /\b([A-Za-z][A-Za-z0-9_]*(?:token|key|secret)[A-Za-z0-9_]*)\s*=\s*([^\s|;,:"'`]+?)([.!?])?(?=$|[\s|;,:"'`])/gi;

export class SecretRedactor {
  private readonly secrets: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.secrets = Object.entries(env)
      .filter(([key, value]) => /TOKEN|KEY|SECRET/i.test(key) && Boolean(value) && (value?.length ?? 0) >= 4)
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length);
  }

  redact(input: string): string {
    let output = redactSecretLikeText(input);
    output = output.replace(SECRET_ASSIGNMENT_IDENTIFIER_PATTERN, (_match, key: string, _value: string, suffix = "") =>
      `${key}=[REDACTED]${suffix}`
    );
    for (const secret of this.secrets) {
      output = output.split(secret).join("[REDACTED]");
    }
    return output;
  }
}

export function redactJsonStrings<T>(value: T, redactor: SecretRedactor): T {
  if (typeof value === "string") {
    return redactor.redact(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonStrings(entry, redactor)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactJsonStrings(entry, redactor)])
    ) as T;
  }

  return value;
}
