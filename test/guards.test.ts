import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { guardReply } from '../src/ai/orchestrator/guardrails';
import { CostLedger, BudgetExceededError, anthropicCostUsd } from '../src/ai/util/costLedger';
import { parseTurn, parseRoomSize, parseBudget } from '../src/ai/orchestrator/intents';
import { createProviders } from '../src/ai/providers';
import { MockTts, MockStt, pcmDurationMs, TTS_SAMPLE_RATE } from '../src/ai/providers/voice';

describe('guardrails', () => {
  it('drops sentences with amounts the session never saw', () => {
    const g = guardReply('Комплект стоит 2872 BYN. А со скидкой будет 2500 BYN.', [2872]);
    expect(g.text).toBe('Комплект стоит 2872 BYN.');
    expect(g.violations.length).toBeGreaterThan(0);
  });
  it('drops offered discounts and delivery promises but keeps refusals', () => {
    expect(guardReply('Дам вам скидку 10%.', []).text).toBe('Уточню это у менеджера салона.');
    expect(guardReply('Доставим за 3 дня.', []).violations).toContain('date');
    const ok = guardReply('Скидки я не обсуждаю — это решает менеджер салона.', []);
    expect(ok.violations).toHaveLength(0);
  });
  it('accepts known prices with thin-space formatting', () => {
    expect(guardReply('Итого 3 484 BYN.', [3484]).violations).toHaveLength(0);
  });
});

describe('cost ledger', () => {
  it('appends JSON lines and refuses a call that would pass the cap', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-')), 'api_spend.jsonl');
    const l = new CostLedger({ file, capUsd: 0.05, perSessionCapUsd: 1 });
    const r = l.reserve('anthropic', 'messages.create claude-sonnet-5-5', 0.02, 's1');
    r.settle(0.03);
    expect(l.totalUsd()).toBeCloseTo(0.03, 6);
    expect(() => l.reserve('anthropic', 'x', 0.03, 's1')).toThrow(BudgetExceededError);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    expect(lines.map((x) => x.status)).toEqual(['reserved', 'settled']);
    expect(lines[1].runningTotalUsd).toBeCloseTo(0.03, 6);
  });
  it('enforces the per-session cap', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-')), 'a.jsonl');
    const l = new CostLedger({ file, capUsd: 50, perSessionCapUsd: 0.01 });
    l.reserve('elevenlabs', 'tts', 0.009, 'sX').settle();
    expect(() => l.reserve('elevenlabs', 'tts', 0.002, 'sX')).toThrow(/Per-session/);
    expect(() => l.reserve('elevenlabs', 'tts', 0.002, 'sY')).not.toThrow();
  });
  it('prices Anthropic usage from the skill price table', () => {
    expect(anthropicCostUsd('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 0 })).toBeCloseTo(2, 6);
    expect(anthropicCostUsd('claude-haiku-4-5', { input_tokens: 0, output_tokens: 1e6 })).toBeCloseTo(5, 6);
  });
});

describe('providers', () => {
  it('uses mocks without keys or without paid-call approval', () => {
    const save = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
      delete process.env.AI_PAID_CALLS_APPROVED;
      const p = createProviders({ skipWindowsEnv: true, ledger: new CostLedger({ file: path.join(os.tmpdir(), 'x.jsonl') }) });
      expect(p.mock).toEqual({ llm: true, stt: true, tts: true, render: true, renderFallback: true });
      expect(p.keys.ANTHROPIC_API_KEY).toBe(true);
    } finally {
      process.env = save;
    }
  });
  it('mock TTS returns s16le mono 24 kHz PCM with a text-proportional duration; mock STT reads MOCKTEXT', async () => {
    const pcm = await new MockTts().synthesize('Здравствуйте! Я Ольга.');
    expect(pcm.length % 2).toBe(0);
    expect(TTS_SAMPLE_RATE).toBe(24000);
    expect(pcmDurationMs(pcm)).toBeGreaterThan(1000);
    expect((await new MockStt().transcribe(Buffer.from('MOCKTEXT:Добавь пенал'), 'audio/pcm;rate=16000')).text).toBe('Добавь пенал');
  });
});

describe('Russian intent rules (mock policy + scripted fallback)', () => {
  it('parses room sizes and budgets', () => {
    expect(parseRoomSize('ванная 2 на 2,5 метра')).toEqual({ widthCm: 200, depthCm: 250 });
    expect(parseRoomSize('250 на 180 см')).toEqual({ widthCm: 250, depthCm: 180 });
    expect(parseRoomSize('два на три')).toEqual({ widthCm: 200, depthCm: 300 });
    expect(parseBudget('бюджет до 3000 рублей')).toBe(3000);
    expect(parseBudget('уложиться в 4 тысячи')).toBe(4000);
  });
  it('maps phrases to tool calls', () => {
    const names = (t: string) => parseTurn(t).calls.map((c) => c.name);
    expect(names('Давай второй вариант')).toEqual(['apply_card']);
    expect(parseTurn('Давай второй вариант').calls[0].input).toEqual({ position: 2 });
    expect(names('Добавь пенал')).toEqual(['configure_set']);
    expect(names('Убери шкаф')).toEqual(['configure_set']);
    expect(names('Сделай светлее')).toEqual(['configure_set']);
    expect(names('Отправь мне всё')).toEqual(['save_project']);
    expect(names('скинь мне всё на телефон')).toEqual(['save_project']);
    expect(parseTurn('Скиньте цену, пожалуйста').reply).toBe('guard_discount');
    expect(parseTurn('Когда будет доставка?').reply).toBe('guard_delivery');
    expect(parseTurn('Какая завтра погода?').reply).toBe('off_topic');
    expect(names('Комната 3 на 2 метра, бюджет 4000')).toEqual(['build_room', 'propose_sets']);
  });
});

import { buildAnthropicRequest } from '../src/ai/providers/llm';
describe('Anthropic request shape (verified against the claude-api skill + SDK typings)', () => {
  const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'Привет' }], tools: [] };
  it('claude-sonnet-5-5: effort low in output_config, tool_choice auto, fallbacks "default" under server-side-fallback-2026-07-01', () => {
    const b = buildAnthropicRequest('claude-sonnet-5-5', req);
    expect(b.beta).toBe(true);
    expect(b.params).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'low' }, tool_choice: { type: 'auto' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect((b.params as any).thinking).toBeUndefined(); // adaptive by default; disabled would 400
    expect((b.params as any).system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  it('claude-haiku-4-5: no effort, no fallbacks, no betas', () => {
    const b = buildAnthropicRequest('claude-haiku-4-5', req) as any;
    expect(b.beta).toBe(false);
    expect(b.params.output_config).toBeUndefined();
    expect(b.params.fallbacks).toBeUndefined();
    expect(b.params.betas).toBeUndefined();
    expect(b.params.tool_choice).toEqual({ type: 'auto' });
  });
});
