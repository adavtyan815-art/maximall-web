import crypto from 'crypto';
import bcrypt from 'bcrypt';

/**
 * Admin login check (fail closed).
 * - ADMIN_PASSWORD_HASH empty -> every admin login is refused (unless LOCAL_MODE=1 and an untracked .env sets
 *   LOCAL_ADMIN_PASSWORD, used for local QA only; there is no code default).
 * - ADMIN_PASSWORD_HASH looks like bcrypt ($2a$/$2b$/$2y$) -> bcrypt.compare.
 * - otherwise the value is treated as a plaintext password (legacy env form) and compared in constant time.
 */
export interface AdminAuthConfig {
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH: string;
  LOCAL_MODE?: boolean;
  LOCAL_ADMIN_PASSWORD?: string;
}

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Constant-time string equality (hash both sides to equal-length digests first). */
export function safeEqual(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

export function adminAuthMode(cfg: AdminAuthConfig): 'disabled' | 'bcrypt' | 'plaintext' | 'local' {
  const stored = cfg.ADMIN_PASSWORD_HASH ?? '';
  if (stored) return BCRYPT_RE.test(stored) ? 'bcrypt' : 'plaintext';
  if (cfg.LOCAL_MODE && cfg.LOCAL_ADMIN_PASSWORD) return 'local';
  return 'disabled';
}

export async function verifyAdminLogin(username: unknown, password: unknown, cfg: AdminAuthConfig): Promise<boolean> {
  if (typeof username !== 'string' || typeof password !== 'string' || !password) return false;
  const userOk = safeEqual(username, cfg.ADMIN_USERNAME ?? '');
  const mode = adminAuthMode(cfg);
  let passOk = false;
  if (mode === 'bcrypt') {
    try {
      passOk = await bcrypt.compare(password, cfg.ADMIN_PASSWORD_HASH);
    } catch {
      passOk = false;
    }
  } else if (mode === 'plaintext') passOk = safeEqual(password, cfg.ADMIN_PASSWORD_HASH);
  else if (mode === 'local') passOk = safeEqual(password, cfg.LOCAL_ADMIN_PASSWORD!);
  return userOk && passOk;
}
