/**
 * Post-Expo report for the brand (task 9).
 * Usage: npx tsx scripts/expo-report.ts [logDir] [outDir]
 * Defaults: data/ai_logs -> data/reports-out/expo_report.{json,md} (gitignored). Harness/dev/test sessions are excluded.
 */
import fs from 'fs';
import path from 'path';
import { buildReport, reportMarkdown } from '../src/ai/analytics/report';

const root = path.join(__dirname, '..');
const logDir = process.argv[2] ?? path.join(root, 'data', 'ai_logs');
const outDir = process.argv[3] ?? path.join(root, 'data', 'reports-out'); // gitignored runtime output
fs.mkdirSync(outDir, { recursive: true });
const r = buildReport(logDir, { leadsFile: path.join(root, 'data', 'dossiers', 'leads.jsonl'), exclude: /^(harness|dev|test):/ });
fs.writeFileSync(path.join(outDir, 'expo_report.json'), JSON.stringify(r, null, 1), 'utf8');
fs.writeFileSync(path.join(outDir, 'expo_report.md'), reportMarkdown(r), 'utf8');
console.log(JSON.stringify({ outDir, ...r.totals, funnel: r.funnel }, null, 1));
