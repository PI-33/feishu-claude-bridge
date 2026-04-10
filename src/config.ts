/**
 * Configuration loader.
 *
 * Reads ./config.env from the project root directory.
 * Runtime data (sessions, logs, PID files) lives in .bridge/ under the project root.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: string;
  feishuAllowedUsers?: string[];
  feishuRequireMention: boolean;
  autoApprove: boolean;
}

/**
 * Project root — launchd sets WorkingDirectory to the project dir,
 * and `npm run dev` also runs from the project dir, so cwd() is reliable.
 */
const PROJECT_DIR = process.cwd();

/** All data lives under the project directory by default. Override with CTI_HOME env var. */
export const CTI_HOME = process.env.CTI_HOME || path.join(PROJECT_DIR, '.bridge');
export const CONFIG_PATH = path.join(PROJECT_DIR, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  return {
    defaultWorkDir: env.get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    defaultModel: env.get('CTI_DEFAULT_MODEL') || undefined,
    defaultMode: env.get('CTI_DEFAULT_MODE') || 'code',
    feishuAppId: env.get('CTI_FEISHU_APP_ID') || '',
    feishuAppSecret: env.get('CTI_FEISHU_APP_SECRET') || '',
    feishuDomain: env.get('CTI_FEISHU_DOMAIN') || 'feishu',
    feishuAllowedUsers: splitCsv(env.get('CTI_FEISHU_ALLOWED_USERS')),
    feishuRequireMention: env.has('CTI_FEISHU_REQUIRE_MENTION')
      ? env.get('CTI_FEISHU_REQUIRE_MENTION') !== 'false'
      : true,
    autoApprove: env.get('CTI_AUTO_APPROVE') === 'true',
  };
}
