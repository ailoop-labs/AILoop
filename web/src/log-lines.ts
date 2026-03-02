function splitToDisplayLines(line: string): string[] {
  const normalizedEscapedLineBreaks = line.replace(/\\r\\n|\\n|\\r/g, "\n");
  return normalizedEscapedLineBreaks.split(/\r?\n/);
}

export function normalizeLogLinesForDisplay(lines: string[]): string[] {
  return lines.flatMap(splitToDisplayLines);
}
