import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dataDir = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data'));
export function recordsFor(group) {
  if (typeof group !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(group)) throw new Error('Недопустимый group_id');
  const filename = path.join(dataDir, `${group}.json`);
  if (!fs.existsSync(filename)) throw new Error(`Нет локального набора data/${group}.json. Загрузите снапшот организаторов.`);
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const records = raw?.data?.records || raw?.records || raw;
  if (!Array.isArray(records)) throw new Error('Неверный формат набора');
  return records;
}
