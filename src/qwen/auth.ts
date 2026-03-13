import * as path from 'path';
import { promises as fs } from 'fs';
import { fetch } from 'undici';
import * as crypto from 'crypto';

// File System Configuration
const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';
const QWEN_MULTI_ACCOUNT_PREFIX = 'oauth_creds_';
const QWEN_MULTI_ACCOUNT_SUFFIX = '.json';

// OAuth Configuration (from qwen-code analysis)
const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai';
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds

export interface QwenCredentials {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  resource_url?: string;
  expiry_date?: number;
}

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  code_verifier: string;
  expires_in?: number;
  interval?: number;
}

export interface AccountInfo {
  accountId: string;
  credentials: QwenCredentials;
}

interface QwenAPIRef {
  acquireAccountLock(accountId: string | null): Promise<boolean>;
  releaseAccountLock(accountId: string | null): void;
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(codeVerifier);
  return hash.digest('base64url');
}

function generatePKCEPair(): { code_verifier: string; code_challenge: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}

export class QwenAuthManager {
  public qwenDir: string;
  public credentialsPath: string;
  public credentials: QwenCredentials | null;
  private refreshPromise: Promise<QwenCredentials> | null;
  public accounts: Map<string, QwenCredentials>;
  public currentAccountIndex: number;
  private qwenAPI: QwenAPIRef | null;

  constructor() {
    this.qwenDir = path.join(process.env.HOME || process.env.USERPROFILE || '', QWEN_DIR);
    this.credentialsPath = path.join(this.qwenDir, QWEN_CREDENTIAL_FILENAME);
    this.credentials = null;
    this.refreshPromise = null;
    this.accounts = new Map();
    this.currentAccountIndex = 0;
    this.qwenAPI = null;
  }

  init(qwenAPI: QwenAPIRef): void {
    this.qwenAPI = qwenAPI;
  }

  async loadCredentials(): Promise<QwenCredentials | null> {
    const config = (await import('../config')).default;
    if (config.qwenCodeAuthUse === false) {
      return null;
    }

    if (this.credentials) {
      return this.credentials;
    }
    try {
      const credentialsData = await fs.readFile(this.credentialsPath, 'utf8');
      this.credentials = JSON.parse(credentialsData) as QwenCredentials;
      return this.credentials;
    } catch {
      return null;
    }
  }

  async loadAllAccounts(): Promise<Map<string, QwenCredentials>> {
    try {
      this.accounts.clear();

      const files = await fs.readdir(this.qwenDir);

      const accountFiles = files.filter(file =>
        file.startsWith(QWEN_MULTI_ACCOUNT_PREFIX) &&
        file.endsWith(QWEN_MULTI_ACCOUNT_SUFFIX) &&
        file !== QWEN_CREDENTIAL_FILENAME
      );

      const config = (await import('../config')).default;
      try {
        const defaultAuthExists = await fs.access(this.credentialsPath).then(() => true).catch(() => false);

        if (defaultAuthExists && accountFiles.length > 0 && config.qwenCodeAuthUse !== false) {
          console.log('\n\x1b[31m%s\x1b[0m', '[PROXY WARNING] Conflicting authentication files detected!');
          console.log('\x1b[31m%s\x1b[0m', 'Found both default ~/.qwen/oauth_creds.json (created by qwen-code) and named account file(s) ~/.qwen/oauth_creds_<name>.json');
          console.log('\x1b[31m%s\x1b[0m', 'If these were created with the same account, token refresh conflicts will occur, invalidating the other file.');
          console.log('\x1b[31m%s\x1b[0m', 'Solution: Set QWEN_CODE_AUTH_USE=false in your .env file, or remove the default auth file.');
        }
      } catch {
        // Ignore check errors
      }

      for (const file of accountFiles) {
        try {
          const accountPath = path.join(this.qwenDir, file);
          const credentialsData = await fs.readFile(accountPath, 'utf8');
          const credentials = JSON.parse(credentialsData) as QwenCredentials;

          const accountId = file.substring(
            QWEN_MULTI_ACCOUNT_PREFIX.length,
            file.length - QWEN_MULTI_ACCOUNT_SUFFIX.length
          );

          this.accounts.set(accountId, credentials);
        } catch (error) {
          console.warn(`Failed to load account from ${file}:`, (error as Error).message);
        }
      }

      return this.accounts;
    } catch (error) {
      console.warn('Failed to load multi-account credentials:', (error as Error).message);
      return this.accounts;
    }
  }

