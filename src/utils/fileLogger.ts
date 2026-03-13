import fs from 'fs';
import path from 'path';

const fsPromises = fs.promises;

type LogLevel = 'off' | 'error' | 'error-debug' | 'debug';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'error').toLowerCase();
const validLevels: LogLevel[] = ['off', 'error', 'error-debug', 'debug'];
const logLevel: LogLevel = validLevels.includes(LOG_LEVEL as LogLevel) ? (LOG_LEVEL as LogLevel) : 'off';

export const isErrorLogging: boolean = logLevel === 'error' || logLevel === 'error-debug' || logLevel === 'debug';
export const isErrorDebugLogging: boolean = logLevel === 'error-debug' || logLevel === 'debug';
export const isDebugLogging: boolean = logLevel === 'debug';

const ERROR_LOG_MAX_MB: number = parseInt(process.env.ERROR_LOG_MAX_MB || '10');
const ERROR_LOG_MAX_DAYS: number = parseInt(process.env.ERROR_LOG_MAX_DAYS || '30');
const MAX_DEBUG_LOGS: number = parseInt(process.env.MAX_DEBUG_LOGS || '20');

export const LOG_DIR: string = path.join(process.cwd(), 'log');
if ((isErrorLogging || isDebugLogging) && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export interface LogRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export function maskSensitiveHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  if (!headers) return {};
  const sensitiveHeaders = ['authorization', 'x-api-key', 'api-key', 'cookie'];
  const masked: Record<string, string | string[] | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaders.includes(key.toLowerCase()) && value) {
      if (String(value).startsWith('Bearer ')) {
        const token = String(value).substring(7);
        masked[key] = `Bearer ${token.substring(0, 10)}...${token.substring(token.length - 4)}`;
      } else {
        const valString = String(value);
        masked[key] = valString.length > 14 ? `${valString.substring(0, 10)}...${valString.substring(valString.length - 4)}` : valString;
      }
    } else {
      masked[key] = value;
    }
  }

  return masked;
}

export function logError(requestId: string, accountId: string, statusCode: number, errorMessage: string, responseData?: unknown): void {
  if (!isErrorLogging) return;

  const errorLogPath = path.join(LOG_DIR, 'error.log');
  const timestamp = new Date().toISOString();
  const id = accountId ? accountId.substring(0, 8) : 'default';

  let logEntry = `[${timestamp}] STATUS=${statusCode} ACCOUNT=${id} REQUEST_ID=${requestId}\n`;
  logEntry += `Error: ${errorMessage}\n`;
  if (responseData) {
    logEntry += `Response: ${typeof responseData === 'string' ? responseData : JSON.stringify(responseData)}\n`;
  }
  logEntry += '='.repeat(80) + '\n\n';

  fs.appendFile(errorLogPath, logEntry, (err) => {
    if (err) console.error('Failed to write error log:', err.message);
  });
}

export function logToFile(requestId: string, content: string, statusCode: number): void {
  if (isDebugLogging) {
  } else if (isErrorDebugLogging && statusCode !== 200) {
  } else {
    return;
  }

  const requestDir = path.join(LOG_DIR, `req-${requestId}`);
  fsPromises.mkdir(requestDir, { recursive: true }).then(() => {
    const sections = content.split('--------------------------\n');

    for (const section of sections) {
      if (!section.trim() || section.startsWith('requestId:')) continue;

      const [title, ...rest] = section.trim().split('\n');
      const data = rest.join('\n').trim();

      if (!data) continue;

      let filename: string;
      if (title === 'INPUT') {
        filename = 'client-request.json';
      } else if (title === 'TRANSFORMER') {
        filename = 'upstream-request.json';
      } else if (title === 'OUTPUT') {
        filename = 'response.json';
      } else {
        continue;
      }

      const filepath = path.join(requestDir, filename);
      fsPromises.writeFile(filepath, data).catch(() => {});
    }
  }).catch(() => {});
}

export function logErrorFile(requestId: string, statusCode: number, errorMessage: string, responseData?: unknown): void {
  if (!isErrorDebugLogging && statusCode !== 200) return;

  const requestDir = path.join(LOG_DIR, `req-${requestId}`);
  fsPromises.mkdir(requestDir, { recursive: true }).then(() => {
    const errorData = {
      status: statusCode,
      error: errorMessage,
      timestamp: new Date().toISOString(),
      response: responseData
    };
    const filepath = path.join(requestDir, 'error.json');
    fsPromises.writeFile(filepath, JSON.stringify(errorData, null, 2)).catch(() => {});
  }).catch(() => {});
}

