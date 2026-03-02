function splitToDisplayLines(line: string): string[] {
  const normalizedEscapedLineBreaks = line.replace(/\\r\\n|\\n|\\r/g, "\n");
  return normalizedEscapedLineBreaks.split(/\r\n|\n|\r/);
}

export function normalizeLogLinesForDisplay(lines: string[]): string[] {
  return lines.flatMap(splitToDisplayLines);
}

export function buildLogViewerText(lines: string[]): string {
  return normalizeLogLinesForDisplay(lines).join("\n");
}
