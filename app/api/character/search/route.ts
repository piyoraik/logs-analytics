import { NextRequest } from 'next/server';
import {
  badRequest,
  getQuery,
  normalizeRegion,
  normalizeServerSlug,
  requestFFLogsGraphQL,
  serverSlugToName
} from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CharacterHit = {
  name: string;
  serverName: string;
  serverSlug: string;
};

function toTitleWords(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((w) => (w ? `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}` : w))
    .join(' ');
}

const FFLOGS_CHARACTER_EXISTS_QUERY_STRING = `
query CharacterExists($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
    }
  }
}`;

function buildFFLogsCharacterExistsQueryEnum(region: string) {
  return `
query CharacterExists($name: String!, $serverSlug: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: ${region}) {
      name
    }
  }
}`;
}

async function searchCharacterViaFFLogsExact(
  name: string,
  serverSlug: string,
  region: string
): Promise<{ hits: CharacterHit[]; errors: string[] }> {
  const errors: string[] = [];
  const nameVariants = [...new Set([name.trim(), toTitleWords(name), name.trim().toLowerCase()])].filter(Boolean);
  const serverVariants = [...new Set([serverSlug, normalizeServerSlug(serverSlugToName(serverSlug))])].filter(Boolean);
  const regionVariants = [...new Set([region.toUpperCase(), region.toLowerCase()])].filter(Boolean);

  for (const nv of nameVariants) {
    for (const sv of serverVariants) {
      for (const rv of regionVariants) {
        try {
          const data = await requestFFLogsGraphQL<any>(FFLOGS_CHARACTER_EXISTS_QUERY_STRING, {
            name: nv,
            serverSlug: sv,
            serverRegion: rv
          });
          const c = data?.characterData?.character;
          if (c?.name) {
            return {
              hits: [
                {
                  name: String(c.name),
                  serverName: serverSlugToName(sv),
                  serverSlug: sv
                }
              ],
              errors
            };
          }
        } catch (e) {
          errors.push(`string:${nv}/${sv}/${rv}:${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  for (const nv of nameVariants) {
    for (const sv of serverVariants) {
      try {
        const data = await requestFFLogsGraphQL<any>(buildFFLogsCharacterExistsQueryEnum(region.toUpperCase()), {
          name: nv,
          serverSlug: sv
        });
        const c = data?.characterData?.character;
        if (c?.name) {
          return {
            hits: [
              {
                name: String(c.name),
                serverName: serverSlugToName(sv),
                serverSlug: sv
              }
            ],
            errors
          };
        }
      } catch (e) {
        errors.push(`enum:${nv}/${sv}/${region}:${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { hits: [], errors };
}

async function searchCharactersViaXivApi(name: string, serverSlug: string, limit: number): Promise<CharacterHit[]> {
  const base = (process.env.XIVAPI_BASE_URL ?? 'https://xivapi.com').replace(/\/+$/, '');
  const baseCandidates = [...new Set([base, 'https://xivapi.com', 'https://v1.xivapi.com'])];
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const serverName = serverSlugToName(serverSlug);
  const serverCandidates = [...new Set([serverSlug, serverName, serverName.replace(/\s+/g, ''), ''].filter(Boolean))];
  const urls: string[] = [];
  for (const b of baseCandidates) {
    for (const server of serverCandidates) {
      urls.push(`${b}/character/search?name=${encodeURIComponent(name)}${server ? `&server=${encodeURIComponent(server)}` : ''}&limit=${safeLimit}`);
      urls.push(
        `${b}/api/search?indexes=Character&string=${encodeURIComponent(name)}${server ? `&filters=${encodeURIComponent(`Server=${server}`)}` : ''}&limit=${safeLimit}`
      );
    }
  }

  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const rows = Array.isArray(data?.Results)
      ? data.Results
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.Pagination?.Results)
          ? data.Pagination.Results
          : [];
    if (rows.length === 0) continue;
    return rows
      .map((x: any) => ({
        name: String(x?.Name ?? x?.name ?? '').trim(),
        serverName: String(x?.Server ?? x?.world ?? '').trim(),
        serverSlug: normalizeServerSlug(x?.Server ?? x?.world ?? serverSlug)
      }))
      .filter((x: CharacterHit) => x.name && x.serverSlug);
  }
  return [];
}

export async function GET(req: NextRequest) {
  try {
    const q = getQuery(req);
    const name = String(q.get('name') ?? '').trim();
    const region = normalizeRegion(q.get('region') ?? q.get('serverRegion'));
    const server = normalizeServerSlug(q.get('server') ?? q.get('serverSlug'));
    const limit = Math.max(1, Math.min(50, Number(q.get('limit') ?? '20')));
    if (!name || !region) {
      return badRequest('name and region are required');
    }

    const keyword = name.toLowerCase();
    const rows = await searchCharactersViaXivApi(name, server, limit * 3);
    const fallback = rows.length === 0 && server ? await searchCharacterViaFFLogsExact(name, server, region) : { hits: [], errors: [] };
    const fallbackRows = fallback.hits;
    const characters = rows
      .concat(fallbackRows)
      .filter((x: CharacterHit) => x.name.toLowerCase().includes(keyword))
      .filter((x: CharacterHit) => !server || x.serverSlug === server)
      .slice(0, limit)
      .map((x: CharacterHit) => ({
        name: x.name,
        serverName: x.serverName || serverSlugToName(x.serverSlug),
        serverSlug: x.serverSlug,
        region
      }));

    const debug = q.get('debug') === 'true';
    return Response.json(debug ? { characters, debug: { fallbackErrors: fallback.errors.slice(0, 8) } } : { characters });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
