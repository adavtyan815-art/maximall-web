/**
 * X4 Day-1 phrase harness.
 *   npx tsx scripts/phrase-harness.ts                      -> mock policy run + report + cost estimate (no network)
 *   npx tsx scripts/phrase-harness.ts --lang en            -> the English set (v2.5, PHRASES_EN) in an English session
 *   npx tsx scripts/phrase-harness.ts --live claude-sonnet-5-5  -> live run (REFUSED unless ANTHROPIC_API_KEY and
 *        AI_PAID_CALLS_APPROVED=1 are set; every call goes through the spend ledger with its budget cap)
 * Report: docs/AI_Consultant_Expo/phrase_harness_<model>.md (+ .json)
 */
import fs from 'fs';
import path from 'path';
import { CatalogIndex } from '../src/ai/catalog/index';
import { runHarness, estimateRunCost } from '../src/ai/harness/run';
import { PHRASES } from '../src/ai/harness/phrases';
import { PHRASES_EN } from '../src/ai/harness/phrasesEn';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { AnthropicLlm, LlmProvider } from '../src/ai/providers/llm';
import { CostLedger } from '../src/ai/util/costLedger';
import { hydrateProviderKeys, flag } from '../src/ai/util/env';
import { speechLength, estimateSpokenSeconds, SPOKEN_MAX_CHARS } from '../src/ai/orchestrator/speech';

const args = process.argv.slice(2);
const li = args.indexOf('--live');
const live = li >= 0 ? args[li + 1] : null;
const lgi = args.indexOf('--lang');
const lang: 'ru' | 'en' = lgi >= 0 && args[lgi + 1] === 'en' ? 'en' : 'ru';
const outDir = process.env.HARNESS_OUT ?? 'D:/awsTemplate_GameLift/docs/AI_Consultant_Expo';

(async () => {
  const catalog = CatalogIndex.load();
  let llm: LlmProvider = new MockLlm();
  if (live) {
    const keys = hydrateProviderKeys();
    if (!keys.ANTHROPIC_API_KEY || !flag('AI_PAID_CALLS_APPROVED')) {
      console.error('Live run refused: needs ANTHROPIC_API_KEY and AI_PAID_CALLS_APPROVED=1 (coordinator approval).');
      process.exit(2);
    }
    llm = new AnthropicLlm(live, new CostLedger());
  }
  const t0 = Date.now();
  const r = await runHarness(catalog, llm, lang === 'en' ? PHRASES_EN : PHRASES, lang);
  const cost = estimateRunCost(r.meter);
  const name = (live ?? 'mock') + (lang === 'en' ? '_en' : '');
  const byGroup: Record<string, { pass: number; total: number }> = {};
  for (const x of r.results) {
    byGroup[x.group] ??= { pass: 0, total: 0 };
    byGroup[x.group].total++;
    if (x.pass) byGroup[x.group].pass++;
  }
  // v2.2 P3-05: the spoken summary (ai.say.spokenText) of every scored reply
  const pct = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const chars = r.results.map((x) => x.spoken.length).sort((a, b) => a - b);
  const sp = r.results.map((x) => speechLength(x.spoken)).sort((a, b) => a - b);
  const sec13 = r.results.map((x) => estimateSpokenSeconds(x.spoken, 13)).sort((a, b) => a - b);
  const sec15 = r.results.map((x) => estimateSpokenSeconds(x.spoken, 15)).sort((a, b) => a - b);
  const full = r.results.map((x) => x.reply.length).sort((a, b) => a - b);
  const row = (name: string, xs: number[]) => `| ${name} | ${xs[0]} | ${pct(xs, 0.5)} | ${pct(xs, 0.9)} | ${xs[xs.length - 1]} |`;
  const spokenMd = [
    '## Spoken summary (P3-05, ai.say.spokenText)',
    '',
    `${r.results.length} scored replies. Cap ${SPOKEN_MAX_CHARS} speech characters (numbers counted as the words they are read as). Over 10 s at 13 chars/s: **${sec13.filter((x) => x > 10).length}**.`,
    '',
    '| Measure | min | p50 | p90 | max |',
    '|---|---|---|---|---|',
    row('full reply text, chars', full),
    row('spoken text, chars', chars),
    row('spoken, speech chars', sp),
    row('spoken, est. s at 13 chars/s', sec13),
    row('spoken, est. s at 15 chars/s', sec15),
    '',
  ];
  const md = [
    `# Day-1 phrase harness — ${name}`,
    '',
    `Run ${new Date().toISOString()}, ${((Date.now() - t0) / 1000).toFixed(1)} s. Provider: ${llm.name} (${llm.model}). UE: in-process simulator.`,
    '',
    `**Pass rate: ${r.passed}/${r.total} (${Math.round((100 * r.passed) / r.total)}%)**`,
    '',
    '| Group | Pass |',
    '|---|---|',
    ...Object.entries(byGroup).map(([g, v]) => `| ${g} | ${v.pass}/${v.total} |`),
    '',
    '## Estimated cost of one full live run (setup + scored turns; not run)',
    '',
    `LLM calls made by the mock policy: ${r.meter.calls} (${r.meter.scoredCalls} in scored turns). Estimate uses ×1.3 calls for the live model.`,
    '',
    '| Model | Calls | Input tokens | Output tokens | USD, no cache | USD, system+tools cached |',
    '|---|---|---|---|---|---|',
    ...Object.entries(cost).map(([m, c]) => `| ${m} | ${c.calls} | ${c.inputTokens} | ${c.outputTokens} | $${c.usdNoCache} | $${c.usdCached} |`),
    '',
    'Prices: claude-sonnet-5-5 $2 / $10 per MTok (cache read $0.20), claude-haiku-4-5 $1 / $5 (cache read $0.10), from the claude-api skill 2026-09-30. Token counts are estimated from characters (no count_tokens call).',
    '',
    ...spokenMd,
    '## Results',
    '',
    '| Id | Phrase | Tools called | Pass | Why | Spoken (est. s at 13 chars/s) |',
    '|---|---|---|---|---|---|',
    ...r.results.map((x) => `| ${x.id} | ${x.text} | ${x.tools.join(', ') || '—'} | ${x.pass ? 'yes' : '**no**'} | ${x.why.join('; ')} | ${x.spoken.replace(/\|/g, '/')} (${estimateSpokenSeconds(x.spoken, 13)}) |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, `phrase_harness_${name}.md`), md, 'utf8');
  fs.writeFileSync(path.join(outDir, `phrase_harness_${name}.json`), JSON.stringify({ ...r, meter: undefined, calls: r.meter.calls, cost }, null, 1), 'utf8');
  console.log(`${name}: ${r.passed}/${r.total}`, JSON.stringify(cost));
  console.log(`spoken chars min/p50/p90/max ${chars[0]}/${pct(chars, 0.5)}/${pct(chars, 0.9)}/${chars[chars.length - 1]}; est. s @13 ${sec13[0]}/${pct(sec13, 0.5)}/${pct(sec13, 0.9)}/${sec13[sec13.length - 1]}; @15 max ${sec15[sec15.length - 1]}; over 10 s: ${sec13.filter((x) => x > 10).length}; full text chars p50/max ${pct(full, 0.5)}/${full[full.length - 1]}`);
  for (const x of r.results.filter((y) => !y.pass)) console.log('FAIL', x.id, x.text, '|', x.tools.join(','), '|', x.why.join('; '), '|', x.reply.slice(0, 120));
})();
