export class SecretRedactor {
  private readonly secrets: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.secrets = Object.entries(env)
      .filter(([key, value]) => /TOKEN|KEY|SECRET/i.test(key) && Boolean(value) && (value?.length ?? 0) >= 4)
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length);
  }

  redact(input: string): string {
    let output = input;
    for (const secret of this.secrets) {
      output = output.split(secret).join("[REDACTED]");
    }
    return output;
  }
}
