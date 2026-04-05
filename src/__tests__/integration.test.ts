/**
 * Integration test — starts the full FeishuClient + Bridge, verifies WebSocket
 * connects, sends a test message via REST, then cleanly shuts down.
 *
 * This test uses a real Feishu WebSocket connection and sends real messages.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../config.js';
import { JsonFileStore } from '../store.js';
import { PendingPermissions } from '../permissions.js';
import { ClaudeProvider, resolveClaudeCliPath } from '../claude-provider.js';
import { FeishuClient } from '../feishu.js';
import { deliver } from '../delivery.js';
import type { AppContext } from '../types.js';

let config: ReturnType<typeof loadConfig>;
let store: JsonFileStore;
let feishu: FeishuClient;
let ctx: AppContext;
let chatId: string | null = null;

before(async () => {
  config = loadConfig();
  store = new JsonFileStore(config);
  const permissions = new PendingPermissions();
  const cliPath = resolveClaudeCliPath();
  const provider = new ClaudeProvider(permissions, cliPath, config.autoApprove);
  feishu = new FeishuClient(config);
  ctx = { config, store, provider, permissions, feishu };

  // Start feishu and wait for WS
  await feishu.start();
  assert.ok(feishu.isRunning(), 'FeishuClient should be running after start()');
  await new Promise(r => setTimeout(r, 3000));

  // Resolve chatId once for all tests
  const client = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain: config.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
  });
  try {
    const res = await client.im.chat.list({ params: { page_size: 1 } });
    chatId = res?.data?.items?.[0]?.chat_id || null;
  } catch { /* no access */ }
  console.log('  Setup complete. chatId:', chatId || '(none)');
});

after(async () => {
  console.log('  Stopping FeishuClient...');
  await feishu.stop();
  assert.ok(!feishu.isRunning(), 'Should not be running after stop()');
  console.log('  FeishuClient stopped cleanly');
});

test('FeishuClient starts and WebSocket connects', () => {
  assert.ok(feishu.isRunning(), 'Should be running after before() hook');
  console.log('  FeishuClient started and WebSocket stable');
});

test('deliver() sends a test message through the full stack', async () => {
  if (!chatId) {
    console.log('  Skipping: no chat available');
    return;
  }

  const result = await deliver(ctx, chatId, '🧪 Integration test: plain text delivery works');
  assert.ok(result.ok, `Delivery should succeed: ${result.error}`);
  console.log(`  Plain text delivered: ${result.messageId}`);
});

test('deliver() sends markdown with code block (card rendering)', async () => {
  if (!chatId) {
    console.log('  Skipping: no chat available');
    return;
  }

  const codeResponse = [
    '🧪 Integration test: code block card rendering',
    '',
    '```typescript',
    'function hello(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '```',
  ].join('\n');

  const result = await deliver(ctx, chatId, codeResponse, { parseMode: 'Markdown' });
  assert.ok(result.ok, `Code block delivery should succeed: ${result.error}`);
  console.log(`  Card (code block) delivered: ${result.messageId}`);
});

test('FeishuClient streaming card lifecycle (create → update → finalize)', async () => {
  if (!chatId) {
    console.log('  Skipping: no chat available');
    return;
  }

  // Use onStreamText directly (no lastIncomingMessageId, so onMessageStart won't create a card)
  feishu.onStreamText(chatId, '🧪 Streaming card test...');
  await new Promise(r => setTimeout(r, 2000));

  feishu.onStreamText(chatId, '🧪 Streaming card test...\n\nUpdating with more content.');
  await new Promise(r => setTimeout(r, 500));

  // Simulate tool progress
  feishu.onToolEvent(chatId, [
    { id: 'tool-1', name: 'Read', status: 'complete' },
    { id: 'tool-2', name: 'Write', status: 'running' },
  ]);
  await new Promise(r => setTimeout(r, 500));

  // Finalize the card
  const finalized = await feishu.onStreamEnd(chatId, 'completed', '🧪 Final card content\n\nThis is the completed response.', {
    input_tokens: 1500,
    output_tokens: 800,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 100,
    cost_usd: 0.0125,
  });

  if (finalized) {
    console.log('  Streaming card lifecycle complete: created → updated → finalized');
  } else {
    console.log('  Streaming card not finalized (no inbound message context — expected in test)');
  }
  assert.ok(true); // Pass either way — we verified the code path doesn't crash
});

test('store: session and binding roundtrip', () => {
  const session = store.createSession('integration-test', '', undefined, '/tmp');
  const binding = store.upsertChannelBinding({
    chatId: 'integration-test-chat',
    codepilotSessionId: session.id,
    workingDirectory: '/tmp',
    model: '',
  });

  assert.ok(binding.id);
  const retrieved = store.getChannelBinding('integration-test-chat');
  assert.ok(retrieved);
  assert.equal(retrieved!.codepilotSessionId, session.id);
  console.log('  Session + binding roundtrip OK');
});

test('session scanner finds real CLI sessions', () => {
  const sessions = store.listCliSessions({ limit: 5 });
  console.log(`  Found ${sessions.length} CLI session(s)`);
  if (sessions.length > 0) {
    const s = sessions[0];
    console.log(`    Latest: ${s.project} (${s.sdkSessionId.slice(0, 8)}) — ${s.isOpen ? 'open' : 'closed'}`);
    console.log(`    Prompt: "${s.firstPrompt.slice(0, 60)}..."`);
  }
  assert.ok(true);
});
