import fs from 'fs';
import path from 'path';

/**
 * Task 9: analytics from the per-session command logs (data/ai_logs/<session>.jsonl) and the dossier leads.
 * Per session: turns, proposals, cards shown, taps, applied sets, kept sets (last basket), exports (dossiers), photos,
 * scripted fallbacks, guardrail hits. Totals, a funnel and top configurations for the post-Expo report for the brand.
 */
export interface SessionAnalytics {
  sessionId: string;
  username: string;
  startedAt?: string;
  endedAt?: string;
  turns: number;
  voiceTurns: number;
  proposals: number;
  cardsShown: number;
  taps: number;
  applied: number;
  kept: { title: string; price: number }[];
  /** basket = last basket snapshot; applied = derived from applied sets (older logs). */
  keptSource?: 'basket' | 'applied';
  keptTotal: number;
  exports: number;
  photos: number;
  fallbacks: number;
  guardrailHits: number;
  budgets: number[];
  proposed: string[];
  tapped: string[];
}

const readJsonl = (f: string): any[] =>
  fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

export function analyseSession(file: string): SessionAnalytics {
  const ev = readJsonl(file);
  const sessionId = decodeURIComponent(path.basename(file, '.jsonl'));
  const a: SessionAnalytics = { sessionId, username: sessionId.split(/[:_]/).slice(1).join(':') || sessionId, turns: 0, voiceTurns: 0, proposals: 0, cardsShown: 0, taps: 0, applied: 0, kept: [], keptTotal: 0, exports: 0, photos: 0, fallbacks: 0, guardrailHits: 0, budgets: [], proposed: [], tapped: [] };
  const cardTitle = new Map<string, string>();
  for (const e of ev) {
    if (e.sid) a.sessionId = e.sid;
    if (e.user) a.username = e.user;
    a.startedAt ??= e.ts;
    a.endedAt = e.ts;
    switch (e.type) {
      case 'turn':
        a.turns++;
        if (e.source === 'voice') a.voiceTurns++;
        break;
      case 'cards':
        a.proposals++;
        a.cardsShown += e.cards?.length ?? 0;
        if (typeof e.args?.budgetBYN === 'number') a.budgets.push(e.args.budgetBYN);
        for (const c of e.cards ?? []) {
          cardTitle.set(c.cardId, c.title);
          a.proposed.push(c.title);
        }
        break;
      case 'card_tap':
        a.taps++;
        if (e.ok !== false) {
          a.applied++;
          a.tapped.push(cardTitle.get(e.cardId) ?? e.cardId);
        }
        break;
      case 'tool':
        if (e.name === 'apply_card' && e.ok) {
          a.applied++;
          const t = (e.say as string | undefined)?.match(/Поставила (.+?) —/)?.[1];
          if (t) a.tapped.push(t);
        }
        break;
      case 'basket':
        a.kept = (e.items ?? []).map((i: any) => ({ title: i.title, price: i.price }));
        a.keptTotal = e.total ?? 0;
        break;
      case 'dossier':
        a.exports++;
        break;
      case 'render':
        if (e.stage === 'final') a.photos++;
        break;
      case 'llm_error':
        a.fallbacks++;
        break;
      case 'guardrail':
        a.guardrailHits++;
        break;
    }
  }
  // QA-021: logs written before basket snapshots existed (or sessions whose basket was never emitted) — the sets the
  // visitor applied count as kept (price unknown -> 0; the dossier/lead record holds the real total).
  if (!ev.some((e) => e.type === 'basket') && a.tapped.length) {
    a.kept = [...new Set(a.tapped)].map((title) => ({ title, price: 0 }));
    a.keptSource = 'applied';
  }
  return a;
}

const count = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

