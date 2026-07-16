import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGateContext, classifyPrompt } from '../src/gate.js';

test('thin gate classifies read-only prompts without forcing a durable run', () => {
  const result = classifyPrompt('Explain what this function does and do not edit files.');
  assert.equal(result.requestClass, 'read-only');
  assert.equal(result.riskHint, 'low');
  assert.equal(result.failPolicy, 'open');
  assert.equal(result.requiresOrchestration, true);
});

test('thin gate classifies ordinary development and high-risk prompts conservatively', () => {
  const ordinary = classifyPrompt('Fix the failing parser test and update the implementation.');
  assert.equal(ordinary.requestClass, 'development');
  assert.equal(ordinary.riskHint, 'standard');
  assert.equal(ordinary.failPolicy, 'closed');

  const critical = classifyPrompt('Change production trading risk limits and deploy the database migration.');
  assert.equal(critical.requestClass, 'high-risk');
  assert.equal(critical.riskHint, 'critical');
  assert.equal(critical.failPolicy, 'closed');
});

test('high-risk subject matter stays read-only when no mutation or external action is requested', () => {
  const result = classifyPrompt('Explain how authentication and production database migrations work. Do not edit files.');
  assert.equal(result.requestClass, 'read-only');
  assert.equal(result.riskHint, 'low');
  assert.equal(result.failPolicy, 'open');
  assert.equal(result.durableRunRecommended, false);
});

test('destructive prompts without a development verb still classify as high-risk', () => {
  for (const prompt of [
    'drop the users table in production',
    'truncate all order data',
    '운영 데이터베이스에서 주문 데이터를 전부 삭제해'
  ]) {
    const result = classifyPrompt(prompt);
    assert.equal(result.requestClass, 'high-risk', prompt);
    assert.equal(result.failPolicy, 'closed', prompt);
  }
});

test('korean prompts classify without relying on ascii word boundaries', () => {
  assert.equal(classifyPrompt('결제 재시도 로직을 구현해줘').requestClass, 'high-risk');
  assert.equal(classifyPrompt('파서 테스트를 고쳐줘').requestClass, 'development');
  assert.equal(classifyPrompt('데이터베이스 스키마를 설명해줘').requestClass, 'read-only');
  assert.equal(classifyPrompt('파일을 수정하지 마: 이 모듈 요약해줘').requestClass, 'read-only');
});

test('thin gate context injects only bounded policy and defers heavy orchestration', () => {
  const context = buildGateContext(classifyPrompt('Implement a new endpoint.'));
  assert.match(context, /adaptive-orchestrate/i);
  assert.match(context, /decomposition.*outside this hook/i);
  assert.match(context, /provider.*model.*reasoning effort.*skills.*hooks.*plugins/i);
  assert.doesNotMatch(context, /prior reviewed runs/i);
  assert.ok(context.length < 2200);
});
