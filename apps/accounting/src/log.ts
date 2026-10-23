// One JSON line per fact; ids, counts, amounts and error classes only — never a payload, never PII (the events carry
// none, and no field of a payload other than ids and amounts is ever logged).
export interface LogLine {
  service: 'accounting';
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  info(line: Omit<LogLine, 'service'>): void;
  warn(line: Omit<LogLine, 'service'>): void;
  error(line: Omit<LogLine, 'service'>): void;
}

export const consoleLogger: Logger = {
  info: (line) => console.info(JSON.stringify({ service: 'accounting', ...line })),
  warn: (line) => console.warn(JSON.stringify({ service: 'accounting', ...line })),
  error: (line) => console.error(JSON.stringify({ service: 'accounting', ...line })),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** `name` of an error (the class the DLQ records), never its message. */
export function errorClassOf(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}
