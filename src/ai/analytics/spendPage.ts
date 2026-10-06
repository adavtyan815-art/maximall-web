import type { SpendEntry } from '../util/costLedger';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const usd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

/** Task 10: small Russian cost dashboard from the spend ledger (no secrets: provider, call, estimate, session). */
export function spendPageHtml(entries: SpendEntry[], totalUsd: number, capUsd: number, perSessionCapUsd: number, mock: Record<string, boolean>): string {
  const settled = entries.filter((e) => e.status !== 'reserved');
  const byProvider = new Map<string, { n: number; usd: number }>();
  const bySession = new Map<string, { n: number; usd: number }>();
  for (const e of settled) {
    const v = e.actualUsd ?? e.estUsd;
    const p = byProvider.get(e.provider) ?? { n: 0, usd: 0 };
    byProvider.set(e.provider, { n: p.n + 1, usd: p.usd + v });
    const k = e.sessionId ?? '—';
    const q = bySession.get(k) ?? { n: 0, usd: 0 };
    bySession.set(k, { n: q.n + 1, usd: q.usd + v });
  }
  const pct = Math.min(100, (100 * totalUsd) / (capUsd || 1));
  const rows = (m: Map<string, { n: number; usd: number }>) =>
    [...m.entries()]
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.n}</td><td class="n">${usd(v.usd)}</td></tr>`)
      .join('') || '<tr><td colspan="3" class="muted">платных вызовов не было</td></tr>';
  const last = settled
    .slice(-25)
    .reverse()
    .map((e) => `<tr><td>${esc(new Date(e.ts).toLocaleString('ru-RU'))}</td><td>${esc(e.provider)}</td><td>${esc(e.call)}</td><td>${esc(e.sessionId ?? '—')}</td><td class="n">${usd(e.actualUsd ?? e.estUsd)}</td><td>${e.status === 'settled' ? 'ok' : 'ошибка'}</td></tr>`)
    .join('') || '<tr><td colspan="6" class="muted">нет записей</td></tr>';
  const prov = Object.entries(mock).map(([k, v]) => `<span class="pill ${v ? 'mock' : 'live'}">${esc(k)}: ${v ? 'имитация' : 'платный'}</span>`).join(' ');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Расходы ИИ-консультанта</title>
<style>
:root{--bg:#fbfaf7;--fg:#222;--muted:#777;--card:#fff;--line:#e6e1d8;--accent:#8a6d45;--warn:#b8472e}
@media (prefers-color-scheme: dark){:root{--bg:#161513;--fg:#eee;--muted:#aaa;--card:#221f1b;--line:#3a352e;--accent:#d2b48c}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:960px;margin:0 auto}.card{background:var(--card);border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:22px;margin:0 0 12px}h2{font-size:16px;margin:0 0 10px}.big{font-size:30px;font-weight:700}
.bar{height:12px;background:var(--line);border-radius:6px;overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:${pct > 80 ? 'var(--warn)' : 'var(--accent)'};width:${pct.toFixed(1)}%}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}.n{text-align:right;white-space:nowrap}
.muted{color:var(--muted)}.pill{display:inline-block;padding:3px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line);margin:2px}.live{border-color:var(--warn)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.scroll{overflow-x:auto}
</style></head><body><div class="wrap">
<h1>Расходы на платные API</h1>
<div class="card"><div class="big">${usd(totalUsd)} <span class="muted" style="font-size:16px">из ${usd(capUsd)}</span></div>
<div class="bar"><i></i></div><p class="muted">Лимит на сессию: ${usd(perSessionCapUsd)}. Вызов, который превысит лимит, не выполняется. Страница обновляется каждые 30 с.</p>
<div>${prov}</div></div>
<div class="grid"><div class="card"><h2>По провайдерам</h2><table><tr><th>Провайдер</th><th class="n">Вызовов</th><th class="n">Сумма</th></tr>${rows(byProvider)}</table></div>
<div class="card"><h2>По сессиям</h2><table><tr><th>Сессия</th><th class="n">Вызовов</th><th class="n">Сумма</th></tr>${rows(bySession)}</table></div></div>
<div class="card scroll"><h2>Последние вызовы</h2><table><tr><th>Время</th><th>Провайдер</th><th>Вызов</th><th>Сессия</th><th class="n">Сумма</th><th>Статус</th></tr>${last}</table></div>
</div></body></html>`;
}
