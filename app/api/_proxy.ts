import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

function cleanBase(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

async function getApiBaseUrl(): Promise<string> {
  const explicit = cleanBase(process.env.NEXT_PUBLIC_API_BASE_URL) || cleanBase(process.env.API_BASE_URL);
  if (explicit) {
    return explicit;
  }

  try {
    const file = path.join(process.cwd(), 'amplify_outputs.json');
    const text = await readFile(file, 'utf-8');
    const json = JSON.parse(text) as Record<string, unknown>;
    const custom = (json.custom ?? {}) as Record<string, unknown>;
    const apiDirect = cleanBase(typeof custom.apiBaseUrl === 'string' ? custom.apiBaseUrl : undefined);
    if (apiDirect) {
      return apiDirect;
    }
    const apiObject = (custom.api ?? {}) as Record<string, unknown>;
    const nested = cleanBase(typeof apiObject.baseUrl === 'string' ? apiObject.baseUrl : undefined);
    if (nested) {
      return nested;
    }
  } catch {
    // fall through to throw below
  }

  throw new Error('API base URL is not configured. Set NEXT_PUBLIC_API_BASE_URL or generate amplify_outputs.json.');
}

export async function proxyGet(req: NextRequest, upstreamPath: string): Promise<Response> {
  try {
    const base = await getApiBaseUrl();
    const query = req.nextUrl.searchParams.toString();
    const url = query ? `${base}${upstreamPath}?${query}` : `${base}${upstreamPath}`;
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store'
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
