import { describe, expect, it } from 'vitest';
import { applySttCorrection, correctTranscript } from '../src/ai/voice/sttCorrect';
import { PHRASES } from '../src/ai/harness/phrases';

const fix = (s: string) => correctTranscript(s).text;

describe('STT post-correction dictionary (real kiosk transcripts 2026-10-01/02)', () => {
  it.each([
    ['Целый тумбу, пожалуйста, 80 см.', 'Сделай тумбу, пожалуйста, 80 см.'],
    ['Можешь в таком состоянии дать рэнд?', 'Можешь в таком состоянии дать рендер?'],
    ['Отсюда можешь до озер ранд? Дай ранд отсюда.', 'Отсюда можешь до озер рендер? Дай рендер отсюда.'],
    ['...И с-с этим, да. Давай перейдём в конструктор.', '...И с этим, да. Давай перейдём в конструктор.'],
    ['С-с-сама поставь.', 'Сама поставь.'],
    ['4Х4 м.', '4 на 4 м.'],
    ['Поставь Милу 100.', 'Поставь Milu 100.'],
    ['Измени милу на 80 см.', 'Измени Milu на 80 см.'],
    ['Изменил тумбу Urban на тумбу Milo.', 'Изменил тумбу Urban на тумбу Milu.'],
    ['Измени раковину на Urbanе .', 'Измени раковину на Urban .'], // Latin «Urban» + Cyrillic «е»
    ['Поставь подходящий по турбон цвет всех стен.', 'Поставь подходящий под тумбу цвет всех стен.'],
    ['Постройка — ондату два на два .', 'Построй комнату 2 на 2 .'],
    ['Увеличь на 400-400 см.', 'Увеличь на 400 на 400 см.'],
    ['Построй комнату четыреста на четыреста сантиметров. Построй комнату', 'Построй комнату 400 на 400 сантиметров. Построй комнату'],
    ['Построй комнату четыре на четыре .', 'Построй комнату 4 на 4 .'],
    ['Два на два.', '2 на 2.'],
    ['Изменить цвет стандарт Terra. Terra.', 'Изменить цвет стенд Terra. Terra.'],
    ['У меня 10 тыс. бумпостов, две тумбы.', 'У меня 10 тыс. бюджет, две тумбы.'],
    ['Зделай один рендер.', 'Сделай один рендер.'],
  ])('%s', (raw, want) => expect(fix(raw)).toBe(want));

  it.each([
    ['Сделай тумбу восемьдесят сантиметров', 'Сделай тумбу 80 сантиметров'],
    ['Санузел полтора на два метра', 'Санузел 1,5 на 2 метра'],
    ['комната два с половиной на три метра', 'комната 2,5 на 3 метра'],
    ['тумба сто двадцать см', 'тумба 120 см'],
    ['ширина тысяча двести миллиметров', 'ширина 1200 миллиметров'],
    ['Покажи коллекцию Урбан и Терру', 'Покажи коллекцию Urban и Terra'],
    ['Что есть в Авеню?', 'Что есть в Avenu?'],
  ])('sizes and names: %s', (raw, want) => expect(fix(raw)).toBe(want));

  it.each([
    'Сменить свидетельство о рождении.',
    '10-16 Метров.', // a range, not a size
    'Получит 220 м.',
    'Поставь на каждой стене одно окно.', // a count, not a size
    'Поставь на одну стене, где возможно, одну тумбу.',
    'Нет, давай поговорим один на один.', // idiom
    'Две тумбы и одно зеркало',
    'Пять минут подожди',
    'Это очень мило',
    'Покажи тумбу и пенал',
    'Сто процентов, давай',
    'Привет!',
  ])('leaves alone: %s', (raw) => {
    const r = correctTranscript(raw);
    expect(r.text).toBe(raw);
    expect(r.corrections).toEqual([]);
  });

  it('harness phrases (correct written Russian): only size words change', () => {
    const changed = PHRASES.map((p: any) => String(p.text ?? '')).filter((t) => t && fix(t) !== t);
    for (const t of changed) expect(correctTranscript(t).corrections.every((c) => c.rule === 'number')).toBe(true);
    expect(changed.length).toBeLessThanOrEqual(3);
  });

  it('log fields only when something changed; AI_STT_CORRECT=0 switches it off', () => {
    expect(applySttCorrection('Привет!', {})).toEqual({ text: 'Привет!', logFields: {} });
    const r = applySttCorrection('Дай рэнд', {});
    expect(r.text).toBe('Дай рендер');
    expect(r.logFields).toEqual({ rawText: 'Дай рэнд', corrections: [{ rule: 'term', from: 'рэнд', to: 'рендер' }] });
    expect(applySttCorrection('Дай рэнд', { AI_STT_CORRECT: '0' })).toEqual({ text: 'Дай рэнд', logFields: {} });
  });
});
