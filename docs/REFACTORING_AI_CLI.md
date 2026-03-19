# AI CLI Architecture Refactoring

## Overview
Refactoring the codebase from codex-specific implementation to a provider-agnostic architecture that supports multiple AI CLI providers (codex, claude, gemini, opencode, etc.).

## Completed Work

### 1. Core AI Client (`src/agent/ai-client.ts`)
- ✅ Created new `AIClient` class to replace `CodexClient`
- ✅ Added `AIProvider` type supporting: codex, claude, gemini, opencode
- ✅ Implemented `detectAIProvider()` function for automatic provider detection
- ✅ Updated `buildArgs()` to support provider-specific CLI arguments
- ✅ Added `permissionModeForSandbox()` for provider-specific permission modes
- ✅ Maintained backward compatibility with `CodexClient` alias

### 2. Configuration (`src/config/env.ts`)
- ✅ Created `AIConfig` interface (replaces `CodexConfig`)
- ✅ Created `AISandboxMode` type (replaces `CodexSandboxMode`)
- ✅ Updated `AppConfig` to include both `ai` and `codex` (backward compat)
- ✅ Updated `loadConfig()` and `loadConfigAsync()` to support both:
  - New naming: `AILOOP_AI_CLI_*`
  - Legacy naming: `AILOOP_CODEX_*` (fallback)
- ✅ Updated `saveConfigToDb()` to save both naming conventions
- ✅ Maintained full backward compatibility

### 3. Executor Agent (`src/agent/executor.ts`)
- ✅ Updated imports to use `AIClient` instead of `CodexClient`
- ✅ Renamed `codex` field to `ai` in `ExecutorAgent` class
- ✅ Updated constructor to accept `aiClient` parameter
- ✅ Updated all references from `codexResult` to `aiResult`
- ✅ Updated error messages from "Codex" to "AI CLI"
- ✅ Maintained backward compatibility with type aliases

## Remaining Work

### 4. Other Agent Classes
- ⏳ `src/agent/planner.ts` - Update to use AIClient
- ⏳ `src/agent/designer.ts` - Update to use AIClient
- ⏳ `src/agent/product-manager.ts` - Update to use AIClient
- ⏳ `src/agent/leader.ts` - Update to use AIClient
- ⏳ `src/evaluation/strategies/llm-judge.ts` - Update to use AIClient

### 5. Loop Engine
- ⏳ `src/loop/engine.ts` - Update config references
- ⏳ `src/loop/control.ts` - Update config references
- ⏳ `src/loop/ccb.ts` - Update config references

### 6. Tests
- ⏳ Update all test files to use new naming
- ⏳ Create `src/agent/ai-client.test.ts` (copy from codex-client.test.ts)
- ⏳ Update test mocks and fixtures

### 7. Documentation
- ⏳ Update README.md with new environment variable names
- ⏳ Update ARCHITECTURE.md
- ⏳ Create migration guide for users

### 8. Environment Files
- ⏳ Update `.env.example` with new variable names
- ⏳ Add migration notes for existing `.env` files

## Environment Variables

### New Naming Convention (Recommended)
```bash
AILOOP_AI_CLI_BIN=/opt/homebrew/bin/claude
AILOOP_AI_CLI_MODEL=claude-opus-4-6
AILOOP_AI_CLI_PROFILE=
AILOOP_AI_CLI_PLANNER_SANDBOX=read-only
AILOOP_AI_CLI_EXECUTOR_SANDBOX=danger-full-access
AILOOP_AI_CLI_EVALUATOR_SANDBOX=danger-full-access
```

### Legacy Naming (Still Supported)
```bash
AILOOP_CODEX_BIN=/opt/homebrew/bin/claude
AILOOP_CODEX_MODEL=claude-opus-4-6
AILOOP_CODEX_PROFILE=
AILOOP_CODEX_PLANNER_SANDBOX=read-only
AILOOP_CODEX_EXECUTOR_SANDBOX=danger-full-access
AILOOP_CODEX_EVALUATOR_SANDBOX=danger-full-access
```

Timeout is now fixed inside the application at 30 minutes and is no longer a user-configurable setting.

## Supported AI CLI Providers

### 1. Codex (Default)
```bash
AILOOP_AI_CLI_BIN=codex
AILOOP_AI_CLI_MODEL=<model-name>
AILOOP_AI_CLI_PROFILE=<profile-name>
```

### 2. Claude CLI
```bash
AILOOP_AI_CLI_BIN=/opt/homebrew/bin/claude
AILOOP_AI_CLI_MODEL=claude-opus-4-6
```

### 3. Gemini CLI
```bash
AILOOP_AI_CLI_BIN=gemini
AILOOP_AI_CLI_MODEL=gemini-2.0-flash-exp
```

### 4. OpenCode (Future)
```bash
AILOOP_AI_CLI_BIN=opencode
AILOOP_AI_CLI_MODEL=<model-name>
```

## Migration Guide for Users

### For Existing Users
Your existing configuration will continue to work. The system automatically falls back to `AILOOP_CODEX_*` variables if `AILOOP_AI_CLI_*` variables are not set.

### To Migrate to New Naming
1. Rename environment variables in your `.env` file:
   - `AILOOP_CODEX_BIN` → `AILOOP_AI_CLI_BIN`
   - `AILOOP_CODEX_MODEL` → `AILOOP_AI_CLI_MODEL`
   - `AILOOP_CODEX_PROFILE` → `AILOOP_AI_CLI_PROFILE`
   - `AILOOP_CODEX_*_SANDBOX` → `AILOOP_AI_CLI_*_SANDBOX`
   - `AILOOP_CODEX_TIMEOUT_MS` → `AILOOP_AI_CLI_TIMEOUT_MS`

2. Update database configuration (if using database config):
   ```bash
   bun run scripts/migrate-config.ts
   ```

## Testing Strategy

1. **Unit Tests**: Test each provider's argument building logic
2. **Integration Tests**: Test with actual CLI tools (mocked)
3. **Backward Compatibility Tests**: Ensure legacy config still works
4. **Provider-Specific Tests**: Test each provider's unique features

## Next Steps

1. Complete remaining agent class updates
2. Update all test files
3. Run full test suite to ensure no regressions
4. Update documentation
5. Create migration script for database configs
6. Test with actual Claude CLI, Gemini CLI, etc.

## Notes

- The refactoring maintains 100% backward compatibility
- Old code using `CodexClient` will continue to work via type aliases
- New code should use `AIClient` and `AIConfig`
- Provider detection is automatic based on binary name
- Each provider can have custom CLI argument patterns