export function formatLogContent(requestId: string, req: LogRequest, transformedBody: unknown, statusCode: number, latency: number, output: unknown): string {
  let logContent = `requestId: ${requestId}\n`;
  logContent += `route: ${req.path}\n`;
  logContent += `method: ${req.method}\n`;
  logContent += `stream: ${(req.body as Record<string, unknown>).stream === true}\n\n`;

  logContent += '--------------------------\n';
  logContent += 'INPUT\n';
  logContent += 'Client Headers:\n';
  logContent += JSON.stringify(maskSensitiveHeaders(req.headers), null, 2) + '\n\n';
  logContent += 'Client Request Body:\n';
  logContent += JSON.stringify(req.body, null, 2) + '\n';

  logContent += '--------------------------\n';
  logContent += 'TRANSFORMER\n';
  logContent += 'Transformed Body:\n';
  logContent += JSON.stringify(transformedBody, null, 2) + '\n';

  logContent += '--------------------------\n';
  logContent += 'OUTPUT\n';
  logContent += `status: ${statusCode}\n`;
  logContent += `latencyMs: ${latency}\n`;
  logContent += 'Response Data:\n';
  if (typeof output === 'string') {
    logContent += output + '\n';
  } else {
    logContent += JSON.stringify(output, null, 2) + '\n';
  }

  return logContent;
}

async function rotateErrorLog(): Promise<void> {
  const errorLogPath = path.join(LOG_DIR, 'error.log');

  try {
    const stats = await fsPromises.stat(errorLogPath);
    const sizeMB = stats.size / (1024 * 1024);

    if (sizeMB >= ERROR_LOG_MAX_MB) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = path.join(LOG_DIR, `error-${timestamp}.log`);
      await fsPromises.rename(errorLogPath, rotatedPath);
      console.log(`[LOG] Rotated error.log to error-${timestamp}.log`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[LOG] Failed to rotate error.log:', (err as Error).message);
    }
  }
}

async function cleanupOldErrorLogs(): Promise<void> {
  try {
    const files = await fsPromises.readdir(LOG_DIR);
    const errorLogs = files.filter((f: string) => f.startsWith('error-') && f.endsWith('.log'));

    const now = Date.now();
    const maxAge = ERROR_LOG_MAX_DAYS * 24 * 60 * 60 * 1000;

    for (const file of errorLogs) {
      const filePath = path.join(LOG_DIR, file);
      const stats = await fsPromises.stat(filePath);
      const age = now - stats.mtime.getTime();

      if (age > maxAge) {
        await fsPromises.unlink(filePath);
        console.log(`[LOG] Deleted old error log: ${file}`);
      }
    }
  } catch (err: unknown) {
    console.error('[LOG] Failed to cleanup old error logs:', (err as Error).message);
  }
}

async function cleanupOldDebugLogs(): Promise<void> {
  try {
    const entries = await fsPromises.readdir(LOG_DIR, { withFileTypes: true });
    const debugDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('req-'));

    if (debugDirs.length <= MAX_DEBUG_LOGS) return;

    const dirStats: Array<{ name: string; path: string; mtime: Date }> = [];
    for (const dir of debugDirs) {
      const dirPath = path.join(LOG_DIR, dir.name);
      const stats = await fsPromises.stat(dirPath);
      dirStats.push({ name: dir.name, path: dirPath, mtime: stats.mtime });
    }

    dirStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const dirsToDelete = dirStats.slice(MAX_DEBUG_LOGS);
    for (const { name, path: dirPath } of dirsToDelete) {
      await fsPromises.rm(dirPath, { recursive: true });
      console.log(`[LOG] Deleted old debug log directory: ${name}`);
    }
  } catch (err: unknown) {
    console.error('[LOG] Failed to cleanup old debug logs:', (err as Error).message);
  }
}

async function cleanupOldFormatLogs(): Promise<void> {
  try {
    const files = await fsPromises.readdir(LOG_DIR);
    const oldFormatLogs = files.filter((f: string) => f.startsWith('req-') && f.endsWith('.log'));

    for (const file of oldFormatLogs) {
      const filePath = path.join(LOG_DIR, file);
      await fsPromises.unlink(filePath);
      console.log(`[LOG] Deleted old format log file: ${file}`);
    }
  } catch (err: unknown) {
    console.error('[LOG] Failed to cleanup old format logs:', (err as Error).message);
  }
}

async function cleanupLogs(): Promise<void> {
  await rotateErrorLog();
  await cleanupOldErrorLogs();
  await cleanupOldFormatLogs();
  await cleanupOldDebugLogs();
}

export function startCleanupJob(): void {
  if (logLevel === 'off') return;

  const debugModeDesc = isDebugLogging ? 'full' : (isErrorDebugLogging ? 'non-200 only' : 'off');
  console.log(`[LOG] Logging mode=${logLevel}, debug=${debugModeDesc} - error.log: ${ERROR_LOG_MAX_MB}MB, error logs: ${ERROR_LOG_MAX_DAYS} days, request logs: last ${MAX_DEBUG_LOGS} files`);

  setInterval(() => {
    cleanupLogs().catch((err: Error) => console.error('[LOG] Cleanup job error:', err.message));
  }, 3600000);

  setTimeout(cleanupLogs, 5000);
}

startCleanupJob();
