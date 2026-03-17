# API Connection Issues Troubleshooting

## Problem: 502 Bad Gateway Errors

### Symptoms
- ProjectPlanner, Executor, or Evaluator timeout after 20 minutes
- Logs show: `Reconnecting... X/5 (unexpected status 502 Bad Gateway: error code: 502, url: https://vpsairobot.com/responses)`
- AILoop enters crash recovery state

### Root Cause
The configured API proxy server's upstream service is unavailable or unstable.

**Current Configuration:**
- `ANTHROPIC_BASE_URL=http://cc.bawangai.xyz`
- Upstream: `https://vpsairobot.com/responses`

### Solutions

#### Option 1: Wait for Proxy Recovery (Temporary)
If the proxy service is temporarily down, wait for it to recover and restart AILoop.

#### Option 2: Switch to Official Anthropic API (Recommended)
```bash
# Remove proxy configuration
unset ANTHROPIC_BASE_URL

# Set official API key
export ANTHROPIC_API_KEY="your-anthropic-api-key"

# Restart AILoop
bun run scripts/ailoop.ts run
```

#### Option 3: Use Alternative Proxy
If you have access to another API proxy:
```bash
export ANTHROPIC_BASE_URL="https://your-alternative-proxy.com"
export ANTHROPIC_AUTH_TOKEN="your-proxy-token"
```

### Prevention

#### Reduce Timeout Duration
The default 20-minute timeout is too long. Reduce it to fail faster:

```bash
# In .env file
AILOOP_CODEX_TIMEOUT_MS=180000  # 3 minutes instead of 20
```

#### Add Health Checks
Before starting AILoop, verify API connectivity:

```bash
# Test Codex connection
timeout 30 codex exec --ephemeral "test" 2>&1 | grep -q "502" && echo "API unavailable" || echo "API OK"
```

### Related Issues
- [Issue #1] Stop button unresponsive during API timeout
- [Issue #2] Leader network error handling

### Fixed in Commit
- `6573d22` - Added network error detection and clean exit
