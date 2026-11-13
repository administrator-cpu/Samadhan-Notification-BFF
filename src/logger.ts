import { config } from './config.js';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (levels[level] < levels[config.LOG_LEVEL]) return;
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  if (fields) for (const [k, v] of Object.entries(fields)) entry[k] = serialize(v);
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

// JSON lines to stdout/stderr; PM2 writes them to files and pm2-logrotate rotates them.
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
