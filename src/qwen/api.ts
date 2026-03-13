import axios, { AxiosError } from 'axios';
import * as http from 'http';
import * as https from 'https';
import { QwenAuthManager, QwenCredentials, AccountInfo } from './auth';
import { PassThrough } from 'stream';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as crypto from 'crypto';

// Create HTTP agents with connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

// Default Qwen configuration
const DEFAULT_QWEN_API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3-coder-plus';
const QWEN_CODE_VERSION = '0.12.0';

// Model aliases - maps client-facing model names to actual Qwen model names
const MODEL_ALIASES: Record<string, string> = {
  'qwen3.5-plus': 'coder-model'
};

function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] || model;
}

function generateUserAgent(): string {
  const platform = process.platform;
  const arch = process.arch;
  return `QwenCode/${QWEN_CODE_VERSION} (${platform}; ${arch})`;
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

interface DashScopeHeaders {
  [key: string]: string;
}

function buildDashScopeHeaders(accessToken: string, isStreaming = false): DashScopeHeaders {
  const headers: DashScopeHeaders = {
    'connection': 'keep-alive',
    'accept': 'application/json',
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': 'QwenCode/0.11.1 (linux; x64)',
    'x-dashscope-authtype': 'qwen-oauth',
    'x-dashscope-cachecontrol': 'enable',
    'x-dashscope-useragent': 'QwenCode/0.11.1 (linux; x64)',
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-package-version': '5.11.0',
    'x-stainless-retry-count': '1',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v18.19.1',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
  };

  if (isStreaming) {
    headers['accept'] = 'text/event-stream';
  }

  return headers;
}

// Model-specific limits
const MODEL_LIMITS: Record<string, { maxTokens: number }> = {
  'vision-model': { maxTokens: 32768 },
  'qwen3-vl-plus': { maxTokens: 32768 },
  'qwen3-vl-max': { maxTokens: 32768 },
};

function clampMaxTokens(model: string, maxTokens: number): number {
  const limit = MODEL_LIMITS[model];
  if (limit && maxTokens > limit.maxTokens) {
    return limit.maxTokens;
  }
  return maxTokens;
}

interface QwenModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

const QWEN_MODELS: QwenModel[] = [
  { id: 'qwen3-coder-plus', object: 'model', created: 1754686206, owned_by: 'qwen' },
  { id: 'qwen3-coder-flash', object: 'model', created: 1754686206, owned_by: 'qwen' },
  { id: 'qwen3-coder-flash', object: 'model', created: 1754686206, owned_by: 'qwen' },
  { id: 'coder-model', object: 'model', created: 1754686206, owned_by: 'qwen' },
  { id: 'vision-model', object: 'model', created: 1754686206, owned_by: 'qwen' }
];

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface Message {
  role: string;
  content: string | ContentPart[] | null;
  [key: string]: unknown;
}

function processMessagesForVision(messages: Message[], model: string): Message[] {
  if (model !== 'vision-model') {
    return messages;
  }

  return messages.map(message => {
    if (!message.content) {
      return message;
    }

    if (Array.isArray(message.content)) {
      return message;
    }

    if (typeof message.content === 'string') {
      const content = message.content;
      const parts: ContentPart[] = [{ type: 'text', text: content }];
      let hasImages = false;

      const base64Matches = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g);
      if (base64Matches) {
        hasImages = true;
        base64Matches.forEach(match => {
          parts.push({
            type: 'image_url',
            image_url: { url: match }
          });
        });
      }

      const urlMatches = content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp)/gi);
      if (urlMatches) {
        hasImages = true;
        urlMatches.forEach(url => {
          parts.push({
            type: 'image_url',
            image_url: { url: url }
          });
        });
      }

      if (!hasImages) {
        return message;
      }

      return { ...message, content: parts };
    }

    return message;
  });
}

interface ErrorWithResponse extends Error {
  response?: {
    status?: number;
    data?: unknown;
  };
  code?: string | number;
  request?: unknown;
}

