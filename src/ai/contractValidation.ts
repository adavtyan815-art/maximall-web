import fs from 'fs';
import path from 'path';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * QA-059: incoming /ai payloads are validated against contracts/socket-events.schema.json (x-client-to-server).
 * The contracts folder sits next to src/ and dist/ (repo root, /app in the image), so the same relative path works for both.
 */
export const CONTRACTS_DIR = process.env.AI_CONTRACTS_DIR ?? path.join(__dirname, '..', '..', 'contracts');

export const BAD_PAYLOAD_RU = 'Некорректный запрос — обновите страницу, пожалуйста.';

let validators: Map<string, ValidateFunction> | null = null;

function load(): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  addFormats(ajv);
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, f), 'utf8'));
  for (const f of fs.readdirSync(CONTRACTS_DIR).filter((x) => x.endsWith('.schema.json'))) ajv.addSchema(read(f));
  const socket = read('socket-events.schema.json');
  // x- sections are not schema keywords: lift them into a derived schema so their $refs resolve.
  const derived: any = { $id: 'maximall/ai/_incoming.json', $defs: {} };
  for (const [k, v] of Object.entries<any>(socket['x-client-to-server'] ?? {})) derived.$defs[k] = v;
  ajv.addSchema(derived);
  const m = new Map<string, ValidateFunction>();
  for (const k of Object.keys(derived.$defs)) {
    if (k === 'ai.audio.chunk') continue; // binary, checked by the handler (type + 32 KB)
    const v = ajv.getSchema(`maximall/ai/_incoming.json#/$defs/${k}`);
    if (v) m.set(k, v);
  }
  return m;
}

/** Known client->server events (from the contract) plus the binary audio chunk. */
export function knownClientEvents(): Set<string> {
  if (!validators) validators = load();
  return new Set([...validators.keys(), 'ai.audio.chunk']);
}

/** null when valid, else a short reason (for logs; the visitor gets BAD_PAYLOAD_RU). */
export function checkClientPayload(event: string, payload: unknown): string | null {
  if (!validators) validators = load();
  const v = validators.get(event);
  if (!v) return event === 'ai.audio.chunk' ? null : `unknown event ${event}`;
  if (v(payload)) return null;
  const e = v.errors?.[0];
  return `${e?.instancePath || '/'} ${e?.message ?? 'invalid'}`.slice(0, 200);
}
