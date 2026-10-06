import { CostLedger } from '../util/costLedger';
import { flag, hydrateProviderKeys } from '../util/env';
import { AnthropicLlm, LlmProvider } from './llm';
import { MockLlm } from './mockLlm';
import { ElevenLabsStt, ElevenLabsTts, MockStt, MockTts, SttProvider, TtsProvider } from './voice';
import { FalFluxRender, GeminiImageRender, HangingRender, MockRender, RenderProvider } from '../render/providers';
import { ElevenLabsRealtimeStt, MockStreamingStt, StreamingSttProvider } from './streamingStt';

export interface Providers {
  llm: LlmProvider;
  fallbackLlm: LlmProvider; // scripted policy, used after an LLM timeout/error
  stt: SttProvider;
  sttStream?: StreamingSttProvider;
  tts: TtsProvider;
  render: RenderProvider;
  renderFallback: RenderProvider | null;
  ledger: CostLedger;
  mock: { llm: boolean; stt: boolean; tts: boolean; render: boolean; renderFallback: boolean; renderHang?: boolean };
  keys: Record<string, boolean>;
}

/**
 * A real provider is used only when (1) its key exists in process.env or the Windows User scope and (2) paid calls are
 * approved with AI_PAID_CALLS_APPROVED=1 (coordinator approval; budget cap in the ledger). Otherwise the mock is used.
 * Force mocks with AI_FORCE_MOCK=1.
 */
export function createProviders(opts: { ledger?: CostLedger; skipWindowsEnv?: boolean } = {}): Providers {
  const keys = hydrateProviderKeys({ skipWindows: opts.skipWindowsEnv });
  const ledger = opts.ledger ?? new CostLedger();
  const paid = flag('AI_PAID_CALLS_APPROVED') && !flag('AI_FORCE_MOCK');
  const useLlm = paid && keys.ANTHROPIC_API_KEY;
  const useEl = paid && keys.ELEVENLABS_API_KEY;
  // Artur 2026-10-02: no paid AI renders until he approves the captures (P3-03); live LLM/voice tests run with this set.
  const paidRender = paid && !flag('AI_RENDER_FORCE_MOCK');
  const model = process.env.AI_LLM_MODEL ?? 'claude-sonnet-5-5';
  // TC-AI-06.2 test hook (LOCAL_MODE only): a render provider that never answers.
  const hang = process.env.LOCAL_MODE === '1' && flag('AI_RENDER_MOCK_HANG');
  if (hang) console.warn('[AI] AI_RENDER_MOCK_HANG=1 (LOCAL_MODE): photos never finish; the give-up path reports them failed.');
  return {
    llm: useLlm ? new AnthropicLlm(model, ledger) : new MockLlm(),
    fallbackLlm: new MockLlm(),
    stt: useEl ? new ElevenLabsStt(ledger) : new MockStt(),
    sttStream: useEl ? new ElevenLabsRealtimeStt(ledger) : new MockStreamingStt(),
    tts: useEl ? new ElevenLabsTts(ledger) : new MockTts(),
    render: hang ? new HangingRender() : paidRender && keys.FAL_KEY ? new FalFluxRender(ledger) : paidRender && keys.GEMINI_API_KEY ? new GeminiImageRender(ledger) : new MockRender(),
    renderFallback: hang ? null : paidRender && keys.FAL_KEY && keys.GEMINI_API_KEY ? new GeminiImageRender(ledger) : null,
    ledger,
    mock: { llm: !useLlm, stt: !useEl, tts: !useEl, render: hang || !(paidRender && keys.FAL_KEY), renderFallback: hang || !(paidRender && keys.GEMINI_API_KEY), ...(hang ? { renderHang: true } : {}) },
    keys,
  };
}