  async saveCredentials(credentials: QwenCredentials, accountId: string | null = null): Promise<void> {
    try {
      const credString = JSON.stringify(credentials, null, 2);

      if (accountId) {
        const accountFilename = `${QWEN_MULTI_ACCOUNT_PREFIX}${accountId}${QWEN_MULTI_ACCOUNT_SUFFIX}`;
        const accountPath = path.join(this.qwenDir, accountFilename);
        await fs.writeFile(accountPath, credString);
        this.accounts.set(accountId, credentials);
      } else {
        await fs.writeFile(this.credentialsPath, credString);
        this.credentials = credentials;
      }
    } catch (error) {
      console.error('Error saving credentials:', (error as Error).message);
    }
  }

  isTokenValid(credentials: QwenCredentials | null): boolean {
    if (!credentials || !credentials.access_token || !credentials.expiry_date) {
      return false;
    }

    if (typeof credentials.access_token !== 'string' || credentials.access_token.length === 0) {
      console.warn('Invalid access token format');
      return false;
    }

    if (isNaN(credentials.expiry_date) || credentials.expiry_date <= 0) {
      console.warn('Invalid expiry date');
      return false;
    }

    return Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
  }

  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  getAccountCredentials(accountId: string): QwenCredentials | null {
    return this.accounts.get(accountId) || null;
  }

  async addAccount(credentials: QwenCredentials, accountId: string): Promise<void> {
    await this.saveCredentials(credentials, accountId);
  }

  async removeAccount(accountId: string): Promise<void> {
    try {
      const accountFilename = `${QWEN_MULTI_ACCOUNT_PREFIX}${accountId}${QWEN_MULTI_ACCOUNT_SUFFIX}`;
      const accountPath = path.join(this.qwenDir, accountFilename);

      await fs.unlink(accountPath);
      this.accounts.delete(accountId);

      console.log(`Account ${accountId} removed successfully`);
    } catch (error) {
      console.error(`Error removing account ${accountId}:`, (error as Error).message);
      throw error;
    }
  }

