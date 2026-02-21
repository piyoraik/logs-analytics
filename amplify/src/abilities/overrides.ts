import { readFile } from 'node:fs/promises';

export async function loadAbilityOverrides(path: string): Promise<Map<number, string>> {
  try {
    const raw = await readFile(path, 'utf-8');
    const json = JSON.parse(raw) as Record<string, string>;
    const map = new Map<number, string>();
    for (const [k, v] of Object.entries(json)) {
      const id = Number(k);
      if (!Number.isFinite(id) || typeof v !== 'string' || !v.trim()) {
        continue;
      }
      map.set(id, v.trim());
    }
    return map;
  } catch {
    return new Map<number, string>();
  }
}
