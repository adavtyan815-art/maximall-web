import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/** Provider keys the AI layer understands. Values are never logged. */
export const PROVIDER_ENV_VARS = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY'] as const;
export type ProviderEnvVar = (typeof PROVIDER_ENV_VARS)[number];

function readWindowsUserEnv(name: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * For each provider key missing from process.env, look in the Windows User scope. When found there,
 * put it into process.env and persist it into the untracked `.env` (gitignored). Returns only which
 * keys are present (booleans), never their values.
 */
export function hydrateProviderKeys(opts: { envFile?: string; skipWindows?: boolean } = {}): Record<ProviderEnvVar, boolean> {
  const envFile = opts.envFile ?? path.join(process.cwd(), '.env');
  const present = {} as Record<ProviderEnvVar, boolean>;
  for (const name of PROVIDER_ENV_VARS) {
    if (!process.env[name] && !opts.skipWindows && process.env.AI_SKIP_WINDOWS_ENV !== '1') {
      const v = readWindowsUserEnv(name);
      if (v) {
        process.env[name] = v;
        try {
          const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
          if (!new RegExp(`^${name}=`, 'm').test(existing)) {
            fs.appendFileSync(envFile, `${existing && !existing.endsWith('\n') ? '\n' : ''}${name}=${v}\n`, 'utf8');
          }
        } catch {
          /* .env write failure is non-fatal */
        }
      }
    }
    present[name] = !!process.env[name];
  }
  return present;
}

export function flag(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === '1' || v.toLowerCase() === 'true';
}
