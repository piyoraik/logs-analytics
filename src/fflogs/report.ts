import {
  REPORT_CASTS_QUERY,
  REPORT_CASTS_QUERY_TRANSLATED,
  REPORT_FIGHTS_QUERY,
  REPORT_FIGHTS_QUERY_TRANSLATED,
  REPORT_MASTER_DATA_QUERY,
  REPORT_MASTER_DATA_QUERY_TRANSLATED
} from './queries';
import {
  Actor,
  AbilityDef,
  ActorMap,
  CastEvent,
  EventsPage,
  Fight,
  ReportFightsResult
} from './types';
import { FFLogsGraphQLClient } from './client';

interface FightsQueryData {
  reportData: {
    report: {
      code: string;
      fights: Fight[];
    } | null;
  };
}

interface MasterDataQueryData {
  reportData: {
    report: {
      masterData: {
        actors: Actor[];
        abilities?: AbilityDef[];
      };
    } | null;
  };
}

interface CastsQueryData {
  reportData: {
    report: {
      events: EventsPage;
    } | null;
  };
}

function isTranslateUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Unknown argument "translate"') || message.includes("Unknown argument 'translate'");
}

async function requestWithTranslateFallback<T>(
  client: FFLogsGraphQLClient,
  translatedQuery: string,
  plainQuery: string,
  variables: Record<string, unknown>,
  translate: boolean
): Promise<T> {
  if (!translate) {
    return client.request<T>(plainQuery, variables);
  }

  try {
    return await client.request<T>(translatedQuery, { ...variables, translate: true });
  } catch (error) {
    if (!isTranslateUnsupportedError(error)) {
      throw error;
    }
    return client.request<T>(plainQuery, variables);
  }
}

export async function getReportFights(
  client: FFLogsGraphQLClient,
  reportCode: string,
  options?: { translate?: boolean }
): Promise<ReportFightsResult> {
  const data = await requestWithTranslateFallback<FightsQueryData>(
    client,
    REPORT_FIGHTS_QUERY_TRANSLATED,
    REPORT_FIGHTS_QUERY,
    { code: reportCode },
    options?.translate ?? false
  );
  const report = data.reportData.report;
  if (!report) {
    throw new Error(`Report not found or inaccessible: ${reportCode}`);
  }
  return {
    reportCode: report.code,
    fights: report.fights ?? []
  };
}

export async function getReportActorMap(
  client: FFLogsGraphQLClient,
  reportCode: string,
  options?: { translate?: boolean }
): Promise<ActorMap> {
  const data = await requestWithTranslateFallback<MasterDataQueryData>(
    client,
    REPORT_MASTER_DATA_QUERY_TRANSLATED,
    REPORT_MASTER_DATA_QUERY,
    { code: reportCode },
    options?.translate ?? false
  );
  const report = data.reportData.report;
  if (!report) {
    throw new Error(`Cannot fetch masterData for report: ${reportCode}`);
  }

  const byId = new Map<number, Actor>();
  for (const actor of report.masterData.actors ?? []) {
    byId.set(actor.id, actor);
  }

  const abilityByGameId = new Map<number, string>();
  for (const ability of report.masterData.abilities ?? []) {
    if (!ability?.name || typeof ability.gameID !== 'number') {
      continue;
    }
    abilityByGameId.set(ability.gameID, ability.name);
  }

  return { byId, abilityByGameId };
}

export interface GetCastEventsParams {
  reportCode: string;
  fightID: number;
  startTime: number;
  endTime: number;
  limit?: number;
  dataType?: string;
  translate?: boolean;
}

export async function getAllEvents(
  client: FFLogsGraphQLClient,
  params: GetCastEventsParams
): Promise<CastEvent[]> {
  const all: CastEvent[] = [];
  const limit = params.limit ?? 10_000;
  let cursor = params.startTime;
  const dataType = params.dataType ?? 'Casts';

  for (;;) {
    const data = await requestWithTranslateFallback<CastsQueryData>(
      client,
      REPORT_CASTS_QUERY_TRANSLATED,
      REPORT_CASTS_QUERY,
      {
        code: params.reportCode,
        fightIDs: [params.fightID],
        startTime: cursor,
        endTime: params.endTime,
        limit,
        dataType
      },
      params.translate ?? false
    );

    const events = data.reportData.report?.events;
    if (!events) {
      throw new Error(
        `events query returned null. report=${params.reportCode}, fightID=${params.fightID}`
      );
    }

    all.push(...(events.data ?? []));

    if (!events.nextPageTimestamp || events.nextPageTimestamp <= cursor) {
      break;
    }
    cursor = events.nextPageTimestamp;
  }

  return all;
}

export async function getAllCastEvents(
  client: FFLogsGraphQLClient,
  params: GetCastEventsParams
): Promise<CastEvent[]> {
  return getAllEvents(client, { ...params, dataType: 'Casts' });
}
