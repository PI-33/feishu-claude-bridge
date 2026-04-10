/**
 * JSON file-backed data store.
 *
 * In-memory Maps with write-through persistence to JSON files in .bridge/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeSession,
  BridgeMessage,
  ChannelBinding,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  UpsertChannelBindingInput,
  CliSessionInfo,
} from './types.js';
import { scanCliSessions } from './session-scanner.js';
import { CTI_HOME } from './config.js';
import type { Config } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

export class JsonFileStore {
  private config: Config;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(config: Config) {
    this.config = config;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'), {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'), {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'), {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'), {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'), {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(path.join(DATA_DIR, 'sessions.json'), Object.fromEntries(this.sessions));
  }

  private persistBindings(): void {
    writeJson(path.join(DATA_DIR, 'bindings.json'), Object.fromEntries(this.bindings));
  }

  private persistPermissions(): void {
    writeJson(path.join(DATA_DIR, 'permissions.json'), Object.fromEntries(this.permissionLinks));
  }

  private persistOffsets(): void {
    writeJson(path.join(DATA_DIR, 'offsets.json'), Object.fromEntries(this.offsets));
  }

  private persistDedup(): void {
    writeJson(path.join(DATA_DIR, 'dedup.json'), Object.fromEntries(this.dedupKeys));
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`), [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Channel Bindings ──

  getChannelBinding(chatId: string): ChannelBinding | null {
    return this.bindings.get(`feishu:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `feishu:${data.chatId}`;
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.config.defaultMode as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(): ChannelBinding[] {
    return Array.from(this.bindings.values());
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.config.defaultWorkDir || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── CLI Session Discovery ──

  listCliSessions(opts?: { limit?: number }): CliSessionInfo[] {
    return scanCliSessions({ limit: opts?.limit ?? 20 });
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
