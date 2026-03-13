import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import config from './config';
import { QwenAPI } from './qwen/api';
import { QwenAuthManager } from './qwen/auth';
import { DebugLogger } from './utils/logger';
import { countTokens } from './utils/tokenCounter';
import { ErrorFormatter } from './utils/errorFormatter';
import { AccountRefreshScheduler } from './utils/accountRefreshScheduler';
import { systemPromptTransformer } from './utils/systemPromptTransformer';
import liveLogger from './utils/liveLogger';
import * as fileLogger from './utils/fileLogger';

const PORT = config.port;
const HOST = config.host;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Initialize Qwen API client
const qwenAPI = new QwenAPI();
const authManager = new QwenAuthManager();
const debugLogger = new DebugLogger();
const accountRefreshScheduler = new AccountRefreshScheduler(qwenAPI);

// Retry helper for 500 and 429 errors
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = config.maxRetries,
  delayMs: number = config.retryDelayMs,
  logger: typeof liveLogger | null = null,
  requestId: string | null = null
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      const status = (error as any).response?.status;
      const isRetryable = status === 500 || status === 429 || (error as Error).message?.includes('500') || (error as Error).message?.includes('429');
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      if (logger && requestId) {
        logger.proxyError(requestId, status || 500, 'default', `Retry ${attempt}/${maxRetries}: ${(error as Error).message.substring(0, 50)}`);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

// API Key middleware
const validateApiKey = (req: Request, res: Response, next: NextFunction): void => {
  if (!config.apiKey) {
    return next();
  }

  const apiKey = req.headers["x-api-key"] as string | undefined || req.headers["authorization"] as string | undefined;

  let cleanApiKey: string | null = null;
  if (apiKey && typeof apiKey === "string") {
    if (apiKey.startsWith("Bearer ")) {
      cleanApiKey = apiKey.substring(7).trim();
    } else {
      cleanApiKey = apiKey.trim();
    }
  }

  if (!cleanApiKey || !config.apiKey?.includes(cleanApiKey)) {
    console.error(
      "\x1b[31m%s\x1b[0m",
      "Unauthorized request - Invalid or missing API key",
    );
    res.status(401).json({
      error: {
        message: "Invalid or missing API key",
        type: "authentication_error",
      },
    });
    return;
  }

  next();
};

// Main proxy server
class QwenOpenAIProxy {
  async handleChatCompletion(req: Request, res: Response): Promise<void> {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const accountId = (req.headers['x-qwen-account'] as string) || (req.query.account as string) || req.body.account;
    const model = req.body.model || config.defaultModel;
    const startTime = Date.now();
    const displayAccount = accountId ? accountId.substring(0, 8) : 'default';
    const requestNum = qwenAPI.getRequestCount(accountId || 'default');
    const isStreaming = req.body.stream === true;

    try {
      const tokenCount = countTokens(req.body.messages);

      liveLogger.proxyRequest(requestId, model, displayAccount, tokenCount, requestNum, isStreaming);

      if (isStreaming) {
        await this.handleStreamingChatCompletion(req, res, requestId, accountId, model, startTime);
      } else {
        await this.handleRegularChatCompletion(req, res, requestId, accountId, model, startTime);
      }
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('Validation error')) {
        liveLogger.proxyError(requestId, 400, displayAccount, err.message);
        const validationError = ErrorFormatter.openAIValidationError(err.message);
        res.status(validationError.status).json(validationError.body);
        return;
      }

      fileLogger.logError(requestId, displayAccount, 500, err.message);

      liveLogger.proxyError(requestId, 500, displayAccount, err.message);

      if (err.message.includes('Not authenticated') || err.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        res.status(authError.status).json(authError.body);
        return;
      }

      const apiError = ErrorFormatter.openAIApiError(err.message);
      res.status(apiError.status).json(apiError.body);
    }
  }

  async handleRegularChatCompletion(req: Request, res: Response, requestId: string, accountId: string | undefined, model: string, startTime: number): Promise<void> {
    const displayAccount = accountId ? accountId.substring(0, 8) : 'default';

    try {
      const transformedMessages = systemPromptTransformer.transform(
        req.body.messages,
        req.body.model || config.defaultModel
      );

      const response = await withRetry(
        async () => {
          return await qwenAPI.chatCompletions({
            model: req.body.model || config.defaultModel,
            messages: transformedMessages,
            tools: req.body.tools,
            tool_choice: req.body.tool_choice,
            temperature: req.body.temperature || config.defaultTemperature,
            max_tokens: req.body.max_tokens || config.defaultMaxTokens,
            top_p: req.body.top_p || config.defaultTopP,
            top_k: req.body.top_k || config.defaultTopK,
            repetition_penalty: req.body.repetition_penalty || config.defaultRepetitionPenalty,
            reasoning: req.body.reasoning,
            accountId: accountId
          });
        },
        config.maxRetries,
        config.retryDelayMs,
        liveLogger,
        requestId
      ) as any;

      const latency = Date.now() - startTime;
      const inputTokens = response?.usage?.prompt_tokens || 0;
      const outputTokens = response?.usage?.completion_tokens || 0;
      const qwenId: string | undefined = response?.id ? response.id.replace('chatcmpl-', '').substring(0, 8) : undefined;

      if (fileLogger.isDebugLogging) {
        const logContent = fileLogger.formatLogContent(requestId, req as any, { model, messages: transformedMessages }, 200, latency, response);
        fileLogger.logToFile(requestId, logContent, 200);
      }

      liveLogger.proxyResponse(requestId, 200, displayAccount, latency, inputTokens, outputTokens, qwenId);

      res.json(response);
    } catch (error) {
      const err = error as any;
      const latency = Date.now() - startTime;
      const statusCode = err.response?.status || 500;

      fileLogger.logError(requestId, displayAccount, statusCode, err.message);

      liveLogger.proxyError(requestId, statusCode, displayAccount, err.message);

      if (err.message.includes('Not authenticated') || err.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        res.status(authError.status).json(authError.body);
        return;
      }

      throw error;
    }
  }

  async handleStreamingChatCompletion(req: Request, res: Response, requestId: string, accountId: string | undefined, model: string, startTime: number): Promise<void> {
    const displayAccount = accountId ? accountId.substring(0, 8) : 'default';

    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const transformedMessages = systemPromptTransformer.transform(
        req.body.messages,
        req.body.model || config.defaultModel
      );

      const stream = await withRetry(
        async () => {
          return await qwenAPI.streamChatCompletions({
            model: req.body.model || config.defaultModel,
            messages: transformedMessages,
            tools: req.body.tools,
            tool_choice: req.body.tool_choice,
            temperature: req.body.temperature || config.defaultTemperature,
            max_tokens: req.body.max_tokens || config.defaultMaxTokens,
            top_p: req.body.top_p || config.defaultTopP,
            top_k: req.body.top_k || config.defaultTopK,
            repetition_penalty: req.body.repetition_penalty || config.defaultRepetitionPenalty,
            reasoning: req.body.reasoning,
            accountId: accountId
          });
        },
        config.maxRetries,
        config.retryDelayMs,
        liveLogger,
        requestId
      );

      if (fileLogger.isDebugLogging) {
        const logContent = fileLogger.formatLogContent(requestId, req as any, { model, messages: transformedMessages }, 200, 0, { streaming: true });
        fileLogger.logToFile(requestId, logContent, 200);
      }

      let qwenId: string | null = null;
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && !qwenId) {
            const data = line.slice(6);
            if (data !== '[DONE]') {
              try {
                const json = JSON.parse(data);
                if (json.id) {
                  qwenId = json.id.replace('chatcmpl-', '');
                }
              } catch {}
            }
          }
        }

        res.write(chunk);
      });

      stream.on('end', () => {
        const latency = Date.now() - startTime;
        const qwenIdShort = qwenId ? qwenId.substring(0, 8) : undefined;
        liveLogger.proxyResponse(requestId, 200, displayAccount, latency, 0, 0, qwenIdShort);
        res.end();
      });

      stream.on('error', (error: Error) => {
        liveLogger.proxyError(requestId, 500, displayAccount, error.message);
        if (!res.headersSent) {
          const apiError = ErrorFormatter.openAIApiError(error.message, 'streaming_error');
          res.status(apiError.status).json(apiError.body);
        }
        res.end();
      });

      req.on('close', () => {
        stream.destroy();
      });

    } catch (error) {
      const err = error as any;
      const latency = Date.now() - startTime;
      const statusCode = err.response?.status || 500;

      fileLogger.logError(requestId, displayAccount, statusCode, err.message);

      liveLogger.proxyError(requestId, statusCode, displayAccount, err.message);

      if (err.message.includes('Not authenticated') || err.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        if (!res.headersSent) {
          res.status(authError.status).json(authError.body);
          res.end();
        }
        return;
      }

      const apiError = ErrorFormatter.openAIApiError(err.message);
      if (!res.headersSent) {
        res.status(apiError.status).json(apiError.body);
        res.end();
      }
    }
  }

  async handleModels(req: Request, res: Response): Promise<void> {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const startTime = Date.now();

    try {
      const models = await qwenAPI.listModels();

      const latency = Date.now() - startTime;
      liveLogger.proxyResponse(requestId, 200, 'system', latency, 0, 0);

      res.json(models);
    } catch (error) {
      const err = error as Error;
      const latency = Date.now() - startTime;
      liveLogger.proxyError(requestId, 500, 'system', err.message);

      fileLogger.logError(requestId, 'system', 500, err.message);

      if (err.message.includes('Not authenticated') || err.message.includes('access token')) {
        res.status(401).json({
          error: {
            message: 'Not authenticated with Qwen. Please authenticate first.',
            type: 'authentication_error'
          }
        });
        return;
      }

      res.status(500).json({
        error: {
          message: err.message,
          type: 'internal_server_error'
        }
      });
    }
  }

  async handleAuthInitiate(req: Request, res: Response): Promise<void> {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    try {
      const deviceFlow = await authManager.initiateDeviceFlow();

      liveLogger.authInitiated(deviceFlow.device_code.substring(0, 8));

      const response = {
        verification_uri: deviceFlow.verification_uri,
        user_code: deviceFlow.user_code,
        device_code: deviceFlow.device_code,
        code_verifier: deviceFlow.code_verifier
      };

      res.json(response);
    } catch (error) {
      const err = error as Error;
      fileLogger.logError(requestId, 'auth', 500, err.message);
      liveLogger.proxyError(requestId, 500, 'auth', err.message);

      res.status(500).json({
        error: {
          message: err.message,
          type: 'authentication_error'
        }
      });
    }
  }

  async handleAuthPoll(req: Request, res: Response): Promise<void> {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

    try {
      const { device_code, code_verifier } = req.body;

      if (!device_code || !code_verifier) {
        const errorResponse = {
          error: {
            message: 'Missing device_code or code_verifier',
            type: 'invalid_request'
          }
        };
        fileLogger.logError(requestId, 'auth', 400, 'Missing device_code or code_verifier');
        liveLogger.proxyError(requestId, 400, 'auth', 'Missing device_code or code_verifier');
        res.status(400).json(errorResponse);
        return;
      }

      const token = await authManager.pollForToken(device_code, code_verifier);

      liveLogger.authCompleted(device_code.substring(0, 8));

      const response = {
        access_token: token,
        message: 'Authentication successful'
      };

      res.json(response);
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('Validation error')) {
        liveLogger.proxyError(requestId, 400, 'auth', err.message);
        const validationError = ErrorFormatter.openAIValidationError(err.message);
        res.status(validationError.status).json(validationError.body);
        return;
      }

      fileLogger.logError(requestId, 'auth', 500, err.message);
      liveLogger.proxyError(requestId, 500, 'auth', err.message);

      const apiError = ErrorFormatter.openAIApiError(err.message, 'authentication_error');
      res.status(apiError.status).json(apiError.body);
    }
  }

  async handleWebSearch(req: Request, res: Response): Promise<void> {
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const startTime = Date.now();

    try {
      const { query, page, rows } = req.body;

      if (!query || typeof query !== 'string') {
        liveLogger.proxyError(requestId, 400, 'web', 'Query parameter required');
        const validationError = ErrorFormatter.openAIValidationError('Query parameter is required and must be a string');
        res.status(validationError.status).json(validationError.body);
        return;
      }

      if (page && (typeof page !== 'number' || page < 1)) {
        liveLogger.proxyError(requestId, 400, 'web', 'Page must be positive integer');
        const validationError = ErrorFormatter.openAIValidationError('Page must be a positive integer');
        res.status(validationError.status).json(validationError.body);
        return;
      }

      if (rows && (typeof rows !== 'number' || rows < 1 || rows > 100)) {
        liveLogger.proxyError(requestId, 400, 'web', 'Rows must be 1-100');
        const validationError = ErrorFormatter.openAIValidationError('Rows must be a number between 1 and 100');
        res.status(validationError.status).json(validationError.body);
        return;
      }

      const accountId = (req.headers['x-qwen-account'] as string) || (req.query.account as string) || req.body.account;
      const displayAccount = accountId ? accountId.substring(0, 8) : 'default';

      liveLogger.proxyRequest(requestId, 'web-search', displayAccount, 0);

      const response = await qwenAPI.webSearch({
        query: query,
        page: page || 1,
        rows: rows || 10,
        accountId: accountId
      });

      const latency = Date.now() - startTime;

      liveLogger.proxyResponse(requestId, 200, displayAccount, latency, 0, 0);

      res.json(response);
    } catch (error) {
      const err = error as Error;

      if (err.message.includes('Validation error')) {
        liveLogger.proxyError(requestId, 400, 'web', err.message);
        const validationError = ErrorFormatter.openAIValidationError(err.message);
        res.status(validationError.status).json(validationError.body);
        return;
      }

      fileLogger.logError(requestId, 'web', 500, err.message);
      liveLogger.proxyError(requestId, 500, 'web', err.message);

      if (err.message.includes('Not authenticated') || err.message.includes('access token')) {
        const authError = ErrorFormatter.openAIAuthError();
        res.status(authError.status).json(authError.body);
        return;
      }

      if (err.message.includes('quota') || err.message.includes('exceeded')) {
        const quotaError = {
          error: {
            message: "Web search quota exceeded. Free accounts have 2000 requests per day.",
            type: "quota_exceeded",
            code: "quota_exceeded"
          }
        };
        res.status(429).json(quotaError);
        return;
      }

      const apiError = ErrorFormatter.openAIApiError(err.message);
      res.status(apiError.status).json(apiError.body);
    }
  }
}

