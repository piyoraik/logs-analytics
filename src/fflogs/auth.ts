interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

interface OAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function getAccessToken(config: OAuthConfig): Promise<string> {
  if (cache && cache.expiresAt > Date.now() + 30_000) {
    return cache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch OAuth token: ${response.status} ${response.statusText} ${text}`);
  }

  const json = (await response.json()) as OAuthResponse;
  if (!json.access_token || !json.expires_in) {
    throw new Error('OAuth token response is missing required fields (access_token/expires_in).');
  }

  cache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  };

  return json.access_token;
}
