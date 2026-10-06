import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { buildReport, reportMarkdown } from '../src/ai/analytics/report';
import { spendPageHtml } from '../src/ai/analytics/spendPage';
import { CostLedger } from '../src/ai/util/costLedger';

const f = fixtureIndex();

describe('task 9: analytics and the post-Expo report', () => {
  it('counts proposals, taps, kept sets and exports per session and builds a Russian report', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-'));
    const logDir = path.join(dir, 'logs');
    const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir });
    // visitor 1: proposal, voice pick, closet, save
    const ue1 = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    const s1 = new AiSession('inst-1:anna', 'inst-1', 'anna', new DirectChannel(ue1), { emit: () => undefined }, 'constructor');
    await o.handleTurn(s1, 'Покажи варианты до 6000 BYN');
    await o.handleTurn(s1, 'Давай первый вариант');
    // visitor 2: proposal, card tap, no export
    const ue2 = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    let cards: any[] = [];
    const s2 = new AiSession('inst-1:boris', 'inst-1', 'boris', new DirectChannel(ue2), { emit: (e, p) => e === 'ai.cards' && (cards = p.cards) }, 'constructor');
    await o.handleTurn(s2, 'Хочу светлую мебель');
    const res = ue2.execute({ id: 'r-1-1', cmd: 'apply_config', args: { config: cards[1].config, placement: cards[1].placement } });
    await o.handleCardTap(s2, { cardId: cards[1].cardId, requestId: 'r-1-1', result: res });
    // a harness session is excluded
    const s3 = new AiSession('harness:x', 'harness', 'x', new DirectChannel(new FakeUe(f.catalog)), { emit: () => undefined }, 'constructor');
    await o.handleTurn(s3, 'Привет');
    const leads = path.join(dir, 'leads.jsonl');
    fs.writeFileSync(leads, JSON.stringify({ username: 'anna', saveId: 's1', dossierId: 'd-1' }) + '\n');

    const r = buildReport(logDir, { leadsFile: leads, exclude: /^harness:/ });
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.proposals).toBe(2);
    expect(r.totals.applied).toBe(2);
    expect(r.totals.keptSets).toBe(2);
    expect(r.totals.leads).toBe(1);
    expect(r.funnel).toMatchObject({ sessions: 2, withProposal: 2, withTap: 2, withKeptSet: 2 });
    const anna = r.sessions.find((s) => s.username === 'anna')!;
    expect(anna.sessionId).toBe('inst-1:anna');
    expect(anna.budgets).toEqual([6000]);
    expect(r.topTapped.length).toBeGreaterThan(0);
    const md = reportMarkdown(r);
    expect(md).toContain('# Отчёт о выставке');
    expect(md).toContain('| Выбрали комплект | 2 | 100% |');
  });
});

describe('task 10: spend dashboard page', () => {
  it('renders totals, cap, providers and the last calls in Russian without secrets', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), 's.jsonl');
    const l = new CostLedger({ file, capUsd: 50, perSessionCapUsd: 1.5 });
    l.reserve('anthropic', 'messages.create claude-sonnet-5-5', 0.01, 'inst-1:anna').settle(0.012);
    l.reserve('fal', 'fal-ai/flux-2/klein/4b/edit preview', 0.01, 'inst-1:anna').settle();
    const html = spendPageHtml(l.entries(), l.totalUsd(), l.capUsd, l.perSessionCapUsd, { llm: false, render: true });
    expect(html).toContain('Расходы на платные API');
    expect(html).toContain('$0.0220');
    expect(html).toContain('из $50.00');
    expect(html).toContain('anthropic');
    expect(html).toContain('inst-1:anna');
    expect(html).toContain('llm: платный');
    expect(html).not.toMatch(/sk-ant|FAL_KEY=|api[_-]?key/i);
  });
});