export function buildReport(logDir: string, opts: { leadsFile?: string; exclude?: RegExp } = {}) {
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')) : [];
  const sessions = files.map((f) => analyseSession(path.join(logDir, f))).filter((s) => !(opts.exclude && opts.exclude.test(s.sessionId)) && s.turns + s.taps > 0);
  const leadLines = opts.leadsFile && fs.existsSync(opts.leadsFile) ? readJsonl(opts.leadsFile) : [];
  // QA-060: visit requests are extra lines on the same lead file, not new leads
  const leads = leadLines.filter((l: any) => l?.type !== 'visit_request');
  const visitRequests = leadLines.filter((l: any) => l?.type === 'visit_request').length;
  const sum = (k: keyof SessionAnalytics) => sessions.reduce((t, s) => t + (s[k] as number), 0);
  const collectionOf = (t: string) => t.split(/[ ,]/)[0];
  const kept = sessions.flatMap((s) => s.kept.map((k) => k.title));
  const funnel = {
    sessions: sessions.length,
    withProposal: sessions.filter((s) => s.proposals > 0).length,
    withTap: sessions.filter((s) => s.applied > 0).length,
    withKeptSet: sessions.filter((s) => s.kept.length > 0).length,
    withExport: sessions.filter((s) => s.exports > 0).length,
  };
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      sessions: sessions.length,
      turns: sum('turns'),
      voiceTurns: sum('voiceTurns'),
      proposals: sum('proposals'),
      cardsShown: sum('cardsShown'),
      taps: sum('taps'),
      applied: sum('applied'),
      keptSets: kept.length,
      keptValueBYN: Math.round(sessions.reduce((t, s) => t + s.keptTotal, 0)),
      exports: sum('exports'),
      photos: sum('photos'),
      leads: leads.length,
      visitRequests,
      fallbacks: sum('fallbacks'),
      guardrailHits: sum('guardrailHits'),
    },
    funnel,
    topProposed: count(sessions.flatMap((s) => s.proposed)).slice(0, 10),
    topTapped: count(sessions.flatMap((s) => s.tapped)).slice(0, 10),
    topKept: count(kept).slice(0, 10),
    keptByCollection: count(kept.map(collectionOf)),
    budgets: sessions.flatMap((s) => s.budgets),
    sessions,
  };
}

export type ExpoReport = ReturnType<typeof buildReport>;

export function reportMarkdown(r: ExpoReport): string {
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  const t = r.totals;
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const table = (rows: [string, number][], h: string) => (rows.length ? [`| ${h} | Кол-во |`, '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n') : '_нет данных_');
  return [
    '# Отчёт о выставке: ИИ-консультант Oliveeka',
    '',
    `Сформирован: ${new Date(r.generatedAt).toLocaleString('ru-RU')}. Источник: журналы сессий консультанта и досье.`,
    '',
    '## Итоги',
    '',
    `- Сессий посетителей: **${t.sessions}**, реплик: ${t.turns} (голосом: ${t.voiceTurns})`,
    `- Подборок комплектов: ${t.proposals}, показано карточек: ${t.cardsShown}`,
    `- Выбрано комплектов (нажатие или голос): ${t.applied}; оставлено в комнате к концу сессии: ${t.keptSets} на ${t.keptValueBYN} BYN`,
    `- Досье (PDF) отправлено: ${t.exports}, лидов: ${t.leads}, заявок на визит в салон: ${t.visitRequests ?? 0}, ИИ-фото: ${t.photos}`,
    `- Медианный бюджет посетителя: ${med(r.budgets) || '—'} BYN (назван в ${r.budgets.length} подборках)`,
    '',
    '## Воронка',
    '',
    '| Этап | Сессий | Доля |',
    '|---|---|---|',
    `| Начали разговор | ${r.funnel.sessions} | 100% |`,
    `| Получили подборку | ${r.funnel.withProposal} | ${pct(r.funnel.withProposal, r.funnel.sessions)} |`,
    `| Выбрали комплект | ${r.funnel.withTap} | ${pct(r.funnel.withTap, r.funnel.sessions)} |`,
    `| Оставили комплект | ${r.funnel.withKeptSet} | ${pct(r.funnel.withKeptSet, r.funnel.sessions)} |`,
    `| Забрали досье | ${r.funnel.withExport} | ${pct(r.funnel.withExport, r.funnel.sessions)} |`,
    '',
    '## Что предлагали чаще всего',
    '',
    table(r.topProposed, 'Комплект'),
    '',
    '## Что выбирали',
    '',
    table(r.topTapped, 'Комплект'),
    '',
    '## Что оставили в проекте',
    '',
    table(r.topKept, 'Комплект'),
    '',
    '## По коллекциям (оставленные комплекты)',
    '',
    table(r.keptByCollection, 'Коллекция'),
    '',
    '## Качество работы консультанта',
    '',
    `- Переключений на резервный сценарий (сбой/таймаут модели): ${t.fallbacks}`,
    `- Срабатываний защитных правил (цены, скидки, сроки): ${t.guardrailHits}`,
    '',
    'Цены — из каталога oliveeka.by на дату синхронизации; позиции «цена уточняется» не входят в суммы.',
    '',
  ].join('\n');
}
