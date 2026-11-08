import { describe, it, expect } from 'vitest';
import { named, startWorkspace } from '../helpers/hiveHarness';
import { HTTP_SERVER_UNSUPPORTED } from '../helpers/httpServerPlatform';

// The default transport is JSON mode (MVP_MCP_JSON=true). Each POST /mcp gets its own McpServer and transport,
// so overlapping requests from one client must not collide. A shared server answered the second one with
// "Already connected to a transport" and HTTP 500, which lost the write.
describe.skipIf(HTTP_SERVER_UNSUPPORTED)('default HTTP transport (JSON mode)', () => {
  it('parallel_writes_on_default_http_mode — N parallel writes on the default (JSON) HTTP transport all succeed', async () => {
    const ws = await startWorkspace({});                       // MVP_MCP_JSON=true is the engine default
    try {
      const client = await ws.connect(named('alpha'));
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        ws.call(client, 'remember', { statement: `parallel write ${i}` }).then(
          r => (r.isError ? 'tool error' : 'ok'),
          (e: Error) => e.message)));
      expect(results.filter(r => r !== 'ok')).toEqual([]);
    } finally { await ws.close(); }
  }, 120_000);
});
