'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

function parseSeedIds(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v, i, arr) => Number.isFinite(v) && v > 0 && arr.indexOf(v) === i);
}

function sanitizeXivApiBaseUrl(value) {
  const fallback = 'https://v2.xivapi.com';
  const raw = String(value ?? fallback).trim();
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    try {
      const u = new URL(`https://${raw.replace(/^\/+/, '')}`);
      return `${u.protocol}//${u.host}`;
    } catch {
      return fallback;
    }
  }
}

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
      if (c.includes('/api/asset?path=') || c.startsWith('api/asset?path=')) return c;
    }
    for (const c of candidates) {
      if (c.endsWith('.tex') || c.endsWith('.png')) return c;
    }
  }
  return undefined;
}

function decodeAssetPath(pathOrUrl) {
  if (!pathOrUrl) return undefined;
  const marker = 'api/asset?path=';
  const idx = pathOrUrl.indexOf(marker);
  if (idx < 0) return undefined;
  const raw = pathOrUrl.slice(idx + marker.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function buildAssetUrl(base, assetPath) {
  return `${base}/api/asset?path=${encodeURIComponent(assetPath)}&format=png`;
}

function toLegacyPngUrl(assetPath) {
  if (!assetPath || typeof assetPath !== 'string') return undefined;
  const normalized = assetPath.replace(/^\/+/, '');
  const m = normalized.match(/^ui\/icon\/(\d{6})\/(\d+)(?:_hr\d+)?\.(?:tex|png)$/i);
  if (!m) return undefined;
  return `https://xivapi.com/i/${m[1]}/${m[2]}.png`;
}

function toAbsoluteIconUrl(base, iconPathOrUrl) {
  if (!iconPathOrUrl) return undefined;
  const assetPath = decodeAssetPath(iconPathOrUrl);
  if (assetPath && assetPath.includes('ui/icon/')) {
    return toLegacyPngUrl(assetPath) ?? buildAssetUrl(base, assetPath);
  }
  if (/^https?:\/\//i.test(iconPathOrUrl)) {
    try {
      const u = new URL(iconPathOrUrl);
      if (u.pathname.includes('/api/asset')) {
        const p = u.searchParams.get('path');
        if (p && p.includes('ui/icon/')) {
          return toLegacyPngUrl(p) ?? buildAssetUrl(`${u.protocol}//${u.host}`, p);
        }
      }
      if (iconPathOrUrl.toLowerCase().endsWith('.tex')) {
        const p = u.pathname.replace(/^\/+/, '');
        return toLegacyPngUrl(p) ?? buildAssetUrl(`${u.protocol}//${u.host}`, p);
      }
      return iconPathOrUrl;
    } catch {
      return iconPathOrUrl;
    }
  }
  const normalized = iconPathOrUrl.trim();
  if (normalized === 'api/asset' || normalized === '/api/asset') {
    return undefined;
  }
  if (normalized.startsWith('api/asset?path=') || normalized.startsWith('/api/asset?path=')) {
    const ap = decodeAssetPath(normalized);
    if (!ap || !ap.includes('ui/icon/')) {
      return undefined;
    }
    return toLegacyPngUrl(ap) ?? buildAssetUrl(base, ap);
  }
  if (normalized.toLowerCase().endsWith('.tex')) {
    const assetPath = normalized.replace(/^\/+/, '');
    return toLegacyPngUrl(assetPath) ?? buildAssetUrl(base, assetPath);
  }
  return `${base}${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

function isValidIconUrl(iconUrl) {
  if (!iconUrl || typeof iconUrl !== 'string') return false;
  if (/^https:\/\/xivapi\.com\/i\/\d{6}\/\d+\.png$/i.test(iconUrl)) return true;
  if (!iconUrl.includes('/api/asset?path=')) return false;
  const m = iconUrl.match(/[?&]path=([^&]+)/);
  if (!m?.[1]) return false;
  try {
    const p = decodeURIComponent(m[1]);
    return p.includes('ui/icon/');
  } catch {
    return false;
  }
}

async function fetchActionById(id, baseUrl, lang) {
  const base = sanitizeXivApiBaseUrl(baseUrl).replace(/\/+$/, '');
  const candidates = [base];
  if (base.includes('xivapi.com') && !base.includes('v2.xivapi.com')) {
    candidates.unshift('https://v2.xivapi.com');
  }

  let lastStatus = 0;
  for (const b of candidates) {
    const urls = [
      `${b}/api/sheet/Action/${id}?fields=Name,Icon&language=${encodeURIComponent(lang)}`,
      `${b}/Action/${id}?language=${encodeURIComponent(lang)}`
    ];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) {
        lastStatus = res.status;
        continue;
      }
      const data = await res.json();
      const fields = data?.fields ?? data;
      const name = typeof fields?.Name === 'string' ? fields.Name.trim() : '';
      const icon = extractIconPath(fields?.Icon);
      return {
        id,
        name: name || undefined,
        iconUrl: toAbsoluteIconUrl(b, icon)
      };
    }
  }
  throw new Error(`XIVAPI request failed for ${id}: ${lastStatus || 'unknown'}`);
}

async function fetchActionPage(baseUrl, lang, after, limit) {
  const base = sanitizeXivApiBaseUrl(baseUrl).replace(/\/+$/, '');
  const candidates = [base];
  if (base.includes('xivapi.com') && !base.includes('v2.xivapi.com')) {
    candidates.unshift('https://v2.xivapi.com');
  }

  let lastStatus = 0;
  for (const b of candidates) {
    const url = `${b}/api/sheet/Action?language=${encodeURIComponent(lang)}&fields=Name,Icon&after=${after}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      lastStatus = res.status;
      continue;
    }
    const json = await res.json();
    const rows = Array.isArray(json?.rows) ? json.rows : [];
    const normalized = rows
      .map((r) => {
        const id = Number(r?.row_id ?? r?.rowId ?? r?.id);
        const fields = r?.fields ?? {};
        const name = typeof fields?.Name === 'string' ? fields.Name.trim() : '';
        const icon = extractIconPath(fields?.Icon);
        return {
          id,
          name: name || undefined,
          icon: icon ? toAbsoluteIconUrl(b, icon) : undefined
        };
      })
      .filter((x) => Number.isFinite(x.id) && x.id > 0);
    return normalized;
  }
  throw new Error(`XIVAPI sheet request failed: ${lastStatus || 'unknown'}`);
}

