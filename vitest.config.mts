import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['test/setup.ts'],
    // QA-090 (paid test 2026-10-01): `.env` now holds live keys + AI_PAID_CALLS_APPROVED, and dotenv loads it in tests;
    // a plain run made 8 live ElevenLabs calls. Tests always use mocks and never write the real spend ledger.
    // AI_ENABLED=1: the suite tests the AI layer through the real app; test/ai_disabled.test.ts covers the default (off).
    env: { AI_SKIP_WINDOWS_ENV: '1', LOCAL_MODE: '1', AI_FORCE_MOCK: '1', AI_ENABLED: '1', AI_SPEND_LOG: path.join(os.tmpdir(), 'vitest_api_spend.jsonl') },
  },
});
