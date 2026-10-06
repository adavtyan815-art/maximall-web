import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { Orchestrator, AiSession, stripThinking } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/ai/providers/llm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';

/**
 * Paid test 2026-10-01: Sonnet 5.5 rejects replayed thinking blocks once system/tools change (mode switch) or leading turns
 * are trimmed. This fake model behaves like the API: every reply carries a thinking block bound to the request's
 * system + tools; a request that replays a block under a different system/tools gets the same 400 message.
 */
class BindingLlm implements LlmProvider {
  readonly name = 'binding-fake';
  readonly model = 'fake';
  readonly mock = true;
  requests: LlmRequest[] = [];
  errors = 0;
  private inner = new MockLlm();
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const key = req.system + JSON.stringify(req.tools);
    req.messages.forEach((m, i) => {
      if (m.role === 'assistant' && Array.isArray(m.content))
        for (const b of m.content as any[])
          if (b.type === 'thinking' && b.signature !== key) {
            this.errors++;
            throw new Error(`400 messages.${i}.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`);
          }
    });
    const r = await this.inner.create(req);
    return { ...r, content: [{ type: 'thinking', thinking: '', signature: key } as any, ...r.content] };
  }
}

const f = fixtureIndex();
const mk = (llm: LlmProvider, dir: string) =>
  new Orchestrator({ catalog: f.catalog, llm, fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: path.join(dir, 'logs') });
const replayedThinking = (r: LlmRequest) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as any[]) : [])).filter((b) => b.type === 'thinking').length;

describe('preserved thinking: thinking blocks across mode switches and trims', () => {
  it('stripThinking removes only thinking blocks and never leaves an empty assistant turn', () => {
    const msgs: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 't1', name: 'n', input: {} }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'y' }] },
    ];
    expect(stripThinking(msgs)).toBe(2);
    expect(msgs[1].content.map((b: any) => b.type)).toEqual(['tool_use']);
    expect(msgs[2].content).toEqual([{ type: 'text', text: '…' }]);
  });

  it('a mode switch strips the old blocks before the next model call: no 400, no scripted fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
    const llm = new BindingLlm();
    const o = mk(llm, dir);
    const s = new AiSession('inst-1:tb', 'inst-1', 'tb', new DirectChannel(new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 })), { emit: () => undefined }, 'constructor');
    await o.handleTurn(s, 'Покажи варианты до 6000 BYN');
    expect(replayedThinking(llm.requests[llm.requests.length - 1])).toBeGreaterThanOrEqual(0);
    const before = llm.requests.length;
    s.mode = 'showroom'; // what exit_constructor does to the session
    await o.handleTurn(s, 'Расскажите про коллекцию Milu');
    expect(llm.errors).toBe(0);
    expect(llm.requests.length).toBeGreaterThan(before);
    expect(replayedThinking(llm.requests[before])).toBe(0);
    expect(s.stats.fallbacks).toBe(0);
  });

  it('without the binding check the same history would have been rejected (the fake reproduces the live 400)', async () => {
    const llm = new BindingLlm();
    const req: LlmRequest = { system: 'A', tools: [], messages: [{ role: 'user', content: 'x' } as any, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'A[]' }, { type: 'text', text: 'ok' }] } as any, { role: 'user', content: 'y' } as any] } as any;
    await expect(llm.create({ ...req, system: 'B' })).rejects.toThrow(/Invalid `signature` in `thinking` block/);
  });
});
