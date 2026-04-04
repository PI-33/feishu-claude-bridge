# Contributing to Claude-to-IM

## Development Setup

```bash
npm install
npm run typecheck        # Type checking
npm run test:unit        # Unit tests
```

## Adding a New Adapter

1. Create `adapters/my-adapter.ts` extending `BaseChannelAdapter`
2. Implement all required methods (see `channel-adapter.ts`)
3. Call `registerAdapterFactory('my-channel', () => new MyAdapter())` at module scope
4. Add `import './my-adapter';` in `adapters/index.ts`
5. Add platform limit to `PLATFORM_LIMITS` in `types.ts`
6. Add rendering support in `bridge-manager.ts:deliverResponse()` (or use generic fallback)

## Code Style

- TypeScript strict mode
- Conventional commits: `feat(bridge):`, `fix(bridge):`, `test(bridge):`
- No direct imports from host application — always use `getBridgeContext()`
- Prefer `const { store } = getBridgeContext()` at function entry for clarity

## Testing

Tests use Node.js built-in test runner (`node:test`) with mock implementations of host interfaces.

```bash
# Run bridge tests only
node --test --import tsx src/__tests__/unit/bridge-*.test.ts
```

To test a new module:
1. Create `src/__tests__/unit/bridge-<module>.test.ts`
2. Build a mock `BridgeStore` (see existing tests for patterns)
3. Call `initBridgeContext()` with mocks in `beforeEach`
4. Clean up `globalThis['__bridge_context__']` between tests

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module dependency graph, message flows, and design decisions.
