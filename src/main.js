import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, runReview } from './review.js';
import { piReview } from './pi-review.js';

const file = process.argv[2];
if (!file) { console.error('Usage: npm start -- <config.json> [--once]'); process.exit(1); }
const config = await loadConfig(path.resolve(file));
const root = path.resolve('.praxis/runs');
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
do {
  try {
    const report = await runReview(config, root, piReview);
    console.log(JSON.stringify({ business: config.id, status: report.status, findings: report.findings.length, report: path.join(root, config.id, 'latest.json') }));
  } catch (error) { console.error(error.message); if (process.argv.includes('--once')) process.exitCode = 1; }
  if (process.argv.includes('--once') || stop.signal.aborted) break;
  await delay(config.intervalSeconds * 1000, undefined, { signal: stop.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
} while (!stop.signal.aborted);
