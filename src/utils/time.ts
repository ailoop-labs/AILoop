export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function runTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
