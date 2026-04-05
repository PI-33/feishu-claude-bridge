/**
 * Entry point for the Feishu-Claude Bridge v2 daemon.
 *
 * Assembles AppContext, resolves Claude CLI, starts FeishuClient,
 * runs the bridge loop, and handles graceful shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig, CTI_HOME } from './config.js';
import type { AppContext } from './types.js';
import { JsonFileStore } from './store.js';
import { ClaudeProvider, resolveClaudeCliPath, preflightCheck } from './claude-provider.js';
import { PendingPermissions } from './permissions.js';
import { FeishuClient } from './feishu.js';
import { setupLogger } from './logger.js';
import { runBridgeLoop } from './bridge.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[feishu-bridge] Starting (run_id: ${runId})`);

  // Validate Feishu config
  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.error('[feishu-bridge] FATAL: CTI_FEISHU_APP_ID and CTI_FEISHU_APP_SECRET must be set in config.env');
    process.exit(1);
  }

  // Resolve Claude CLI
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[feishu-bridge] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, PATH, well-known locations.\n' +
      '  Fix: Install Claude Code CLI >= 2.x or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude',
    );
    process.exit(1);
  }

  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[feishu-bridge] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[feishu-bridge] FATAL: Claude CLI preflight failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}`,
    );
    process.exit(1);
  }

  // Assemble AppContext
  const store = new JsonFileStore(config);
  const pendingPerms = new PendingPermissions();
  const provider = new ClaudeProvider(pendingPerms, cliPath, config.autoApprove);
  const feishu = new FeishuClient(config);

  const ctx: AppContext = {
    config,
    store,
    provider,
    permissions: pendingPerms,
    feishu,
  };

  // Start Feishu WebSocket
  await feishu.start();

  // Write PID and status
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  writeStatus({
    running: true,
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  });

  console.log(`[feishu-bridge] Bridge started (PID: ${process.pid})`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[feishu-bridge] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await feishu.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    console.error('[feishu-bridge] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[feishu-bridge] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });

  // Keep event loop alive
  setInterval(() => { /* keepalive */ }, 45_000);

  // Run bridge loop (blocks until feishu stops)
  await runBridgeLoop(ctx);
}

main().catch((err) => {
  console.error('[feishu-bridge] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
