#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const ECHARTS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js';

function fail(message) {
  console.error(`algo-map-check: ${message}`);
  process.exitCode = 1;
}

function parseInlinedJson(page, id) {
  const pattern = new RegExp(
    `<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`,
    'i',
  );
  const match = page.match(pattern);
  if (!match) throw new Error(`missing inlined JSON script #${id}`);
  return JSON.parse(match[1]);
}

async function main() {
  const input = process.argv[2];
  if (!input || process.argv.length !== 3) {
    fail('usage: node scripts/algo-map-check.mjs <page.html>');
    return;
  }

  let page;
  try {
    page = await readFile(input, 'utf8');
  } catch (error) {
    fail(`cannot read ${input}: ${error.message}`);
    return;
  }

  const resourceUrls = [...page.matchAll(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)]
    .map(match => match[1]);
  if (resourceUrls.length !== 1 || resourceUrls[0] !== ECHARTS_URL) {
    fail(`expected exactly one external resource (${ECHARTS_URL}), found ${JSON.stringify(resourceUrls)}`);
  }

  const mermaidCount = (page.match(/<pre\b[^>]*class=["'][^"']*\bmermaid\b[^"']*["'][^>]*>/gi) || []).length;
  if (mermaidCount < 1) fail('expected at least one <pre class="mermaid"> block');

  let trace;
  try {
    trace = parseInlinedJson(page, 'trace-data');
    parseInlinedJson(page, 'rules-data');
  } catch (error) {
    fail(`inlined JSON does not parse: ${error.message}`);
    return;
  }

  const trades = Array.isArray(trace?.backtest?.trades) ? trace.backtest.trades : [];
  const expectedMarkers = trades.filter(trade => trade?.status === 'filled').length;
  const actualMarkers = (page.match(/\bdata-trade-marker(?:\s|=|>)/gi) || []).length;
  if (actualMarkers !== expectedMarkers) {
    fail(`trade marker count is ${actualMarkers}; expected ${expectedMarkers}`);
  }

  for (const name of ['thresholds', 'decisions', 'acceptance']) {
    const pattern = new RegExp(`\\bdata-table=["']${name}["']`, 'i');
    if (!pattern.test(page)) fail(`missing data-table="${name}"`);
  }
}

await main();
