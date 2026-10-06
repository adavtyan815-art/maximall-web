import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isAllowed, parseRobots, RobotsRules } from './robots';

export const SCRAPER_UA = 'MaxiMallCatalogBot/1.0 (+expo demo; 1 req/s; cached)';

export interface FetcherOptions {
  cacheDir: string;
  minIntervalMs?: number; // default 1000 (owner rule: at most 1 request per second)
  offline?: boolean; // only read the cache
  refresh?: boolean; // ignore cache entries (still writes them)
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export function cacheFileFor(cacheDir: string, url: string): string {
  const u = new URL(url);
  const slug = (u.pathname.replace(/^\/|\/$/g, '').replace(/[^a-zA-Z0-9-]+/g, '_') || 'root').slice(-90);
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  return path.join(cacheDir, 'pages', `${slug}__${h}.html`);
}

/** Polite, cached, robots-aware fetcher. One request in flight, >= minIntervalMs between network requests. */
export class PoliteFetcher {
  private last = 0;
  private robots: RobotsRules | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  public networkRequests = 0;
  public cacheHits = 0;
  constructor(private opts: FetcherOptions) {
    fs.mkdirSync(path.join(opts.cacheDir, 'pages'), { recursive: true });
  }

  private get interval() { return this.opts.minIntervalMs ?? 1000; }
  private log(m: string) { this.opts.log?.(m); }

  async loadRobots(origin: string): Promise<RobotsRules> {
    if (this.robots) return this.robots;
    const file = path.join(this.opts.cacheDir, 'robots.txt');
    let text: string | null = null;
    if (!this.opts.refresh && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    if (text === null && !this.opts.offline) {
      text = await this.networkGet(origin + '/robots.txt');
      fs.writeFileSync(file, text ?? '', 'utf8');
    }
    this.robots = parseRobots(text ?? '', SCRAPER_UA);
    return this.robots;
  }

  allowed(url: string): boolean {
    if (!this.robots) throw new Error('robots not loaded');
    const u = new URL(url);
    return isAllowed(this.robots, u.pathname + u.search);
  }

  private async networkGet(url: string): Promise<string | null> {
    const run = async () => {
      const wait = this.last + this.interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      this.networkRequests++;
      const f = this.opts.fetchImpl ?? fetch;
      const res = await f(url, { headers: { 'User-Agent': SCRAPER_UA, 'Accept-Language': 'ru' }, redirect: 'follow' });
      this.last = Date.now();
      if (!res.ok) {
        this.log(`HTTP ${res.status} ${url}`);
        return null;
      }
      return await res.text();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Returns HTML (from cache or network) or null when blocked by robots / HTTP error / offline miss. */
  async get(url: string): Promise<string | null> {
    const origin = new URL(url).origin;
    await this.loadRobots(origin);
    if (!this.allowed(url)) {
      this.log(`robots.txt disallows ${url}`);
      return null;
    }
    const file = cacheFileFor(this.opts.cacheDir, url);
    if (!this.opts.refresh && fs.existsSync(file)) {
      this.cacheHits++;
      return fs.readFileSync(file, 'utf8');
    }
    if (this.opts.offline) return null;
    const html = await this.networkGet(url);
    if (html !== null) {
      fs.writeFileSync(file, html, 'utf8');
      fs.appendFileSync(path.join(this.opts.cacheDir, 'index.tsv'), `${new Date().toISOString()}\t${url}\t${path.basename(file)}\n`);
    }
    return html;
  }
}
