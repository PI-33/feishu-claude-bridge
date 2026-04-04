/**
 * Unit tests for bridge channel-router.
 *
 * Tests the routing logic with a mock BridgeStore, verifying:
 * - resolve() creates new binding when none exists
 * - resolve() returns existing binding when session exists
 * - resolve() recreates binding when session was deleted
 * - createBinding() uses default settings
 * - bindToSession() validates session existence
 * - listBindings() delegates to store
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import * as router from '../../lib/bridge/channel-router';
import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

// ── Mock Store ──────────────────────────────────────────────

function createMockStore(): BridgeStore & { bindings: Map<string, ChannelBinding>; sessions: Map<string, { id: string; working_directory: string; model: string }> } {
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, { id: string; working_directory: string; model: string }>();
  let nextId = 1;

  return {
    bindings,
    sessions,
    getSetting(key: string) {
      if (key === 'bridge_default_work_dir') return '/tmp/test';
      if (key === 'bridge_default_model') return 'claude-3';
      if (key === 'bridge_default_provider_id') return '';
      return null;
    },
    getChannelBinding(channelType: string, chatId: string) {
      return bindings.get(`${channelType}:${chatId}`) ?? null;
    },
    upsertChannelBinding(data) {
      const binding: ChannelBinding = {
        id: `binding-${nextId++}`,
        channelType: data.channelType,
        chatId: data.chatId,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: 'code',
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      bindings.set(`${data.channelType}:${data.chatId}`, binding);
      return binding;
    },
    updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
      for (const [key, b] of bindings) {
        if (b.id === id) {
          bindings.set(key, { ...b, ...updates });
          break;
        }
      }
    },
    listChannelBindings(channelType?: string) {
      const all = Array.from(bindings.values());
      return channelType ? all.filter(b => b.channelType === channelType) : all;
    },
    getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    createSession(name: string, model: string, _systemPrompt?: string, cwd?: string) {
      const session = { id: `session-${nextId++}`, working_directory: cwd || '', model };
      sessions.set(session.id, session);
      return session;
    },
    updateSessionProviderId() {},
    addMessage() {},
    getMessages() { return { messages: [] }; },
    acquireSessionLock() { return true; },
    renewSessionLock() {},
    releaseSessionLock() {},
    setSessionRuntimeStatus() {},
    updateSdkSessionId() {},
    updateSessionModel() {},
    syncSdkTasks() {},
    getProvider() { return undefined; },
    getDefaultProviderId() { return null; },
    insertAuditLog() {},
    checkDedup() { return false; },
    insertDedup() {},
    cleanupExpiredDedup() {},
    insertOutboundRef() {},
    insertPermissionLink() {},
    getPermissionLink() { return null; },
    markPermissionLinkResolved() { return false; },
    listPendingPermissionLinksByChat() { return []; },
    getChannelOffset() { return '0'; },
    setChannelOffset() {},
  };
}

const noopLLM: LLMProvider = { streamChat: () => new ReadableStream() };
const noopPerms: PermissionGateway = { resolvePendingPermission: () => false };
const noopLifecycle: LifecycleHooks = {};

function setupContext(store: BridgeStore) {
  // Force re-initialization by clearing the global
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store,
    llm: noopLLM,
    permissions: noopPerms,
    lifecycle: noopLifecycle,
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('channel-router', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('resolve() creates new binding when none exists', () => {
    const binding = router.resolve({
      channelType: 'telegram',
      chatId: '123',
      displayName: 'Test User',
    });

    assert.ok(binding.id);
    assert.equal(binding.channelType, 'telegram');
    assert.equal(binding.chatId, '123');
    assert.equal(binding.workingDirectory, '/tmp/test');
    assert.equal(binding.model, 'claude-3');
    assert.equal(store.bindings.size, 1);
    assert.equal(store.sessions.size, 1);
  });

  it('resolve() returns existing binding when session exists', () => {
    // Create initial binding
    const first = router.resolve({ channelType: 'telegram', chatId: '123' });
    const second = router.resolve({ channelType: 'telegram', chatId: '123' });

    assert.equal(first.id, second.id);
    assert.equal(store.bindings.size, 1);
  });

  it('resolve() recreates binding when session was deleted', () => {
    const first = router.resolve({ channelType: 'telegram', chatId: '123' });
    // Delete the session
    store.sessions.delete(first.codepilotSessionId);

    const second = router.resolve({ channelType: 'telegram', chatId: '123' });
    assert.notEqual(first.codepilotSessionId, second.codepilotSessionId);
  });

  it('createBinding() uses custom working directory', () => {
    const binding = router.createBinding(
      { channelType: 'telegram', chatId: '456' },
      '/custom/path',
    );
    assert.equal(binding.workingDirectory, '/custom/path');
  });

  it('bindToSession() returns null for non-existent session', () => {
    const result = router.bindToSession(
      { channelType: 'telegram', chatId: '789' },
      'non-existent',
    );
    assert.equal(result, null);
  });

  it('bindToSession() binds to existing session', () => {
    const session = store.createSession('Test', 'claude-3', undefined, '/test');
    const binding = router.bindToSession(
      { channelType: 'telegram', chatId: '789' },
      session.id,
    );
    assert.ok(binding);
    assert.equal(binding!.codepilotSessionId, session.id);
  });

  it('listBindings() filters by channel type', () => {
    router.createBinding({ channelType: 'telegram', chatId: '1' });
    router.createBinding({ channelType: 'discord', chatId: '2' });
    router.createBinding({ channelType: 'telegram', chatId: '3' });

    const telegramBindings = router.listBindings('telegram');
    assert.equal(telegramBindings.length, 2);

    const allBindings = router.listBindings();
    assert.equal(allBindings.length, 3);
  });

  it('updateBinding() updates binding properties', () => {
    const binding = router.createBinding({ channelType: 'telegram', chatId: '1' });
    router.updateBinding(binding.id, { mode: 'plan' });

    const updated = store.bindings.get('telegram:1');
    assert.equal(updated?.mode, 'plan');
  });
});
