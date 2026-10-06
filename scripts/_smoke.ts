import { CatalogIndex } from '../src/ai/catalog/index';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';
(async () => {
  const cat = CatalogIndex.load();
  const orch = new Orchestrator({ catalog: cat, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), logDir: require('os').tmpdir() + '/ai_logs' });
  const ev: any[] = [];
  const s = new AiSession('dev:qa', 'dev', 'qa', new DirectChannel(new FakeUe(cat)), { emit: (e, p) => ev.push([e, p]) }, 'constructor');
  for (const t of ['Привет', 'Ванная 2 на 2,5 метра, дверь есть', 'Бюджет до 5000 рублей, хочу светлое', 'Давай второй вариант', 'Сделай светлее', 'Добавь пенал', 'Покрась стены в белый', 'Сделай фото', 'Можно скидку?', 'Отправь мне всё']) {
    const from = ev.length;
    await orch.handleTurn(s, t);
    const says = ev.slice(from).filter(([e]) => e === 'ai.say').map(([, p]) => p.text);
    const cards = ev.slice(from).filter(([e]) => e === 'ai.cards').flatMap(([, p]) => p.cards.map((c: any) => `${c.tier}:${c.title}:${c.price}:${c.spareCm}:${c.reason}`));
    console.log('>>', t, '\n  ', says.join(' | '), cards.length ? '\n   cards: ' + cards.join('\n          ') : '');
  }
  console.log(JSON.stringify(orch.basket(s), null, 1).slice(0, 1500));
})();