function isAuthError(error: unknown): boolean {
  if (!error) return false;

  const errorMessage =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  const errorWithCode = error as ErrorWithResponse;
  const errorCode = errorWithCode?.response?.status || errorWithCode?.code;

  return (
    errorCode === 400 ||
    errorCode === 401 ||
    errorCode === 403 ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('forbidden') ||
    errorMessage.includes('invalid api key') ||
    errorMessage.includes('invalid access token') ||
    errorMessage.includes('token expired') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('access denied') ||
    (errorMessage.includes('token') && errorMessage.includes('expired')) ||
    errorCode === 504 ||
    errorMessage.includes('504') ||
    errorMessage.includes('gateway timeout')
  );
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error) return false;

  const errorMessage =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  const errorWithCode = error as ErrorWithResponse;
  const errorCode = errorWithCode?.response?.status || errorWithCode?.code;

  return (
    errorMessage.includes('insufficient_quota') ||
    errorMessage.includes('free allocated quota exceeded') ||
    (errorMessage.includes('quota') && errorMessage.includes('exceeded')) ||
    errorCode === 429
  );
}

export interface ChatCompletionRequest {
  model?: string;
  messages: Message[];
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  reasoning?: unknown;
  accountId?: string;
}

export interface WebSearchRequest {
  query: string;
  page?: number;
  rows?: number;
  accountId?: string;
}

interface TokenUsageEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

interface AccountRateData {
  count: number;
  resetTime: number;
}

interface RequestCountsFile {
  lastResetDate?: string;
  requests?: Record<string, number>;
  tokenUsage?: Record<string, TokenUsageEntry[]>;
  webSearchRequests?: Record<string, number>;
  webSearchResults?: Record<string, number>;
}

export class QwenAPI {
  public authManager: QwenAuthManager;
  private requestCount: Map<string, number>;
  private authErrorCount: Map<string, number>;
  public tokenUsage: Map<string, TokenUsageEntry[]>;
  public lastResetDate: string;
  private requestCountFile: string;
  private lastSaveTime: number;
  private saveInterval: number;
  private pendingSave: boolean;
  private accountLocks: Map<string, boolean>;
  private accountQueues: Map<string, unknown[]>;
  private accountRequestCounts: Map<string, AccountRateData>;
  private requestWindowDuration: number;
  private webSearchRequestCounts: Map<string, number>;
  private webSearchResultCounts: Map<string, number>;
  public lastFailedReset?: string;

  constructor() {
    this.authManager = new QwenAuthManager();
    this.requestCount = new Map();
    this.authErrorCount = new Map();
    this.tokenUsage = new Map();
    this.lastResetDate = new Date().toISOString().split('T')[0];
    this.requestCountFile = path.join(this.authManager.qwenDir, 'request_counts.json');

    this.lastSaveTime = 0;
    this.saveInterval = 60000;
    this.pendingSave = false;

    this.accountLocks = new Map();
    this.accountQueues = new Map();

    this.accountRequestCounts = new Map();
    this.requestWindowDuration = 60000;

    this.webSearchRequestCounts = new Map();
    this.webSearchResultCounts = new Map();

    this.loadRequestCounts();
  }

  async loadRequestCounts(): Promise<void> {
    try {
      const data = await fs.readFile(this.requestCountFile, 'utf8');
      const counts: RequestCountsFile = JSON.parse(data);

      if (counts.lastResetDate) {
        this.lastResetDate = counts.lastResetDate;
      }

      if (counts.requests) {
        for (const [accountId, count] of Object.entries(counts.requests)) {
          this.requestCount.set(accountId, count);
        }
      }

      if (counts.tokenUsage) {
        for (const [accountId, usageData] of Object.entries(counts.tokenUsage)) {
          this.tokenUsage.set(accountId, usageData);
        }
      }

      if (counts.webSearchRequests) {
        for (const [accountId, count] of Object.entries(counts.webSearchRequests)) {
          this.webSearchRequestCounts.set(accountId, count);
        }
      }

      if (counts.webSearchResults) {
        for (const [accountId, count] of Object.entries(counts.webSearchResults)) {
          this.webSearchResultCounts.set(accountId, count);
        }
      } else {
        console.log('Migrating old data structure - adding webSearchResults tracking');
        for (const accountId of this.webSearchRequestCounts.keys()) {
          this.webSearchResultCounts.set(accountId, 0);
        }
      }

      this.resetRequestCountsIfNeeded();
    } catch {
      this.resetRequestCountsIfNeeded();
    }
  }

