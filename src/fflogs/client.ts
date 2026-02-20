import { getAccessToken, OAuthConfig } from './auth';
import { GraphQLResponse } from './types';

const DEFAULT_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface FFLogsClientConfig extends OAuthConfig {
  graphqlUrl: string;
  maxRetries?: number;
  locale?: string;
  requestTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FFLogsGraphQLClient {
  private readonly config: FFLogsClientConfig;

  constructor(config: FFLogsClientConfig) {
    this.config = config;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = this.config.requestTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return fetch(url, init);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`GraphQL request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const maxRetries = this.config.maxRetries ?? DEFAULT_RETRIES;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      try {
        const token = await getAccessToken(this.config);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        };
        if (this.config.locale) {
          headers['Accept-Language'] = this.config.locale;
        }

        const response = await this.fetchWithTimeout(this.config.graphqlUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables })
        });

        if (RETRYABLE_STATUS.has(response.status) && attempt <= maxRetries) {
          await sleep(250 * 2 ** (attempt - 1));
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`GraphQL request failed: ${response.status} ${response.statusText} ${text}`);
        }

        const payload = (await response.json()) as GraphQLResponse<T>;
        if (payload.errors?.length) {
          const message = payload.errors.map((e) => e.message).join(' | ');
          throw new Error(`GraphQL errors: ${message}`);
        }
        if (!payload.data) {
          throw new Error('GraphQL response returned no data.');
        }

        return payload.data;
      } catch (error) {
        if (attempt > maxRetries) {
          throw error;
        }
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }
}
