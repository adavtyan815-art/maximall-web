// src/app.ts loads the AI layer lazily with require('./ai') (only when AI_ENABLED=1). Under vitest the sources are
// TypeScript, which CommonJS require cannot resolve, so the layer is preloaded here for app.ts to pick up.
import * as aiLayer from '../src/ai';

(globalThis as any).__MAXIMALL_AI_LAYER__ = aiLayer;
