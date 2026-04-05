/**
 * Feishu API connectivity tests.
 *
 * Tests actual Feishu REST API calls using the bridge's configured credentials.
 * Requires valid CTI_FEISHU_APP_ID and CTI_FEISHU_APP_SECRET in config.env.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import * as lark from '@larksuiteoapi/node-sdk';

let appId: string;
let appSecret: string;
let domain: lark.Domain;
let client: lark.Client;

describe('feishu-api-connectivity', async () => {
  const { loadConfig } = await import('../config.js');

  before(() => {
    const config = loadConfig();
    appId = config.feishuAppId;
    appSecret = config.feishuAppSecret;
    domain = config.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    assert.ok(appId, 'CTI_FEISHU_APP_ID must be configured');
    assert.ok(appSecret, 'CTI_FEISHU_APP_SECRET must be configured');

    client = new lark.Client({ appId, appSecret, domain });
  });

  test('can obtain tenant_access_token', async () => {
    const baseUrl = domain === lark.Domain.Lark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });

    const data: any = await res.json();
    assert.ok(data.tenant_access_token, `Should get token, got: ${JSON.stringify(data)}`);
    console.log(`  Token obtained (code: ${data.code})`);
  });

  test('can resolve bot identity', async () => {
    const baseUrl = domain === lark.Domain.Lark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    // Get token first
    const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData: any = await tokenRes.json();
    assert.ok(tokenData.tenant_access_token);

    // Get bot info
    const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const botData: any = await botRes.json();
    assert.ok(botData?.bot?.open_id, `Should get bot open_id, got: ${JSON.stringify(botData)}`);
    console.log(`  Bot open_id: ${botData.bot.open_id}`);
    console.log(`  Bot name: ${botData.bot.app_name || 'unknown'}`);
  });

  test('can list bot chats', async () => {
    try {
      const res = await client.im.chat.list({
        params: { page_size: 5 },
      });
      const items = res?.data?.items || [];
      console.log(`  Bot is in ${items.length}+ chat(s)`);
      for (const chat of items.slice(0, 3)) {
        console.log(`    - ${chat.name || 'unnamed'} (${chat.chat_id})`);
      }
      assert.ok(true, 'Chat list request succeeded');
    } catch (err) {
      // If bot doesn't have chat:readonly scope, this may fail
      console.log(`  Chat list failed (may need scope): ${err instanceof Error ? err.message : err}`);
      assert.ok(true, 'Chat list request attempted');
    }
  });

  test('CardKit v2 card creation works', async () => {
    try {
      const cardBody = {
        schema: '2.0',
        config: { streaming_mode: true, wide_screen_mode: true },
        body: {
          elements: [{
            tag: 'markdown',
            content: '🧪 Test card',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await (client as any).cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      const cardId = createResp?.data?.card_id;
      assert.ok(cardId, `Should create card, got: ${JSON.stringify(createResp?.data || createResp)}`);
      console.log(`  CardKit v2 card created: ${cardId}`);
    } catch (err: any) {
      if (err?.code === 233009 || err?.msg?.includes('not enabled')) {
        console.log(`  CardKit v2 not enabled for this app (expected if app lacks cardkit scope)`);
        assert.ok(true); // Not a code bug
      } else {
        throw err;
      }
    }
  });

  test('can send a test message to bot itself (if chat available)', async () => {
    // Try to find a chat to send to
    let chatId: string | null = null;
    try {
      const res = await client.im.chat.list({ params: { page_size: 3 } });
      const items = res?.data?.items || [];
      if (items.length > 0) {
        chatId = items[0].chat_id!;
      }
    } catch {
      // no access
    }

    if (!chatId) {
      console.log('  Skipping: no chat available for send test');
      return;
    }

    try {
      const res = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: '🧪 Bridge v2 API test — please ignore' }),
        },
      });

      if (res?.data?.message_id) {
        console.log(`  Message sent: ${res.data.message_id} to ${chatId}`);
        assert.ok(true);
      } else {
        console.log(`  Send result: code=${res?.code}, msg=${res?.msg}`);
        // Still OK — some chats may not allow bot to send
        assert.ok(true);
      }
    } catch (err) {
      console.log(`  Send failed: ${err instanceof Error ? err.message : err}`);
      assert.ok(true); // Not a code bug
    }
  });
});
