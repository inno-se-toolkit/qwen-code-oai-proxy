import type { QwenAPI } from '../qwen/api';

export class AccountRefreshScheduler {
  private qwenAPI: QwenAPI;
  private refreshInterval: ReturnType<typeof setInterval> | null;
  private isRefreshing: boolean;

  constructor(qwenAPI: QwenAPI) {
    this.qwenAPI = qwenAPI;
    this.refreshInterval = null;
    this.isRefreshing = false;
  }

  async initialize(): Promise<void> {
    console.log('\x1b[36m%s\x1b[0m', 'Initializing account refresh scheduler...');
    await this.startScheduler();
  }

  async startScheduler(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    await this.checkAndRefreshExpiredAccounts();

    this.refreshInterval = setInterval(async () => {
      console.log('\x1b[36m%s\x1b[0m', 'Running background account refresh check...');
      await this.checkAndRefreshExpiredAccounts();
    }, 5 * 60 * 1000);

    console.log('\x1b[32m%s\x1b[0m', 'Account refresh scheduler started - will run in background every 5 minutes');
  }

  stopScheduler(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      console.log('\x1b[33m%s\x1b[0m', 'Account refresh scheduler stopped');
    }
  }

  async checkAndRefreshExpiredAccounts(): Promise<void> {
    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;

    try {
      console.log('\x1b[36m%s\x1b[0m', 'Checking for expired accounts...');

      await this.qwenAPI.authManager.loadAllAccounts();

      const accountIds = this.qwenAPI.authManager.getAccountIds();

      if (accountIds.length === 0) {
        console.log('\x1b[33m%s\x1b[0m', 'No accounts configured, skipping refresh check');
        return;
      }

      const accountsToRefresh: string[] = [];
      let expiredAccountsFound = false;

      for (const accountId of accountIds) {
        const credentials = this.qwenAPI.authManager.getAccountCredentials(accountId);

        if (!credentials) {
          console.log(`\x1b[31m%s\x1b[0m`, `No credentials found for account ${accountId}`);
          continue;
        }

        const isExpired = (credentials.expiry_date ?? 0) <= Date.now();
        const minutesLeft = ((credentials.expiry_date ?? 0) - Date.now()) / 60000;

        if (isExpired) {
          expiredAccountsFound = true;
          accountsToRefresh.push(accountId);
          console.log(`\x1b[33m%s\x1b[0m`, `Account ${accountId} is expired (was valid until ${new Date(credentials.expiry_date ?? 0).toISOString()})`);
        } else if (minutesLeft <= 10) {
          expiredAccountsFound = true;
          accountsToRefresh.push(accountId);
          console.log(`\x1b[33m%s\x1b[0m`, `Account ${accountId} expires in ${minutesLeft.toFixed(1)} minutes (within 10 minute threshold), including for proactive refresh`);
        } else {
          const refreshThresholdMinutes = Math.floor(Math.random() * 21) + 10;

          if (minutesLeft <= refreshThresholdMinutes) {
            expiredAccountsFound = true;
            accountsToRefresh.push(accountId);
            console.log(`\x1b[33m%s\x1b[0m`, `Account ${accountId} expires in ${minutesLeft.toFixed(1)} minutes (less than ${refreshThresholdMinutes} minute threshold), including for proactive refresh`);
          } else if (minutesLeft < 60) {
            console.log(`\x1b[33m%s\x1b[0m`, `Account ${accountId} token expires in ${minutesLeft.toFixed(1)} minutes`);
          } else {
            console.log(`\x1b[32m%s\x1b[0m`, `Account ${accountId} token is valid for ${minutesLeft.toFixed(1)} more minutes`);
          }
        }
      }

      if (!expiredAccountsFound) {
        console.log('\x1b[32m%s\x1b[0m', 'No accounts need refresh (no expired or soon-to-expire accounts)');
        return;
      }

      const batchSize = 20;
      for (let i = 0; i < accountsToRefresh.length; i += batchSize) {
        const batch = accountsToRefresh.slice(i, i + batchSize);

        const batchPromises = batch.map(async (accountId) => {
          const credentials = this.qwenAPI.authManager.getAccountCredentials(accountId);

          if (!credentials) {
            console.log(`\x1b[31m%s\x1b[0m`, `No credentials found for account ${accountId}`);
            return;
          }

          try {
            const refreshedCredentials = await this.qwenAPI.authManager.performTokenRefresh(credentials, accountId);
            console.log(`\x1b[32m%s\x1b[0m`, `Successfully refreshed token for account ${accountId}. New expiry: ${new Date(refreshedCredentials.expiry_date ?? 0).toISOString()}`);
          } catch (refreshError) {
            console.log(`\x1b[31m%s\x1b[0m`, `Failed to refresh token for account ${accountId}: ${(refreshError as Error).message}`);
          }
        });

        await Promise.allSettled(batchPromises);
      }

      console.log('\x1b[32m%s\x1b[0m', 'Expired account refresh check completed');
    } catch (error) {
      console.log(`\x1b[31m%s\x1b[0m`, `Error during account refresh check: ${(error as Error).message}`);
    } finally {
      this.isRefreshing = false;
    }
  }

  async forceRefreshAllAccounts(): Promise<void> {
    console.log('\x1b[36m%s\x1b[0m', 'Forcing refresh of all accounts...');

    await this.qwenAPI.authManager.loadAllAccounts();

    const accountIds = this.qwenAPI.authManager.getAccountIds();

    if (accountIds.length === 0) {
      console.log('\x1b[33m%s\x1b[0m', 'No accounts configured');
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const accountId of accountIds) {
      const credentials = this.qwenAPI.authManager.getAccountCredentials(accountId);

      if (!credentials) {
        console.log(`\x1b[31m%s\x1b[0m`, `No credentials found for account ${accountId}`);
        failCount++;
        continue;
      }

      const lockAcquired = await this.qwenAPI.acquireAccountLock(accountId);
      if (lockAcquired) {
        try {
          const refreshedCredentials = await this.qwenAPI.authManager.performTokenRefresh(credentials, accountId);
          console.log(`\x1b[32m%s\x1b[0m`, `Successfully refreshed token for account ${accountId}. New expiry: ${new Date(refreshedCredentials.expiry_date ?? 0).toISOString()}`);
          successCount++;
        } catch (refreshError) {
          console.log(`\x1b[31m%s\x1b[0m`, `Failed to refresh token for account ${accountId}: ${(refreshError as Error).message}`);
          failCount++;
        } finally {
          this.qwenAPI.releaseAccountLock(accountId);
        }
      } else {
        console.log(`\x1b[33m%s\x1b[0m`, `Account ${accountId} is currently in use, skipping refresh`);
        failCount++;
      }
    }

    console.log(`\x1b[36m%s\x1b[0m`, `Force refresh completed: ${successCount} successful, ${failCount} skipped or failed`);
  }
}
