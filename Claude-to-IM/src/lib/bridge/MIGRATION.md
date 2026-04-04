# Migration Guide

## Migrating from Direct Imports to DI Context

### Before (coupled to host)

```typescript
import { getSetting, insertAuditLog } from '../db';
import { streamClaude } from '../claude-client';
import type { FileAttachment } from '@/types';

const setting = getSetting('my_key');
```

### After (host-agnostic)

```typescript
import { getBridgeContext } from './context';
import type { FileAttachment } from './types'; // or './host'

const { store } = getBridgeContext();
const setting = store.getSetting('my_key');
```

## Key Changes

| Before | After |
|--------|-------|
| `import { getSetting } from '../db'` | `getBridgeContext().store.getSetting(...)` |
| `import { streamClaude } from '../claude-client'` | `getBridgeContext().llm.streamChat(...)` |
| `import { resolvePendingPermission } from '../permission-registry'` | `getBridgeContext().permissions.resolvePendingPermission(...)` |
| `import { setBridgeModeActive } from '../telegram-bot'` | `getBridgeContext().lifecycle.onBridgeStart()` |
| `import type { FileAttachment } from '@/types'` | `import type { FileAttachment } from './types'` |

## Initializing the Context

The host application must call `initBridgeContext()` before any bridge module is used:

```typescript
import { initBridgeContext } from './context';

initBridgeContext({
  store: myStore,
  llm: myLLMProvider,
  permissions: myPermissionGateway,
  lifecycle: myLifecycleHooks,
});
```

For CodePilot, use the provided adapter:

```typescript
import { initCodePilotBridge } from './hosts/codepilot';
initCodePilotBridge(); // idempotent
```

## Implementing Host Interfaces

See `host.ts` for all interface definitions. The minimal implementation requires:

1. **BridgeStore**: ~30 methods covering settings, sessions, messages, bindings, audit, dedup, permissions, offsets
2. **LLMProvider**: Single `streamChat()` method returning SSE-formatted ReadableStream
3. **PermissionGateway**: Single `resolvePendingPermission()` method
4. **LifecycleHooks**: Optional `onBridgeStart()`/`onBridgeStop()` callbacks

Reference implementation: `hosts/codepilot.ts`