// Initialize proxy
const proxy = new QwenOpenAIProxy();

// Apply API key middleware to all routes
app.use("/v1/", validateApiKey);
app.use("/auth/", validateApiKey);

// Routes
app.post('/v1/chat/completions', (req, res) => proxy.handleChatCompletion(req, res));
app.post('/v1/web/search', (req, res) => proxy.handleWebSearch(req, res));
app.get('/v1/models', (req, res) => proxy.handleModels(req, res));

// Authentication routes
app.post('/auth/initiate', (req, res) => proxy.handleAuthInitiate(req, res));
app.post('/auth/poll', (req, res) => proxy.handleAuthPoll(req, res));

// MCP endpoints
import { mcpGetHandler, mcpPostHandler } from './mcp';
app.get('/mcp', mcpGetHandler);
app.post('/mcp', mcpPostHandler);

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    await qwenAPI.authManager.loadAllAccounts();
    const defaultCredentials = await qwenAPI.authManager.loadCredentials();
    const accountIds = qwenAPI.authManager.getAccountIds();
    const healthyAccounts = qwenAPI.getHealthyAccounts(accountIds);
    const failedAccounts = healthyAccounts.length === 0 ?
      new Set(accountIds) : new Set(accountIds.filter(id => !healthyAccounts.includes(id)));

    interface AccountHealth {
      id: string;
      status: string;
      expiresIn: string | null;
      requestCount: number;
      webSearchCount: number;
      authErrorCount: number;
    }

    const accounts: AccountHealth[] = [];
    let totalRequestsToday = 0;

    if (defaultCredentials) {
      const minutesLeft = ((defaultCredentials.expiry_date ?? 0) - Date.now()) / 60000;
      const status = minutesLeft < 0 ? 'expired' : 'healthy';
      const expiresIn = Math.max(0, minutesLeft);
      const requestCount = qwenAPI.getRequestCount('default');
      const webSearchCount = qwenAPI.getWebSearchRequestCount('default');
      totalRequestsToday += requestCount;

      accounts.push({
        id: 'default',
        status,
        expiresIn: expiresIn ? `${expiresIn.toFixed(1)} minutes` : null,
        requestCount: requestCount,
        webSearchCount: webSearchCount,
        authErrorCount: qwenAPI.getAuthErrorCount('default')
      });
    }

    for (const accountId of accountIds) {
      const credentials = qwenAPI.authManager.getAccountCredentials(accountId);
      let status = 'unknown';
      let expiresIn: number | null = null;

      if (credentials) {
        const minutesLeft = ((credentials.expiry_date ?? 0) - Date.now()) / 60000;
        if (failedAccounts.has(accountId)) {
          status = 'failed';
        } else if (minutesLeft < 0) {
          status = 'expired';
        } else if (minutesLeft < 30) {
          status = 'expiring_soon';
        } else {
          status = 'healthy';
        }
        expiresIn = Math.max(0, minutesLeft);
      }

      const requestCount = qwenAPI.getRequestCount(accountId);
      const webSearchCount = qwenAPI.getWebSearchRequestCount(accountId);
      totalRequestsToday += requestCount;

      accounts.push({
        id: accountId.substring(0, 5),
        status,
        expiresIn: expiresIn ? `${expiresIn.toFixed(1)} minutes` : null,
        requestCount: requestCount,
        webSearchCount: webSearchCount,
        authErrorCount: qwenAPI.getAuthErrorCount(accountId)
      });
    }

    const healthyCount = accounts.filter(a => a.status === 'healthy').length;
    const failedCount = accounts.filter(a => a.status === 'failed').length;
    const expiringSoonCount = accounts.filter(a => a.status === 'expiring_soon').length;
    const expiredCount = accounts.filter(a => a.status === 'expired').length;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const today = new Date().toISOString().split('T')[0];
    for (const [, usageData] of qwenAPI.tokenUsage.entries()) {
      const todayUsage = usageData.find(entry => entry.date === today);
      if (todayUsage) {
        totalInputTokens += todayUsage.inputTokens;
        totalOutputTokens += todayUsage.outputTokens;
      }
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      summary: {
        total: accounts.length,
        healthy: healthyCount,
        failed: failedCount,
        expiring_soon: expiringSoonCount,
        expired: expiredCount,
        total_requests_today: totalRequestsToday,
        lastReset: qwenAPI.lastFailedReset
      },
      token_usage: {
        input_tokens_today: totalInputTokens,
        output_tokens_today: totalOutputTokens,
        total_tokens_today: totalInputTokens + totalOutputTokens
      },
      accounts,
      server_info: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        node_version: process.version,
        platform: process.platform,
        arch: process.arch
      },
      endpoints: {
        openai: `${req.protocol}://${req.get('host')}/v1`,
        health: `${req.protocol}://${req.get('host')}/health`
      }
    });
  } catch (error) {
    console.error('Health check error:', (error as Error).message);
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: (error as Error).message,
      server_info: {
        uptime: process.uptime(),
        node_version: process.version,
        platform: process.platform,
        arch: process.arch
      }
    });
  }
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  liveLogger.shutdown('SIGINT received');
  try {
    accountRefreshScheduler.stopScheduler();
    liveLogger.accountRemoved('refresh-scheduler');
  } catch (error) {
    console.error('Failed to stop scheduler:', (error as Error).message);
  }

  try {
    await qwenAPI.saveRequestCounts();
  } catch (error) {
    console.error('Failed to save request counts:', (error as Error).message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  liveLogger.shutdown('SIGTERM received');
  try {
    accountRefreshScheduler.stopScheduler();
    liveLogger.accountRemoved('refresh-scheduler');
  } catch (error) {
    console.error('Failed to stop scheduler:', (error as Error).message);
  }

  try {
    await qwenAPI.saveRequestCounts();
  } catch (error) {
    console.error('Failed to save request counts:', (error as Error).message);
  }
  process.exit(0);
});

