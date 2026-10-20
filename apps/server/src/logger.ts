import { pino } from 'pino';

// Structured JSON to stdout; the Zima's Docker logs are the log store. Secrets never reach a log
// line: the Crunchyroll password and tokens are redacted by path wherever they could appear.
export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: ['password', '*.password', 'refreshToken', '*.refreshToken', 'req.headers.authorization', 'req.headers.cookie'],
      censor: '[redacted]',
    },
  });
}