  async saveRequestCounts(): Promise<void> {
    try {
      const counts: RequestCountsFile = {
        lastResetDate: this.lastResetDate,
        requests: Object.fromEntries(this.requestCount),
        webSearchRequests: Object.fromEntries(this.webSearchRequestCounts),
        webSearchResults: Object.fromEntries(this.webSearchResultCounts),
        tokenUsage: Object.fromEntries(this.tokenUsage)
      };
      await fs.writeFile(this.requestCountFile, JSON.stringify(counts, null, 2));
      this.lastSaveTime = Date.now();
      this.pendingSave = false;
    } catch (error) {
      console.warn('Failed to save request counts:', (error as Error).message);
      this.pendingSave = false;
    }
  }

  scheduleSave(): void {
    if (this.pendingSave) return;

    this.pendingSave = true;
    const now = Date.now();

    if (now - this.lastSaveTime < this.saveInterval) {
      setTimeout(() => this.saveRequestCounts(), this.saveInterval);
    } else {
      this.saveRequestCounts();
    }
  }

  resetRequestCountsIfNeeded(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.requestCount.clear();
      this.webSearchRequestCounts.clear();
      this.webSearchResultCounts.clear();
      this.lastResetDate = today;
      console.log('Request counts reset for new UTC day');
      this.saveRequestCounts();
    }
  }

  async incrementWebSearchRequestCount(accountId: string): Promise<void> {
    const currentCount = this.webSearchRequestCounts.get(accountId) || 0;
    this.webSearchRequestCounts.set(accountId, currentCount + 1);
    this.scheduleSave();
  }

  getWebSearchRequestCount(accountId: string): number {
    return this.webSearchRequestCounts.get(accountId) || 0;
  }

  async incrementWebSearchResultCount(accountId: string, resultCount: number): Promise<void> {
    const currentCount = this.webSearchResultCounts.get(accountId) || 0;
    this.webSearchResultCounts.set(accountId, currentCount + resultCount);
    this.scheduleSave();
  }

  getWebSearchResultCount(accountId: string): number {
    return this.webSearchResultCounts.get(accountId) || 0;
  }

  async incrementRequestCount(accountId: string): Promise<void> {
    this.resetRequestCountsIfNeeded();
    const currentCount = this.requestCount.get(accountId) || 0;
    this.requestCount.set(accountId, currentCount + 1);
    this.scheduleSave();
  }

  async recordTokenUsage(accountId: string, inputTokens: number, outputTokens: number): Promise<void> {
    try {
      const currentDate = new Date().toISOString().split('T')[0];

      if (!this.tokenUsage.has(accountId)) {
        this.tokenUsage.set(accountId, []);
      }

      const accountUsage = this.tokenUsage.get(accountId)!;
      const todayEntry = accountUsage.find(entry => entry.date === currentDate);

      if (todayEntry) {
        todayEntry.inputTokens += inputTokens;
        todayEntry.outputTokens += outputTokens;
      } else {
        accountUsage.push({
          date: currentDate,
          inputTokens: inputTokens,
          outputTokens: outputTokens
        });
      }

      this.scheduleSave();
    } catch (error) {
      console.warn('Failed to record token usage:', (error as Error).message);
    }
  }

  getRequestCount(accountId: string): number {
    this.resetRequestCountsIfNeeded();
    return this.requestCount.get(accountId) || 0;
  }

  incrementAuthErrorCount(accountId: string): number {
    const currentCount = this.authErrorCount.get(accountId) || 0;
    this.authErrorCount.set(accountId, currentCount + 1);
    return currentCount + 1;
  }

  resetAuthErrorCount(accountId: string): void {
    this.authErrorCount.set(accountId, 0);
  }

  getAuthErrorCount(accountId: string): number {
    return this.authErrorCount.get(accountId) || 0;
  }

  getHealthyAccounts(accountIds: string[]): string[] {
    return accountIds.filter(id => {
      const credentials = this.authManager.getAccountCredentials(id);
      return credentials && this.authManager.isTokenValid(credentials);
    });
  }

  async getBestAccount(exclude: Set<string> = new Set()): Promise<AccountInfo | null> {
    const accountIds = this.authManager.getAccountIds();
    let availableAccountIds = accountIds;
    if (exclude && exclude.size) {
      availableAccountIds = availableAccountIds.filter(id => !exclude.has(id));
    }

    const healthyAccountIds = availableAccountIds.filter(id => {
      const credentials = this.authManager.getAccountCredentials(id);
      return credentials && this.authManager.isTokenValid(credentials);
    });

    if (healthyAccountIds.length === 0) {
      console.log('No healthy accounts available');
      return null;
    }

    const accountCredentials: { accountId: string; credentials: QwenCredentials; minutesLeft: number }[] = [];
    for (const accountId of healthyAccountIds) {
      const credentials = this.authManager.getAccountCredentials(accountId);
      if (credentials) {
        const minutesLeft = ((credentials.expiry_date ?? 0) - Date.now()) / 60000;
        accountCredentials.push({ accountId, credentials, minutesLeft });
      }
    }

    if (accountCredentials.length === 0) {
      console.log('No valid credentials found for any available account');
      return null;
    }

    accountCredentials.sort((a, b) => b.minutesLeft - a.minutesLeft);

    for (const account of accountCredentials) {
      try {
        let selectedCredentials = account.credentials;

        if (account.minutesLeft < 0) {
          console.log(`Account ${account.accountId} is expired, attempting refresh...`);
          try {
            selectedCredentials = await this.authManager.performTokenRefresh(account.credentials, account.accountId);
            console.log(`Successfully refreshed account ${account.accountId}`);
          } catch (refreshError) {
            console.log(`Failed to refresh account ${account.accountId}: ${(refreshError as Error).message}`);
            continue;
          }
        }

        return {
          accountId: account.accountId,
          credentials: selectedCredentials
        };
      } catch (error) {
        console.log(`Failed to prepare account ${account.accountId}: ${(error as Error).message}`);
        continue;
      }
    }

    console.log('Could not prepare any account for use');
    return null;
  }

  async getApiEndpoint(credentials: QwenCredentials | null): Promise<string> {
    if (credentials && credentials.resource_url) {
      let endpoint = credentials.resource_url;
      if (!endpoint.startsWith('http')) {
        endpoint = `https://${endpoint}`;
      }
      if (!endpoint.endsWith('/v1')) {
        if (endpoint.endsWith('/')) {
          endpoint += 'v1';
        } else {
          endpoint += '/v1';
        }
      }
      return endpoint;
    } else {
      return DEFAULT_QWEN_API_BASE_URL;
    }
  }

  async chatCompletions(request: ChatCompletionRequest): Promise<unknown> {
    await this.authManager.loadAllAccounts();
    const forcedAccountId = request.accountId;
    if (forcedAccountId) {
      const creds0 = this.authManager.getAccountCredentials(forcedAccountId);
      if (!creds0) {
        throw new Error(`No credentials found for account ${forcedAccountId}`);
      }
      let credentials = creds0;
      if (!this.authManager.isTokenValid(credentials)) {
        credentials = await this.authManager.performTokenRefresh(credentials, forcedAccountId);
      }
      const accountInfo: AccountInfo = { accountId: forcedAccountId, credentials };
      return await this.processRequestWithAccount(request, accountInfo);
    }

    const accountIds = this.authManager.getAccountIds();
    if (accountIds.length === 0) {
      return this.chatCompletionsSingleAccount(request);
    }

    const tried = new Set<string>();
    let lastError: Error | null = null;
    const maxAttempts = 2;

    for (let i = 0; i < maxAttempts; i++) {
      const bestAccount = await this.getBestAccount(tried);
      if (!bestAccount) {
        break;
      }

      try {
        if (this.isAccountRateLimited(bestAccount.accountId)) {
          tried.add(bestAccount.accountId);
          continue;
        }

        try {
          this.incrementAccountRequestCount(bestAccount.accountId);
          return await this.processRequestWithAccount(request, bestAccount);
        } finally {
          // Lock release placeholder
        }
      } catch (error) {
        lastError = error as Error;
        tried.add(bestAccount.accountId);
        continue;
      }
    }

    if (lastError) throw lastError;
    throw new Error('No healthy accounts available');
  }

  async processRequestWithAccount(request: ChatCompletionRequest, accountInfo: AccountInfo): Promise<unknown> {
    const { accountId, credentials } = accountInfo;

    const apiEndpoint = await this.getApiEndpoint(credentials);
    const url = `${apiEndpoint}/chat/completions`;
    const model = resolveModelAlias(request.model || '') || DEFAULT_MODEL;

    const processedMessages = processMessagesForVision(request.messages, model);
    const maxTokens = clampMaxTokens(model, request.max_tokens || 0);

    const payload = {
      model: model,
      messages: processedMessages,
      temperature: request.temperature,
      max_tokens: maxTokens,
      top_p: request.top_p,
      top_k: request.top_k,
      repetition_penalty: request.repetition_penalty,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning: request.reasoning,
      stream: false
    };

    const headers = buildDashScopeHeaders(credentials.access_token, false);

    await this.incrementRequestCount(accountId);

    const response = await axios.post(url, payload, {
      headers: headers,
      timeout: 300000,
      httpAgent,
      httpsAgent
    });

    this.resetAuthErrorCount(accountId);

    if (response.data && response.data.usage) {
      await this.recordTokenUsage(
        accountId,
        response.data.usage.prompt_tokens || 0,
        response.data.usage.completion_tokens || 0
      );
    }

    return response.data;
  }

  async chatCompletionsSingleAccount(request: ChatCompletionRequest): Promise<unknown> {
    const accessToken = await this.authManager.getValidAccessToken();
    const credentials = await this.authManager.loadCredentials();
    const apiEndpoint = await this.getApiEndpoint(credentials);

    const url = `${apiEndpoint}/chat/completions`;
    const model = resolveModelAlias(request.model || '') || DEFAULT_MODEL;

    const processedMessages = processMessagesForVision(request.messages, model);
    const maxTokens = clampMaxTokens(model, request.max_tokens || 0);

    const payload = {
      model: model,
      messages: processedMessages,
      temperature: request.temperature,
      max_tokens: maxTokens,
      top_p: request.top_p,
      top_k: request.top_k,
      repetition_penalty: request.repetition_penalty,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning: request.reasoning
    };

    const headers = buildDashScopeHeaders(accessToken, false);

    try {
      await this.incrementRequestCount('default');

      const response = await axios.post(url, payload, { headers, timeout: 300000, httpAgent, httpsAgent });
      this.resetAuthErrorCount('default');

      if (response.data && response.data.usage) {
        const { prompt_tokens = 0, completion_tokens = 0 } = response.data.usage;
        await this.recordTokenUsage('default', prompt_tokens, completion_tokens);
      }

      return response.data;
    } catch (error) {
      if (isAuthError(error)) {
        const authErrorCount = this.incrementAuthErrorCount('default');
        const axiosErr = error as AxiosError;
        console.log(`\x1b[33mDetected auth error (${axiosErr.response?.status || 'N/A'}) (consecutive count: ${authErrorCount})\x1b[0m`);

        console.log('\x1b[33m%s\x1b[0m', `Attempting token refresh and retry...`);
        try {
          await this.authManager.performTokenRefresh(credentials!);
          const newAccessToken = await this.authManager.getValidAccessToken();

          console.log('\x1b[36m%s\x1b[0m', 'Retrying request with refreshed token...');
          const retryHeaders = buildDashScopeHeaders(newAccessToken, false);

          const retryResponse = await axios.post(url, payload, { headers: retryHeaders, timeout: 300000, httpAgent, httpsAgent });
          console.log('\x1b[32m%s\x1b[0m', 'Request succeeded after token refresh');
          this.resetAuthErrorCount('default');
          return retryResponse.data;
        } catch {
          console.error('\x1b[31m%s\x1b[0m', 'Request failed even after token refresh');
          throw new Error(`Qwen API error (after token refresh attempt): ${axiosErr.response?.status || 'N/A'} ${JSON.stringify(axiosErr.response?.data || axiosErr.message)}`);
        }
      }

      const axiosErr = error as AxiosError;
      if (axiosErr.response) {
        throw new Error(`Qwen API error: ${axiosErr.response.status} ${JSON.stringify(axiosErr.response.data)}`);
      } else if (axiosErr.request) {
        throw new Error(`Qwen API request failed: No response received`);
      } else {
        throw new Error(`Qwen API request failed: ${(error as Error).message}`);
      }
    }
  }

  async acquireAccountLock(accountId: string | null): Promise<boolean> {
    const key = accountId || 'default';
    if (!this.accountLocks.has(key)) {
      this.accountLocks.set(key, true);
      return true;
    }
    return false;
  }

  releaseAccountLock(accountId: string | null): void {
    const key = accountId || 'default';
    if (this.accountLocks.has(key)) {
      this.accountLocks.delete(key);
    }
  }

  isAccountRateLimited(accountId: string): boolean {
    const now = Date.now();
    const accountData = this.accountRequestCounts.get(accountId) || { count: 0, resetTime: now + this.requestWindowDuration };

    if (now >= accountData.resetTime) {
      accountData.count = 0;
      accountData.resetTime = now + this.requestWindowDuration;
    }

    const rateLimit = 60;

    if (accountData.count >= rateLimit) {
      console.log(`\x1b[33mAccount ${accountId} has exceeded rate limit (${rateLimit} requests per ${this.requestWindowDuration / 1000}s window)\x1b[0m`);
      return true;
    }

    return false;
  }

  incrementAccountRequestCount(accountId: string): void {
    const now = Date.now();
    let accountData = this.accountRequestCounts.get(accountId);

    if (!accountData || now >= accountData.resetTime) {
      accountData = { count: 0, resetTime: now + this.requestWindowDuration };
    }

    accountData.count++;
    this.accountRequestCounts.set(accountId, accountData);
  }

  async listModels(): Promise<{ object: string; data: QwenModel[] }> {
    console.log('Returning mock models list');

    return {
      object: 'list',
      data: QWEN_MODELS
    };
  }

  async streamChatCompletions(request: ChatCompletionRequest): Promise<PassThrough> {
    await this.authManager.loadAllAccounts();
    const forcedAccountId = request.accountId;
    const accountIds = this.authManager.getAccountIds();

    if (forcedAccountId) {
      const creds0 = this.authManager.getAccountCredentials(forcedAccountId);
      if (!creds0) throw new Error(`No credentials found for account ${forcedAccountId}`);
      let credentials = creds0;
      if (!this.authManager.isTokenValid(credentials)) {
        credentials = await this.authManager.performTokenRefresh(credentials, forcedAccountId);
      }
      const apiEndpoint = await this.getApiEndpoint(credentials);
      const url = `${apiEndpoint}/chat/completions`;
      const model = request.model || DEFAULT_MODEL;
      const processedMessages = processMessagesForVision(request.messages, model);
      const maxTokens = clampMaxTokens(model, request.max_tokens || 0);
      const payload = { model, messages: processedMessages, temperature: request.temperature, max_tokens: maxTokens, top_p: request.top_p, top_k: request.top_k, repetition_penalty: request.repetition_penalty, tools: request.tools, tool_choice: request.tool_choice, reasoning: request.reasoning, stream: true, stream_options: { include_usage: true } };
      const headers = buildDashScopeHeaders(credentials.access_token, true);

      await this.incrementRequestCount(forcedAccountId);

      const stream = new PassThrough();
      const response = await axios.post(url, payload, { headers, timeout: 300000, responseType: 'stream', httpAgent, httpsAgent });
      response.data.pipe(stream);
      return stream;
    }

    if (accountIds.length === 0) {
      const accessToken = await this.authManager.getValidAccessToken();
      const credentials = await this.authManager.loadCredentials();
      const apiEndpoint = await this.getApiEndpoint(credentials);
      const url = `${apiEndpoint}/chat/completions`;
      const model = resolveModelAlias(request.model || '') || DEFAULT_MODEL;
      const processedMessages = processMessagesForVision(request.messages, model);
      const maxTokens = clampMaxTokens(model, request.max_tokens || 0);
      const payload = { model, messages: processedMessages, temperature: request.temperature, max_tokens: maxTokens, top_p: request.top_p, top_k: request.top_k, repetition_penalty: request.repetition_penalty, tools: request.tools, tool_choice: request.tool_choice, reasoning: request.reasoning, stream: true, stream_options: { include_usage: true } };
      const headers = buildDashScopeHeaders(accessToken, true);

      await this.incrementRequestCount('default');

      const stream = new PassThrough();
      const response = await axios.post(url, payload, { headers, timeout: 300000, responseType: 'stream', httpAgent, httpsAgent });
      response.data.pipe(stream);
      return stream;
    }

    const tried = new Set<string>();
    let lastError: Error | null = null;
    for (let i = 0; i < 2; i++) {
      const bestAccount = await this.getBestAccount(tried);
      if (!bestAccount) break;
      const { accountId, credentials } = bestAccount;

      try {
        if (this.isAccountRateLimited(accountId)) {
          tried.add(accountId);
          continue;
        }

        try {
          const apiEndpoint = await this.getApiEndpoint(credentials);
          const url = `${apiEndpoint}/chat/completions`;
          const model = resolveModelAlias(request.model || '') || DEFAULT_MODEL;
          const processedMessages = processMessagesForVision(request.messages, model);
          const maxTokens = clampMaxTokens(model, request.max_tokens || 0);
          const payload = { model, messages: processedMessages, temperature: request.temperature, max_tokens: maxTokens, top_p: request.top_p, top_k: request.top_k, repetition_penalty: request.repetition_penalty, tools: request.tools, tool_choice: request.tool_choice, reasoning: request.reasoning, stream: true, stream_options: { include_usage: true } };
          const headers = buildDashScopeHeaders(credentials.access_token, true);
          const stream = new PassThrough();

          this.incrementAccountRequestCount(accountId);
          await this.incrementRequestCount(accountId);

          const response = await axios.post(url, payload, { headers, timeout: 300000, responseType: 'stream', httpAgent, httpsAgent });
          response.data.pipe(stream);
          return stream;
        } finally {
          // Lock release placeholder
        }
      } catch (error) {
        lastError = error as Error;
        tried.add(bestAccount.accountId);
        continue;
      }
    }
    if (lastError) throw lastError;
    throw new Error('No healthy accounts available');
  }

  async webSearch(request: WebSearchRequest): Promise<unknown> {
    await this.authManager.loadAllAccounts();
    const forcedAccountId = request.accountId;

    if (forcedAccountId) {
      const creds0 = this.authManager.getAccountCredentials(forcedAccountId);
      if (!creds0) {
        throw new Error(`No credentials found for account ${forcedAccountId}`);
      }
      let credentials = creds0;
      if (!this.authManager.isTokenValid(credentials)) {
        credentials = await this.authManager.performTokenRefresh(credentials, forcedAccountId);
      }
      const accountInfo: AccountInfo = { accountId: forcedAccountId, credentials };
      return await this.processWebSearchWithAccount(request, accountInfo);
    }

    const accountIds = this.authManager.getAccountIds();
    if (accountIds.length === 0) {
      return this.webSearchSingleAccount(request);
    }

    const tried = new Set<string>();
    let lastError: Error | null = null;
    const maxAttempts = 2;

    for (let i = 0; i < maxAttempts; i++) {
      const bestAccount = await this.getBestAccount(tried);
      if (!bestAccount) {
        break;
      }

      try {
        if (this.isAccountRateLimited(bestAccount.accountId)) {
          tried.add(bestAccount.accountId);
          continue;
        }

        try {
          this.incrementAccountRequestCount(bestAccount.accountId);
          return await this.processWebSearchWithAccount(request, bestAccount);
        } finally {
          // Account handling done in processWebSearchWithAccount
        }
      } catch (error) {
        lastError = error as Error;
        tried.add(bestAccount.accountId);
        continue;
      }
    }

    if (lastError) throw lastError;
    throw new Error('No accounts available');
  }

  async getWebSearchEndpoint(credentials: QwenCredentials | null): Promise<string> {
    if (credentials && credentials.resource_url) {
      let endpoint = credentials.resource_url;
      if (!endpoint.startsWith('http')) {
        endpoint = `https://${endpoint}`;
      }
      endpoint = endpoint.replace(/\/$/, '');
      return endpoint;
    } else {
      return 'https://dashscope.aliyuncs.com/compatible-mode';
    }
  }

  async processWebSearchWithAccount(request: WebSearchRequest, accountInfo: AccountInfo): Promise<unknown> {
    const { accountId, credentials } = accountInfo;

    const webSearchBaseUrl = await this.getWebSearchEndpoint(credentials);
    const webSearchUrl = `${webSearchBaseUrl}/api/v1/indices/plugin/web_search`;

    const payload = {
      uq: request.query,
      page: request.page || 1,
      rows: request.rows || 10
    };

    const headers = buildDashScopeHeaders(credentials.access_token, false);

    await this.incrementWebSearchRequestCount(accountId);

    const response = await axios.post(webSearchUrl, payload, {
      headers: headers,
      timeout: 300000,
      httpAgent,
      httpsAgent
    });

    this.resetAuthErrorCount(accountId);

    const resultCount = response.data?.data?.docs?.length || 0;
    if (resultCount > 0) {
      await this.incrementWebSearchResultCount(accountId, resultCount);
    }

    console.log(`\x1b[32mWeb search completed successfully using account ${accountId}. Found ${response.data?.data?.total || 0} results, returned ${resultCount}.\x1b[0m`);
    return response.data;
  }

  async webSearchSingleAccount(request: WebSearchRequest): Promise<unknown> {
    const accessToken = await this.authManager.getValidAccessToken();
    const credentials = await this.authManager.loadCredentials();
    const webSearchBaseUrl = await this.getWebSearchEndpoint(credentials);
    const webSearchUrl = `${webSearchBaseUrl}/api/v1/indices/plugin/web_search`;

    const payload = {
      uq: request.query,
      page: request.page || 1,
      rows: request.rows || 10
    };

    const headers = buildDashScopeHeaders(accessToken, false);

    try {
      await this.incrementWebSearchRequestCount('default');

      const response = await axios.post(webSearchUrl, payload, { headers, timeout: 300000, httpAgent, httpsAgent });

      this.resetAuthErrorCount('default');

      const resultCount = response.data?.data?.docs?.length || 0;
      if (resultCount > 0) {
        await this.incrementWebSearchResultCount('default', resultCount);
      }

      return response.data;
    } catch (error) {
      if (isAuthError(error)) {
        const authErrorCount = this.incrementAuthErrorCount('default');
        const axiosErr = error as AxiosError;
        console.log(`\x1b[33mDetected auth error (${axiosErr.response?.status || 'N/A'}) (consecutive count: ${authErrorCount})\x1b[0m`);

        console.log('\x1b[33m%s\x1b[0m', `Attempting token refresh and retry...`);
        try {
          await this.authManager.performTokenRefresh(credentials!);
          const newAccessToken = await this.authManager.getValidAccessToken();

          console.log('\x1b[36m%s\x1b[0m', 'Retrying web search request with refreshed token...');
          const retryHeaders = buildDashScopeHeaders(newAccessToken, false);

          const retryResponse = await axios.post(webSearchUrl, payload, { headers: retryHeaders, timeout: 300000, httpAgent, httpsAgent });
          console.log('\x1b[32m%s\x1b[0m', 'Web search request succeeded after token refresh');
          this.resetAuthErrorCount('default');
          return retryResponse.data;
        } catch {
          console.error('\x1b[31m%s\x1b[0m', 'Web search request failed even after token refresh');
          throw new Error(`Qwen web search API error (after token refresh attempt): ${axiosErr.response?.status || 'N/A'} ${JSON.stringify(axiosErr.response?.data || axiosErr.message)}`);
        }
      }

      const axiosErr = error as AxiosError;
      if (axiosErr.response) {
        throw new Error(`Qwen web search API error: ${axiosErr.response.status} ${JSON.stringify(axiosErr.response.data)}`);
      } else if (axiosErr.request) {
        throw new Error(`Qwen web search API request failed: No response received`);
      } else {
        throw new Error(`Qwen web search API request failed: ${(error as Error).message}`);
      }
    }
  }
}
