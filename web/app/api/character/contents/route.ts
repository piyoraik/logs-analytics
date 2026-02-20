import { NextRequest } from 'next/server';
import {
  badRequest,
  extractCharacterContents,
  getQuery,
  normalizeRegion,
  normalizeServerSlug,
  requestFFLogsGraphQL
} from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildCharacterContentsQueryString(includeRecentReports: boolean) {
  return `
query CharacterContents($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      zoneRankings(size: 100, metric: dps, includePrivateLogs: true)
      ${
        includeRecentReports
          ? `recentReports(limit: 30) {
        data {
          code
          title
          startTime
        }
      }`
          : ''
      }
    }
  }
}`;
}

function buildCharacterContentsQueryEnum(region: string, includeRecentReports: boolean) {
  return `
query CharacterContents($name: String!, $serverSlug: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: ${region}) {
      name
      zoneRankings(size: 100, metric: dps, includePrivateLogs: true)
      ${
        includeRecentReports
          ? `recentReports(limit: 30) {
        data {
          code
          title
          startTime
        }
      }`
          : ''
      }
    }
  }
}`;
}

export async function GET(req: NextRequest) {
  try {
    const q = getQuery(req);
    const name = String(q.get('name') ?? '').trim();
    const serverSlug = normalizeServerSlug(q.get('server') ?? q.get('serverSlug'));
    const serverRegion = normalizeRegion(q.get('region') ?? q.get('serverRegion'));
    if (!name || !serverSlug || !serverRegion) {
      return badRequest('name, server, region are required');
    }

    const debugMode = q.get('debug') === 'true';
    let data: any;
    const debug: Record<string, unknown> = {};
    try {
      data = await requestFFLogsGraphQL<any>(buildCharacterContentsQueryString(true), {
        name,
        serverSlug,
        serverRegion
      });
      debug.path = 'string+reports';
    } catch {
      try {
        data = await requestFFLogsGraphQL<any>(buildCharacterContentsQueryEnum(serverRegion, true), {
          name,
          serverSlug
        });
        debug.path = 'enum+reports';
      } catch {
        data = await requestFFLogsGraphQL<any>(buildCharacterContentsQueryString(false), {
          name,
          serverSlug,
          serverRegion
        });
        debug.path = 'string-no-reports';
      }
    }

    const character = data?.characterData?.character;
    if (!character) {
      return Response.json({ character: null, contents: [], reports: [] });
    }

    const contents = extractCharacterContents(character.zoneRankings);
    const reports = Array.isArray(character.recentReports?.data)
      ? character.recentReports.data
          .map((x: any) => ({ code: x?.code, title: x?.title, startTime: x?.startTime }))
          .filter((x: any) => typeof x.code === 'string' && x.code.trim())
      : [];

    const response = {
      character: {
        name: character.name ?? name,
        serverSlug,
        serverRegion
      },
      contents,
      reports
    } as Record<string, unknown>;
    if (debugMode) {
      response.debug = {
        ...debug,
        zoneRankingsType: typeof character.zoneRankings,
        zoneRankingsKeys:
          character.zoneRankings && typeof character.zoneRankings === 'object'
            ? Object.keys(character.zoneRankings).slice(0, 30)
            : [],
        reportsCount: reports.length,
        contentsCount: contents.length
      };
    }
    return Response.json(response);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
