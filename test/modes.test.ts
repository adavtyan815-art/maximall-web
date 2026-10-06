import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { isVerbalYes, isVerbalNo, isFitTopic, asksForConstructor, boothScopeAnswer, isExplicitConstructorRequest, wantsOtherCollection, isExitRequest, isRoomAction } from '../src/ai/orchestrator/modes';
import { wavFromPcm, MockTts, ClipStore } from '../src/ai/providers/voice';
import { fixtureIndex } from './helpers/catalog';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { TOOLS } from '../src/ai/orchestrator/tools';

const f = fixtureIndex();

describe('PHASE 2 consent wording', () => {
  it('only an unambiguous yes moves', () => {
    for (const t of ['Да', 'да!', 'Давай', 'Давайте', 'Покажи', 'Переходим', 'Перейдём', 'Хочу', 'Да, давай', 'Да, перейти', 'Конечно', 'Давай перейдём', 'Да, покажи в комнате']) expect(isVerbalYes(t), t).toBe(true);
    for (const t of ['Может быть', 'Не знаю', 'Да?', 'А сколько стоит?', 'Да, но потом', 'Наверное', 'Нет', 'Давай позже', 'Хочу подумать', 'Покажи другие цвета', '', 'Ну да, если не долго']) expect(isVerbalYes(t), t).toBe(false);
    expect(isVerbalNo('Нет, спасибо')).toBe(true);
    expect(isVerbalNo('Остаёмся')).toBe(true);
  });
  it('another collection for the booth in focus, any time (WEB finding)', () => {
    for (const t of ['Посмотрим другие коллекции', 'Поставьте другую', 'Замените на другую', 'Другую коллекцию сюда', 'Покажи другие коллекции', 'Хочу другую модель', 'Давайте другую']) expect(wantsOtherCollection(t), t).toBe(true);
    for (const t of ['Поставьте сюда Urban', 'Замените на Urban', 'Другой цвет', 'Сделай 100 см', 'Эту']) expect(wantsOtherCollection(t), t).toBe(false);
  });

  it('fit topics and explicit requests', () => {
    for (const t of ['Влезет ли она в мою ванную?', 'Какие размеры у Milu?', 'У меня ванная 2 на 2,5 метра', 'А в комнате как будет?', 'Поместится по ширине?']) expect(isFitTopic(t), t).toBe(true);
    for (const t of ['Сколько стоит Avenu?', 'Хочу белый цвет', 'Добавь пенал']) expect(isFitTopic(t), t).toBe(false);
    expect(asksForConstructor('Хочу в конструктор')).toBe(true);
    expect(asksForConstructor('Покажи в комнате: Milu 80')).toBe(true);
    expect(boothScopeAnswer('Эту')).toBe('this');
    for (const t of ['Давайте всё-таки перейдём в конструктор', 'Хочу в конструктор', 'Откройте конструктор', 'Перейти в конструктор', 'Можно в конструктор?']) expect(isExplicitConstructorRequest(t), t).toBe(true);
    for (const t of ['А что такое конструктор?', 'Не хочу в конструктор', 'Может потом в конструктор', 'Конструктор', 'Покажи в комнате']) expect(isExplicitConstructorRequest(t), t).toBe(false);
    expect(boothScopeAnswer('Другие')).toBe('other');
    expect(boothScopeAnswer('А влезет ли эта тумба в мою ванную?')).toBeNull();
  });
});

describe('PHASE 2 speech and gating', () => {
  it('browser audio: the mock PCM is wrapped in a valid WAV header', async () => {
    const pcm = await new MockTts().synthesize('Здравствуйте');
    const wav = wavFromPcm(pcm);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    const store = new ClipStore(fs.mkdtempSync(path.join(os.tmpdir(), 'wav-')));
    const c = store.saveAudio(pcm);
    expect(c.ext).toBe('wav');
    expect(store.path(`${c.clipId}.wav`)).toBe(c.file);
  });

  it('the consultant_summon tool is gone; in the salon a room tool never reaches UE', async () => {
    expect(TOOLS.some((t) => t.name === 'consultant_summon')).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
    const ue = new FakeUe(f.catalog, { inPlanner: false });
    const s = new AiSession('i:gate', 'i', 'gate', new DirectChannel(ue), { emit: () => undefined });
    expect(s.mode).toBe('showroom');
    for (const name of ['build_room', 'apply_card', 'configure_set', 'finish_surface', 'save_project', 'undo', 'check_fit']) {
      const out = await o.runTool(s, name, { widthCm: 200, depthCm: 250 }, 'model', 't-1');
      expect(out, name).toMatchObject({ ok: false, reasonCode: 'NOT_IN_PLANNER' });
    }
    // v2.2 P3-02: take_photo works in the salon, but only for a booth; with none in focus nothing is sent
    expect(await o.runTool(s, 'take_photo', {}, 'model', 't-1')).toMatchObject({ ok: false, reasonCode: 'NO_BOOTH' });
    // even a direct command is held back by the gate
    const r = await o.command(s, 'build_room', { widthCm: 200, depthCm: 250 }, 'model');
    expect(r.ok).toBe(false);
    expect(ue.log).toEqual([]);
  });

  it('QA-077: exit phrases and room actions', () => {
    for (const x of ['Выйдите, пожалуйста, из конструктора', 'Выйди из конструктора', 'Закрой конструктор', 'Вернёмся в салон', 'Хочу обратно в салон']) expect(isExitRequest(x), x).toBe(true);
    for (const x of ['Не выходи из конструктора', 'Покажи варианты', 'Что такое конструктор?']) expect(isExitRequest(x), x).toBe(false);
    for (const x of ['Построй мне комнату', 'Покрась стены в белый', 'Положи плитку на пол', 'Ванная 2 на 2,5 метра']) expect(isRoomAction(x), x).toBe('room');
    expect(isRoomAction('Сделай фото')).toBe('photo');
    expect(isRoomAction('Сделай 100 см')).toBeNull();
    expect(isRoomAction('Покрась тумбу в RAL 9010')).toBeNull();
  });

  it('QA-074: a RAL/NCS repaint is confirmed only when booth_get shows the colour', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-'));
    const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
    const ue = new FakeUe(f.catalog, { inPlanner: false });
    const said: string[] = [];
    const s = new AiSession('i:paint', 'i', 'paint', new DirectChannel(ue), { emit: (e, p) => e === 'ai.say' && said.push(p.text) });
    await o.onUeEvent(s, ue.focusEvent('Booth_Milu_1'));
    ue.dropPaint = true; // UE answers ok but the colour does not stick
    await o.handleTurn(s, 'Покрась тумбу в RAL 5014');
    expect(said.at(-1)).toMatch(/^Покрасить в RAL 5014 не получилось/);
    expect(ue.log.filter((l) => l.cmd === 'booth_get').length).toBeGreaterThanOrEqual(1);
    ue.dropPaint = false;
    await o.handleTurn(s, 'Покрась тумбу в RAL 5014');
    expect(said.at(-1)).toMatch(/^Покрасила тумбу в RAL 5014/);
  });
});
