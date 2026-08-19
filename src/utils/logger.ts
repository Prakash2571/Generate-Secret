import { config } from '../config';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function currentWeight(): number {
  const configured = config.logLevel.toLowerCase() as Level;
  return LEVEL_WEIGHT[configured] ?? LEVEL_WEIGHT.info;
}

export type LogFields = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string') {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
}

function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(level: Level, tag: string, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < currentWeight()) return;
  const line = `${stamp()} [${tag}] ${message}${formatFields(fields)}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Structured console logger.
 *
 * Standard levels plus `tag()` for the domain-specific markers used across the
 * scanner ([DISCOVERY], [VALIDATE], [VALID], [INVALID], [UNVERIFIED], ...).
 */
export const logger = {
  trace(message: string, fields?: LogFields): void {
    write('trace', 'TRACE', message, fields);
  },
  debug(message: string, fields?: LogFields): void {
    write('debug', 'DEBUG', message, fields);
  },
  info(message: string, fields?: LogFields): void {
    write('info', 'INFO', message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    write('warn', 'WARN', message, fields);
  },
  error(message: string, fields?: LogFields): void {
    write('error', 'ERROR', message, fields);
  },
  /** Log with a custom marker, e.g. logger.tag('VALID', 'SHEIN800 - 800 off 1000'). */
  tag(tag: string, message: string, fields?: LogFields, level: Level = 'info'): void {
    write(level, tag.toUpperCase(), message, fields);
  },
  /** Raw passthrough for report blocks that must not be decorated. */
  raw(text: string): void {
    process.stdout.write(`${text}\n`);
  },
};

/** Normalises unknown thrown values into a short, loggable reason string. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 300 ? `${error.message.slice(0, 297)}...` : error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'unknown error';
  }
}
