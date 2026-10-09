import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { Orchestrator, AiSession, isItemLockBusy } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { renderReason } from '../src/ai/i18n';

// Month 2 (MONTH2_SPEC m2.2 §8.1, M5): an AI command on a set another participant is moving (its item lock) is refused by UE with
// PLANNER_BUSY + reasonParams.detail ITEM_LOCKED. That is not "another visitor owns the planner": the sticky plannerBusy state, its turn
// and busyHits stay untouched, and the visitor hears the item-lock wording. A plain PLANNER_BUSY still sets them.

const f = fixtureIndex();

function setup(reply: Record<string, any>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itemlock-'));
  const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
  const sent: any[] = [];
  const channel = {
    async send(req: any) {
      sent.push(req);
      return { type: 'result', id: req.id, cmd: req.cmd, result: {}, state_rev: 3, ...reply };
    },
  };
  const s = new AiSession('i:visitorA', 'i', 'visitorA', channel as any, { emit: () => {} }, 'constructor');
  return { o, s, sent };
}

const ITEM_LOCKED = {
  ok: false,
  reasonCode: 'PLANNER_BUSY',
  reason: 'Этот гарнитур сейчас передвигает другой участник — попробуйте через несколько секунд',
  reasonParams: { detail: 'ITEM_LOCKED', setId: 'AB12CD34', playerId: 257 },
};
const BUSY = {
  ok: false,
  reasonCode: 'PLANNER_BUSY',
  reason: 'Конструктор сейчас занят другим посетителем. Подождите немного или попросите консультанта в салоне.',
  reasonParams: { detail: 'PLANNER_BUSY' },
};

describe('Month 2 M5: PLANNER_BUSY / ITEM_LOCKED (a set another participant is moving)', () => {
  it('recognises the item-lock refusal only', () => {
    expect(isItemLockBusy(ITEM_LOCKED)).toBe(true);
    expect(isItemLockBusy(BUSY)).toBe(false);
    expect(isItemLockBusy({ reasonCode: 'PLANNER_BUSY' })).toBe(false);
    expect(isItemLockBusy({ reasonCode: 'NO_FIT', reasonParams: { detail: 'ITEM_LOCKED' } })).toBe(false);
    expect(isItemLockBusy(undefined)).toBe(false);
  });

  it('does not set plannerBusy, plannerBusyTurn or busyHits', async () => {
    const { o, s, sent } = setup(ITEM_LOCKED);
    const r = await o.command(s, 'move_set', { setId: 'AB12CD34', direction: 'left', distanceCm: 10 }, 'model' as any, 8000, 't-1');
    expect(sent.length).toBe(1);
    expect(r).toMatchObject({ ok: false, reasonCode: 'PLANNER_BUSY', reasonParams: { detail: 'ITEM_LOCKED' } });
    expect(s.plannerBusy).toBe(false);
    expect(s.plannerBusyTurn).toBeUndefined();
    expect(s.busyHits).toBe(0);
    // The next planner command is sent (nothing is held back as "another visitor owns the planner").
    await o.command(s, 'move_set', { setId: 'AB12CD34', direction: 'left', distanceCm: 10 }, 'model' as any, 8000, 't-2');
    expect(sent.length).toBe(2);
  });

  it('a plain PLANNER_BUSY still sets them', async () => {
    const { o, s } = setup(BUSY);
    await o.command(s, 'move_set', { setId: 'AB12CD34', direction: 'left', distanceCm: 10 }, 'model' as any, 8000, 't-1');
    expect(s.plannerBusy).toBe(true);
    expect(s.plannerBusyTurn).toBe('t-1');
    expect(s.busyHits).toBe(1);
  });

  it('a card tap refused with ITEM_LOCKED does not mark the planner busy', async () => {
    const { o, s } = setup(ITEM_LOCKED);
    s.cards.set('c-1', { cardId: 'c-1', title: 'Milu 80', config: { productId: 'Milu' } } as any);
    await o.handleCardTap(s, { cardId: 'c-1', requestId: 'r-1', result: { type: 'result', id: 'r-1', cmd: 'apply_config', state_rev: 3, ...ITEM_LOCKED } as any });
    expect(s.plannerBusy).toBe(false);
  });

  it('has its own wording (RU / EN): another participant moves the set, try again in a few seconds', () => {
    const en = renderReason('en', ITEM_LOCKED).text!;
    expect(en).toBe('Another participant is moving this set right now — try again in a few seconds');
    // Russian: UE's own reason; without it, the Russian template.
    expect(renderReason('ru', ITEM_LOCKED).text).toBe(ITEM_LOCKED.reason);
    expect(renderReason('ru', { reasonCode: 'PLANNER_BUSY', reasonParams: { detail: 'ITEM_LOCKED' } }).text).toBe(
      'Этот гарнитур сейчас передвигает другой участник — попробуйте через несколько секунд',
    );
    // A plain PLANNER_BUSY keeps the "another visitor" wording.
    expect(renderReason('en', BUSY).text).toMatch(/another visitor is using the room planner/);
  });
});
