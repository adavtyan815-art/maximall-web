import Anthropic from '@anthropic-ai/sdk';
import { CostLedger, anthropicCostUsd } from '../util/costLedger';

export type LlmMessage = Anthropic.MessageParam;
export type LlmTool = Anthropic.Tool;
export type LlmContent = Anthropic.ContentBlock;

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  sessionId?: string;
  maxTokens?: number;
}
export interface LlmResponse {
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: any } | { type: string; [k: string]: any }>;
  stopReason: string | null;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  costUsd?: number;
  model: string;
}

export interface LlmProvider {
  readonly name: string; // 'anthropic' | 'mock'
  readonly model: string;
  readonly mock: boolean;
  create(req: LlmRequest): Promise<LlmResponse>;
}

/** Rough pre-call estimate so the ledger can refuse before spending. ~4 chars per token for Russian+JSON is conservative. */
export function estimateAnthropicCostUsd(model: string, req: LlmRequest): number {
  const chars = req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools).length;
  const inTok = Math.ceil(chars / 3);
  return anthropicCostUsd(model, { input_tokens: inTok, output_tokens: req.maxTokens ?? 1024 });
}

/**
 * Anthropic Messages API with client tools. Request shapes verified 2026-09-30 against the claude-api skill
 * (shared/model-migration.md "New API features" and "Migrating to Claude Sonnet 5.5") and the installed SDK typings:
 * - claude-sonnet-5-5: adaptive thinking (default; not sent), `output_config: { effort: 'low' }` (GA, no beta),
 *   `tool_choice: auto` (forced any/tool returns 400 on this model), server-side refusal fallback
 *   `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01` (Claude API only; retries cyber / frontier_llm
 *   declines on Claude Sonnet 5; `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'` in the SDK).
 * - claude-haiku-4-5: no `output_config.effort` (effort errors on Haiku 4.5), no thinking, no fallbacks.
 * - A final `stop_reason: 'refusal'` is surfaced as an error so the orchestrator continues with the scripted policy.
 * The system prompt (with the catalogue summary) carries a cache_control breakpoint.
 */
export function buildAnthropicRequest(model: string, req: LlmRequest) {
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  const maxTokens = req.maxTokens ?? 4096; // short spoken replies; adaptive thinking at low effort shares this budget
  if (model.startsWith('claude-sonnet-5-5')) {
    const p: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: system as Anthropic.Beta.Messages.BetaTextBlockParam[],
      messages: req.messages as Anthropic.Beta.Messages.BetaMessageParam[],
      tools: req.tools as Anthropic.Beta.Messages.BetaTool[],
      tool_choice: { type: 'auto' },
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    return { beta: true as const, params: p };
  }
  const p: Anthropic.MessageCreateParamsNonStreaming = { model, max_tokens: maxTokens, system, messages: req.messages, tools: req.tools, tool_choice: { type: 'auto' } };
  return { beta: false as const, params: p };
}

export class LlmRefusalError extends Error {
  constructor(public category: string | null) {
    super(`LLM refusal${category ? ` (${category})` : ''}`);
  }
}

export class AnthropicLlm implements LlmProvider {
  readonly name = 'anthropic';
  readonly mock = false;
  private client: Anthropic;
  constructor(public readonly model: string, private ledger: CostLedger, opts: { apiKey?: string; timeoutMs?: number } = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY, timeout: opts.timeoutMs ?? 20000, maxRetries: 1 });
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    const est = estimateAnthropicCostUsd(this.model, req);
    const r = this.ledger.reserve('anthropic', `messages.create ${this.model}`, est, req.sessionId);
    try {
      const built = buildAnthropicRequest(this.model, req);
      const msg: any = built.beta ? await this.client.beta.messages.create(built.params) : await this.client.messages.create(built.params);
      const cost = anthropicCostUsd(msg.model ?? this.model, msg.usage ?? {});
      r.settle(cost, true);
      if (msg.stop_reason === 'refusal') throw new LlmRefusalError(msg.stop_details?.category ?? null);
      return { content: msg.content, stopReason: msg.stop_reason, usage: msg.usage, costUsd: cost, model: msg.model ?? this.model };
    } catch (e) {
      if (!(e instanceof LlmRefusalError)) r.settle(est, false);
      throw e;
    }
  }
}
