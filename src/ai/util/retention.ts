import fs from 'fs';
import path from 'path';

/**
 * QA-058: runtime data retention. Deletes files older than a per-folder age inside the AI runtime data folders only.
 * Never touches leads.jsonl, the spend ledger, dossier/render index files, catalog data or UE saves; never follows
 * symlinks; refuses any folder outside the allowed roots. Dry run logs what would be deleted.
 */
export interface RetentionTarget {
  name: string;
  dir: string;
  /** <= 0 or NaN: this target is skipped. */
  maxAgeDays: number;
}
export interface RetentionResult {
  name: string;
  dir: string;
  files: number;
  bytes: number;
  dirsRemoved: number;
  dryRun: boolean;
  skipped?: string;
}

/** Files that are never deleted, wherever they are. */
const PROTECTED_FILE = /^(leads\.jsonl|api_spend\.jsonl|index\.json|index\.tsv|scraped_products\.json)$/i;
/** Folders that are never entered or used as a target. */
const PROTECTED_DIR = /^(catalog|saves|reports|reports-out|runtime)$/i;

const DAY = 24 * 3600 * 1000;

function inside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Why a target folder is refused, or null. */
export function refuseReason(dir: string, allowedRoots: string[]): string | null {
  const abs = path.resolve(dir);
  if (path.parse(abs).root === abs) return 'filesystem root';
  if (abs.split(/[\\/]/).some((seg) => PROTECTED_DIR.test(seg))) return 'protected folder (catalog / saves / reports / runtime)';
  if (!allowedRoots.some((r) => inside(abs, path.resolve(r)))) return 'outside the configured data folders';
  return null;
}

export function runRetention(
  targets: RetentionTarget[],
  opts: { allowedRoots: string[]; now?: number; dryRun?: boolean; log?: (msg: string) => void },
): RetentionResult[] {
  const now = opts.now ?? Date.now();
  const log = opts.log ?? ((m: string) => console.log(m));
  const out: RetentionResult[] = [];
  for (const t of targets) {
    const res: RetentionResult = { name: t.name, dir: t.dir, files: 0, bytes: 0, dirsRemoved: 0, dryRun: !!opts.dryRun };
    out.push(res);
    if (!(t.maxAgeDays > 0)) {
      res.skipped = 'disabled';
      continue;
    }
    const why = refuseReason(t.dir, opts.allowedRoots);
    if (why) {
      res.skipped = `refused: ${why}`;
      log(`[Retention] ${t.name}: REFUSED ${t.dir} (${why})`);
      continue;
    }
    if (!fs.existsSync(t.dir)) {
      res.skipped = 'missing';
      continue;
    }
    const root = path.resolve(t.dir);
    const cutoff = now - t.maxAgeDays * DAY;
    const walk = (dir: string): boolean => {
      // returns true when the folder is (or would be) empty afterwards
      let empty = true;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          empty = false; // never followed, never deleted
          continue;
        }
        if (e.isDirectory()) {
          if (PROTECTED_DIR.test(e.name)) {
            empty = false;
            continue;
          }
          if (walk(p)) {
            if (!opts.dryRun) {
              try {
                fs.rmdirSync(p); // empty folders only (a render's folder after its files expired)
                res.dirsRemoved++;
              } catch {
                empty = false;
              }
            } else res.dirsRemoved++;
          } else empty = false;
          continue;
        }
        if (!e.isFile() || PROTECTED_FILE.test(e.name)) {
          empty = false;
          continue;
        }
        let st: fs.Stats;
        try {
          st = fs.lstatSync(p);
        } catch {
          empty = false;
          continue;
        }
        if (st.mtimeMs >= cutoff) {
          empty = false;
          continue;
        }
        if (!inside(p, root)) {
          empty = false;
          continue;
        }
        if (opts.dryRun) {
          log(`[Retention] DRY RUN ${t.name}: would delete ${path.relative(root, p)} (${st.size} B, ${new Date(st.mtimeMs).toISOString()})`);
        } else {
          try {
            fs.unlinkSync(p);
          } catch {
            empty = false;
            continue;
          }
        }
        res.files++;
        res.bytes += st.size;
      }
      return empty;
    };
    walk(root);
    log(`[Retention] ${t.name}: ${opts.dryRun ? 'would delete' : 'deleted'} ${res.files} files, ${(res.bytes / 1048576).toFixed(1)} MB, ${res.dirsRemoved} empty folders (older than ${t.maxAgeDays} d, ${t.dir})`);
  }
  return out;
}

/** Ages from the environment (QA-058 defaults). */
export function retentionAgesFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const days = (name: string, dflt: number) => {
    const v = env[name];
    if (v === undefined || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    renders: days('AI_RETENTION_RENDERS_DAYS', 7),
    clips: days('AI_RETENTION_CLIPS_DAYS', 1),
    dossiers: days('AI_RETENTION_DOSSIERS_DAYS', 30),
    logs: days('AI_RETENTION_LOGS_DAYS', 30),
    ar: days('AI_RETENTION_AR_DAYS', 30),
  };
}
