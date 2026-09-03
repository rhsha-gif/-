#!/usr/bin/env node
// Gate for a manager-map output directory: gaps.json shape and index.html invariants.
// Usage: node scripts/manager-map-check.mjs <output-dir>
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const failures = [];
if (!dir) {
  console.error('usage: node scripts/manager-map-check.mjs <output-dir>');
  process.exit(2);
}

const LEVELS = new Set(['low', 'standard', 'high', 'critical']);
const AXES = new Set(['overengineering', 'correctness', 'usage']);
const FIELDS = ['id', 'severity', 'fixCost', 'axis', 'location', 'evidence', 'proposal'];
const LOCATION = /^(.+:\d+|.+#.+)$/;
const STEP_KEYWORDS = ['게이트', '전략', '동기화', '신호', '제안', '제출', '보고'];

const gapsPath = join(dir, 'gaps.json');
if (!existsSync(gapsPath)) failures.push('gaps.json missing');
else {
  let gaps;
  try { gaps = JSON.parse(readFileSync(gapsPath, 'utf8')); } catch (e) { failures.push(`gaps.json unparsable: ${e.message}`); }
  if (gaps !== undefined) {
    if (!Array.isArray(gaps)) failures.push('gaps.json must be an array');
    else gaps.forEach((gap, i) => {
      for (const f of FIELDS) if (typeof gap?.[f] !== 'string' || !gap[f].trim()) failures.push(`gaps[${i}] missing ${f}`);
      if (!LEVELS.has(gap?.severity)) failures.push(`gaps[${i}] bad severity ${gap?.severity}`);
      if (!LEVELS.has(gap?.fixCost)) failures.push(`gaps[${i}] bad fixCost ${gap?.fixCost}`);
      if (!AXES.has(gap?.axis)) failures.push(`gaps[${i}] bad axis ${gap?.axis}`);
      if (typeof gap?.location === 'string' && !LOCATION.test(gap.location)) failures.push(`gaps[${i}] location must be file:line or doc#section (${gap.location})`);
    });
  }
}

const htmlPath = join(dir, 'index.html');
if (!existsSync(htmlPath)) failures.push('index.html missing');
else {
  const html = readFileSync(htmlPath, 'utf8');
  const mermaidBlocks = (html.match(/<pre class="mermaid">/g) || []).length;
  if (mermaidBlocks < 1) failures.push('index.html has no <pre class="mermaid"> block');
  const urls = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
  if (urls.length) failures.push(`index.html references external URLs: ${[...new Set(urls)].slice(0, 5).join(', ')}`);
  for (const kw of STEP_KEYWORDS) if (!html.includes(kw)) failures.push(`index.html lacks runbook step keyword "${kw}"`);
  if (!html.includes('data-kind="fact"')) failures.push('index.html has no data-kind="fact" badge');
  if (!html.includes('data-kind="judgement"')) failures.push('index.html has no data-kind="judgement" badge');
  if (/<!doctype|<html[\s>]|<body[\s>]/i.test(html)) failures.push('index.html must be an artifact body (no doctype/html/body wrappers)');
}

if (failures.length) {
  console.error(`manager-map check FAILED (${failures.length})`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log(`manager-map check OK: ${dir}`);
