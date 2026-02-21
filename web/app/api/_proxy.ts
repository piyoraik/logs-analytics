import { NextRequest } from 'next/server';

function getApiBaseUrl(): string {
  const base = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set for proxy API routes.');
  }
  return base;
}

export async function proxyGet(req: NextRequest, upstreamPath: string): Promise<Response> {
  try {
    const base = getApiBaseUrl();
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

