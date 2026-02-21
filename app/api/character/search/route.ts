import { NextRequest } from 'next/server';
import { proxyGet } from '../../_proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return proxyGet(req, '/character/search');
}
