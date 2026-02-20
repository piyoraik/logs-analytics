import { NextRequest } from 'next/server';

export function normalizeRegion(value: string | null): string {
  const s = String(value ?? '').trim().toUpperCase();
  if (['JP', 'US', 'EU', 'KR', 'OC', 'CN', 'TW'].includes(s)) {
    return s;
  }
  return '';
}

export function normalizeServerSlug(value: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

export function serverSlugToName(slug: string): string {
  return String(slug ?? '')
    .split('-')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function maybeParseJson(value: unknown): any {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

function extractGraphqlError(payload: any): string {
  const errs = Array.isArray(payload?.errors) ? payload.errors : [];
  if (errs.length === 0) return 'GraphQL request failed';
  return `GraphQL errors: ${errs.map((e: any) => e?.message ?? String(e)).join(' | ')}`;
}

export async function getFFLogsToken(): Promise<string> {
  const clientId = process.env.FFLOGS_CLIENT_ID;
  const clientSecret = process.env.FFLOGS_CLIENT_SECRET;
  const tokenUrl = process.env.FFLOGS_TOKEN_URL ?? 'https://www.fflogs.com/oauth/token';
  if (!clientId || !clientSecret) {
    throw new Error('FFLOGS_CLIENT_ID / FFLOGS_CLIENT_SECRET are not set');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error('Token response has no access_token');
  }
  return json.access_token;
}

export async function requestFFLogsGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getFFLogsToken();
  const graphqlUrl = process.env.FFLOGS_GRAPHQL_URL ?? 'https://www.fflogs.com/api/v2/client';
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}`);
  }
  if (payload?.errors) {
    throw new Error(extractGraphqlError(payload));
  }
  return payload.data as T;
}

export function extractCharacterContents(zoneRankingsPayload: unknown): Array<{
  zoneId: number;
  zoneName: string;
  encounterId: number;
  encounterName: string;
  bestPercent: number;
  totalKills: number;
}> {
  const payload = maybeParseJson(zoneRankingsPayload);
  if (!payload) return [];
  const out: Array<{
    zoneId: number;
    zoneName: string;
    encounterId: number;
    encounterName: string;
    bestPercent: number;
    totalKills: number;
  }> = [];

  const zones =
    (Array.isArray(payload.zones) && payload.zones) ||
    (Array.isArray(payload.data?.zones) && payload.data.zones) ||
    [];
  for (const zone of zones) {
    const zoneId = Number(zone?.zoneID ?? zone?.id ?? 0);
    const zoneName = String(zone?.zoneName ?? zone?.name ?? '');
    const encounters = Array.isArray(zone?.encounters) ? zone.encounters : [];
    for (const enc of encounters) {
      const encounterId = Number(enc?.id ?? enc?.encounterID ?? 0);
      if (!Number.isFinite(encounterId) || encounterId <= 0) continue;
      out.push({
        zoneId: Number.isFinite(zoneId) ? zoneId : 0,
        zoneName,
        encounterId,
        encounterName: String(enc?.name ?? ''),
        bestPercent: Number(enc?.rankPercent ?? enc?.bestPercent ?? 0),
        totalKills: Number(enc?.totalKills ?? enc?.killCount ?? 0)
      });
    }
  }

  if (out.length === 0) {
    const queue: Array<{ node: any; zoneId: number; zoneName: string }> = [{ node: payload, zoneId: 0, zoneName: '' }];
    const seen = new Set<any>();
    while (queue.length > 0) {
      const { node, zoneId, zoneName } = queue.shift()!;
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      const nextZoneId = Number(node.zoneID ?? node.zoneId ?? node.id ?? zoneId);
      const nextZoneName = String(node.zoneName ?? node.zone ?? node.name ?? zoneName ?? '');

      const maybeEncounterId = Number(node.encounterID ?? node.encounterId ?? node.id);
      const maybeEncounterName = String(node.encounterName ?? node.name ?? '');
      if (Number.isFinite(maybeEncounterId) && maybeEncounterId > 0 && maybeEncounterName) {
        out.push({
          zoneId: Number.isFinite(nextZoneId) ? nextZoneId : 0,
          zoneName: nextZoneName,
          encounterId: maybeEncounterId,
          encounterName: maybeEncounterName,
          bestPercent: Number(node.rankPercent ?? node.bestPercent ?? 0),
          totalKills: Number(node.totalKills ?? node.killCount ?? 0)
        });
      }

      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') {
          queue.push({ node: v, zoneId: nextZoneId, zoneName: nextZoneName });
        }
      }
    }
  }

  const map = new Map<string, (typeof out)[number]>();
  for (const item of out) {
    const key = `${item.zoneId}:${item.encounterId}`;
    const prev = map.get(key);
    if (!prev || item.bestPercent > prev.bestPercent) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.zoneName !== b.zoneName) return a.zoneName.localeCompare(b.zoneName);
    return a.encounterName.localeCompare(b.encounterName);
  });
}

export function getQuery(req: NextRequest): URLSearchParams {
  return req.nextUrl.searchParams;
}
