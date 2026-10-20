import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

// Structured JSON to stdout; the Zima's Docker logs are the log store. Secrets never reach a log
// line: the Crunchyroll password and tokens are redacted by path wherever they could appear.
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['password', '*.password', 'refreshToken', '*.refreshToken', 'req.headers.authorization', 'req.headers.cookie'],
      censor: '[redacted]',
    },
  });
}