  async refreshAccessToken(credentials: QwenCredentials): Promise<QwenCredentials> {
    console.log('\x1b[33m%s\x1b[0m', 'Refreshing Qwen access token...');

    if (!credentials || !credentials.refresh_token) {
      throw new Error('No refresh token available. Please re-authenticate with the Qwen CLI.');
    }

    const bodyData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID,
    });

    try {
      const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyData,
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string; error_description?: string };
        throw new Error(`Token refresh failed: ${errorData.error} - ${errorData.error_description}`);
      }

      const tokenData = await response.json() as {
        access_token: string;
        token_type?: string;
        refresh_token?: string;
        resource_url?: string;
        expires_in: number;
      };
      const newCredentials: QwenCredentials = {
        ...credentials,
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        refresh_token: tokenData.refresh_token || credentials.refresh_token,
        resource_url: tokenData.resource_url || credentials.resource_url,
        expiry_date: Date.now() + tokenData.expires_in * 1000,
      };

      await this.saveCredentials(newCredentials);
      console.log('\x1b[32m%s\x1b[0m', 'Qwen access token refreshed successfully');
      return newCredentials;
    } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', 'Failed to refresh Qwen access token with error:', (error as Error).message);
      throw new Error('Failed to refresh access token. Please re-authenticate with the Qwen CLI.');
    }
  }

  async getValidAccessToken(accountId: string | null = null): Promise<string> {
    if (this.refreshPromise) {
      console.log('\x1b[36m%s\x1b[0m', 'Waiting for ongoing token refresh...');
      const creds = await this.refreshPromise;
      return creds.access_token;
    }

    try {
      let credentials: QwenCredentials | null;

      if (accountId) {
        credentials = this.getAccountCredentials(accountId);
        if (!credentials) {
          await this.loadAllAccounts();
          credentials = this.getAccountCredentials(accountId);
        }
      } else {
        credentials = await this.loadCredentials();
      }

      if (!credentials) {
        if (accountId) {
          throw new Error(`No credentials found for account ${accountId}. Please authenticate this account first.`);
        } else {
          throw new Error('No credentials found. Please authenticate with Qwen CLI first.');
        }
      }

      if (this.isTokenValid(credentials)) {
        return credentials.access_token;
      }

      this.refreshPromise = this.performTokenRefresh(credentials, accountId);

      try {
        const newCredentials = await this.refreshPromise;
        return newCredentials.access_token;
      } finally {
        this.refreshPromise = null;
      }
    } catch (error) {
      this.refreshPromise = null;
      throw error;
    }
  }

  async performTokenRefresh(credentials: QwenCredentials, accountId: string | null = null): Promise<QwenCredentials> {
    if (!this.qwenAPI) {
      throw new Error('QwenAPI not initialized');
    }

    const lockAcquired = await this.qwenAPI.acquireAccountLock(accountId);
    if (!lockAcquired) {
      throw new Error(accountId ?
        `Account ${accountId} is currently in use, cannot refresh token now` :
        'Default account is currently in use, cannot refresh token now');
    }

    try {
      const newCredentials = await this.refreshAccessToken(credentials);

      if (accountId) {
        await this.saveCredentials(newCredentials, accountId);
      } else {
        await this.saveCredentials(newCredentials);
      }

      return newCredentials;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.qwenAPI.releaseAccountLock(accountId);
    }
  }

  async getNextAccount(): Promise<AccountInfo | null> {
    if (this.accounts.size === 0) {
      await this.loadAllAccounts();
    }

    const accountIds = this.getAccountIds();

    if (accountIds.length === 0) {
      return null;
    }

    const accountId = accountIds[this.currentAccountIndex];
    const credentials = this.getAccountCredentials(accountId);

    this.currentAccountIndex = (this.currentAccountIndex + 1) % accountIds.length;

    if (!credentials) return null;
    return { accountId, credentials };
  }

  peekNextAccount(): AccountInfo | null {
    if (this.accounts.size === 0) {
      return null;
    }

    const accountIds = this.getAccountIds();

    if (accountIds.length === 0) {
      return null;
    }

    const accountId = accountIds[this.currentAccountIndex];
    const credentials = this.getAccountCredentials(accountId);

    if (!credentials) return null;
    return { accountId, credentials };
  }

  isAccountValid(accountId: string): boolean {
    const credentials = this.getAccountCredentials(accountId);
    return credentials !== null && this.isTokenValid(credentials);
  }

  async initiateDeviceFlow(): Promise<DeviceFlowResponse> {
    const { code_verifier, code_challenge } = generatePKCEPair();

    const bodyData = new URLSearchParams({
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge: code_challenge,
      code_challenge_method: 'S256',
    });

    try {
      const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyData,
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Device authorization failed: ${response.status} ${response.statusText}. Response: ${errorData}`);
      }

      const result = await response.json() as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      };

      if (!result.device_code) {
        throw new Error(`Device authorization failed: ${result.error || 'Unknown error'} - ${result.error_description || 'No details provided'}`);
      }

      return {
        ...result,
        code_verifier: code_verifier
      } as DeviceFlowResponse;
    } catch (error) {
      console.error('Device authorization flow failed:', (error as Error).message);
      throw error;
    }
  }

  async pollForToken(device_code: string, code_verifier: string, accountId: string | null = null): Promise<QwenCredentials> {
    let pollInterval = 5000;
    const maxAttempts = 60;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const bodyData = new URLSearchParams({
        grant_type: QWEN_OAUTH_GRANT_TYPE,
        client_id: QWEN_OAUTH_CLIENT_ID,
        device_code: device_code,
        code_verifier: code_verifier,
      });

      try {
        const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: bodyData,
        });

        if (!response.ok) {
          try {
            const errorData = await response.json() as { error?: string; error_description?: string };

            if (response.status === 400 && errorData.error === 'authorization_pending') {
              console.log(`Polling attempt ${attempt + 1}/${maxAttempts}...`);
              await new Promise(resolve => setTimeout(resolve, pollInterval));
              continue;
            }

            if (response.status === 400 && errorData.error === 'slow_down') {
              pollInterval = Math.min(pollInterval * 1.5, 10000);
              console.log(`Server requested to slow down, increasing poll interval to ${pollInterval}ms`);
              await new Promise(resolve => setTimeout(resolve, pollInterval));
              continue;
            }

            if (response.status === 400 && errorData.error === 'expired_token') {
              throw new Error('Device code expired. Please restart the authentication process.');
            }

            if (response.status === 400 && errorData.error === 'access_denied') {
              throw new Error('Authorization denied by user. Please restart the authentication process.');
            }

            throw new Error(`Device token poll failed: ${errorData.error || 'Unknown error'} - ${errorData.error_description || 'No details provided'}`);
          } catch (_parseError) {
            if ((_parseError as Error).message.includes('Device') || (_parseError as Error).message.includes('Authorization')) {
              throw _parseError;
            }
            const errorText = await response.text();
            throw new Error(`Device token poll failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
          }
        }

        const tokenData = await response.json() as {
          access_token: string;
          refresh_token?: string;
          token_type?: string;
          resource_url?: string;
          endpoint?: string;
          expires_in?: number;
        };

        const credentials: QwenCredentials = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || undefined,
          token_type: tokenData.token_type,
          resource_url: tokenData.resource_url || tokenData.endpoint,
          expiry_date: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
        };

        await this.saveCredentials(credentials, accountId);

        return credentials;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('expired_token') ||
            errorMessage.includes('access_denied') ||
            errorMessage.includes('Device authorization failed')) {
          throw error;
        }

        console.log(`Polling attempt ${attempt + 1}/${maxAttempts} failed:`, errorMessage);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error('Authentication timeout. Please restart the authentication process.');
  }
}
