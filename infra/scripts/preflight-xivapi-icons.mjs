#!/usr/bin/env node

const base = (process.env.XIVAPI_BASE_URL || 'https://v2.xivapi.com').replace(/\/+$/, '');
const lang = process.env.XIVAPI_LANG || 'ja';

function extractIconPath(value) {
  if (!value) return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'object') {
    const candidates = [
      value.path_hr1,
      value.path_hr2,
      value.path,
      value.Path,
      value.href,
      value.Href,
      value.url,
      value.Url,
      value.icon,
      value.Icon
    ]
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const c of candidates) {
      if (c.includes('ui/icon/')) return c;
    }
    for (const c of candidates) {
      if (c.endsWith('.tex') || c.endsWith('.png')) return c;
    }
  }
  return undefined;
}

function toAssetUrl(pathOrUrl) {
  if (!pathOrUrl) return undefined;
  const normalized = pathOrUrl.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+/, '');
  const m = normalized.match(/^ui\/icon\/(\d{6})\/(\d+)(?:_hr\d+)?\.(?:tex|png)$/i);
  if (m) {
    return `https://xivapi.com/i/${m[1]}/${m[2]}.png`;
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const u = new URL(pathOrUrl);
    if (u.pathname.includes('/api/asset') && u.searchParams.get('path')) {
      const p = u.searchParams.get('path');
      const pm = p.match(/^ui\/icon\/(\d{6})\/(\d+)(?:_hr\d+)?\.(?:tex|png)$/i);
      if (pm) return `https://xivapi.com/i/${pm[1]}/${pm[2]}.png`;
      return `${u.origin}/api/asset?path=${encodeURIComponent(p)}&format=png`;
    }
    const p = u.pathname.replace(/^\/+/, '');
    const pm = p.match(/^ui\/icon\/(\d{6})\/(\d+)(?:_hr\d+)?\.(?:tex|png)$/i);
    if (pm) return `https://xivapi.com/i/${pm[1]}/${pm[2]}.png`;
    return `${u.origin}/api/asset?path=${encodeURIComponent(p)}&format=png`;
  }
  const p = pathOrUrl.replace(/^\/+/, '');
  return `${base}/api/asset?path=${encodeURIComponent(p)}&format=png`;
}

async function run() {
  const sheetUrl =
    `${base}/api/sheet/Action` +
    `?language=${encodeURIComponent(lang)}` +
    `&fields=Name,Icon` +
    `&after=0&limit=10`;

  const res = await fetch(sheetUrl);
  if (!res.ok) {
    throw new Error(`sheet request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  if (rows.length === 0) {
    throw new Error('no rows returned from XIVAPI sheet');
  }

  let checked = 0;
  for (const row of rows) {
    const id = Number(row?.row_id ?? row?.id);
    const fields = row?.fields ?? {};
    const name = typeof fields?.Name === 'string' ? fields.Name : '(no-name)';
    const iconPath = extractIconPath(fields?.Icon);
    if (!iconPath) continue;
    const iconUrl = toAssetUrl(iconPath);
    if (!iconUrl) continue;
    const r = await fetch(iconUrl, { method: 'GET' });
    console.log(JSON.stringify({ id, name, iconPath, iconUrl, status: r.status }));
    checked += 1;
    if (checked >= 5) break;
  }

  if (checked === 0) {
    throw new Error('no icon candidates were found in sampled rows');
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