app.listen(PORT, HOST, async () => {
  liveLogger.serverStarted(HOST, PORT);

  qwenAPI.authManager.init(qwenAPI);
  fileLogger.startCleanupJob();

  try {
    await qwenAPI.authManager.loadAllAccounts();
    const accountIds = qwenAPI.authManager.getAccountIds();

    const defaultAccount = config.defaultAccount;
    if (defaultAccount) {
      console.log(`\x1b[36mDefault account: ${defaultAccount}\x1b[0m`);
    }

    if (accountIds.length > 0) {
      console.log('\x1b[36mAccounts:\x1b[0m');
      for (const accountId of accountIds) {
        const credentials = qwenAPI.authManager.getAccountCredentials(accountId);
        const isValid = credentials && qwenAPI.authManager.isTokenValid(credentials);
        const status = isValid ? '\x1b[32mvalid\x1b[0m' : '\x1b[31minvalid\x1b[0m';
        const isDefault = accountId === defaultAccount ? ' (default)' : '';
        console.log(`  ${accountId}${isDefault}: ${status}`);
      }
    } else {
      const defaultCredentials = await qwenAPI.authManager.loadCredentials();
      if (defaultCredentials) {
        const isValid = qwenAPI.authManager.isTokenValid(defaultCredentials);
        const status = isValid ? '\x1b[32mvalid\x1b[0m' : '\x1b[31minvalid\x1b[0m';
        console.log(`\x1b[36mDefault account: ${status}\x1b[0m`);
      } else {
        console.log('\x1b[33mNo accounts configured\x1b[0m');
      }
    }
  } catch {
    console.log('\x1b[33mWarning: Could not load accounts\x1b[0m');
  }

  try {
    await accountRefreshScheduler.initialize();
  } catch (error) {
    console.log(`\x1b[31mScheduler init failed: ${(error as Error).message}\x1b[0m`);
  }
});