function toItem(id, action, lang, baseUrl, now) {
  const iconUrl = action.iconUrl ?? toAbsoluteIconUrl(baseUrl.replace(/\/+$/, ''), action.icon);
  return {
    abilityId: id,
    nameJa: lang === 'ja' ? action.name : undefined,
    nameEn: lang === 'en' ? action.name : undefined,
    iconUrl,
    updatedAt: now
  };
}

exports.handler = async (event, context) => {
  const table = process.env.ABILITY_MASTER_TABLE;
  const baseUrl = sanitizeXivApiBaseUrl(process.env.XIVAPI_BASE_URL ?? 'https://v2.xivapi.com');
  const lang = process.env.XIVAPI_LANG ?? 'ja';
  const seedIds = parseSeedIds(process.env.ABILITY_SEED_IDS ?? '');
  const pageLimitEnv = Number(process.env.ABILITY_SYNC_PAGE_LIMIT ?? '500');
  const eventPageLimit = Number(event?.pageLimit ?? '');
  const pageLimitBase = Number.isFinite(eventPageLimit) ? eventPageLimit : pageLimitEnv;
  const pageLimit = Number.isFinite(pageLimitBase) ? Math.max(50, Math.min(1000, pageLimitBase)) : 500;
  const maxPagesEnv = Number(process.env.ABILITY_SYNC_MAX_PAGES ?? '200');
  const eventMaxPages = Number(event?.maxPages ?? '');
  const maxPagesBase = Number.isFinite(eventMaxPages) ? eventMaxPages : maxPagesEnv;
  const maxPages = Number.isFinite(maxPagesBase) ? Math.max(1, maxPagesBase) : 200;
  if (!table) {
    throw new Error('ABILITY_MASTER_TABLE is not set.');
  }

  let updated = 0;
  let skipped = 0;
  const now = Date.now();

  if (seedIds.length > 0) {
    for (const id of seedIds) {
      try {
        const action = await fetchActionById(id, baseUrl, lang);
        if (!action.name || !isValidIconUrl(action.iconUrl)) {
          skipped += 1;
          continue;
        }
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              abilityId: id,
              nameJa: lang === 'ja' ? action.name : undefined,
              nameEn: lang === 'en' ? action.name : undefined,
              iconUrl: action.iconUrl,
              updatedAt: now
            }
          })
        );
        updated += 1;
      } catch {
        skipped += 1;
      }
    }
    return { mode: 'seed', updated, skipped, seedSize: seedIds.length };
  }

  let after = Number(event?.after ?? '0');
  if (!Number.isFinite(after) || after < 0) {
    after = 0;
  }

  let page = 0;
  while (page < maxPages) {
    if (typeof context?.getRemainingTimeInMillis === 'function' && context.getRemainingTimeInMillis() < 10_000) {
      return {
        mode: 'full',
        updated,
        skipped,
        nextAfter: after,
        partial: true,
        reason: 'time_limit_near'
      };
    }

    let rows;
    try {
      rows = await fetchActionPage(baseUrl, lang, after, pageLimit);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('XIVAPI sheet request failed: 404')) {
        return {
          mode: 'full',
          updated,
          skipped,
          nextAfter: after,
          partial: true,
          reason: 'sheet_not_available',
          detail: msg
        };
      }
      throw e;
    }
    if (rows.length === 0) {
      return {
        mode: 'full',
        updated,
        skipped,
        nextAfter: null,
        partial: false,
        reason: 'completed'
      };
    }

    for (const row of rows) {
      after = Math.max(after, row.id);
      if (!row.name) {
        skipped += 1;
        continue;
      }
      let rowWithIcon = row;
      if (!rowWithIcon.icon) {
        try {
          const detail = await fetchActionById(row.id, baseUrl, lang);
          rowWithIcon = {
            ...rowWithIcon,
            name: rowWithIcon.name ?? detail.name,
            iconUrl: detail.iconUrl
          };
        } catch {
          // ignore and let it be skipped below
        }
      }
      if (!(rowWithIcon.icon || rowWithIcon.iconUrl)) {
        skipped += 1;
        continue;
      }
      const candidateIcon = rowWithIcon.iconUrl ?? rowWithIcon.icon;
      if (!isValidIconUrl(candidateIcon)) {
        skipped += 1;
        continue;
      }
      try {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: toItem(row.id, rowWithIcon, lang, baseUrl, now)
          })
        );
        updated += 1;
      } catch {
        skipped += 1;
      }
    }
    page += 1;
  }

  return {
    mode: 'full',
    updated,
    skipped,
    nextAfter: after,
    partial: true,
    reason: 'max_pages_reached'
  };
};
