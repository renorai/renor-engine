import type { ToolContext } from './setup.js';
import { DIRECTORY_HIDDEN_TOOLS, DIRECTORY_DESCRIPTIONS } from '../directorySurface.js';
import { checkProfileTools, LINE_TOOLS, renderLines } from '../contextProfile.js';
import { mapInvalidParams } from '../../mcp/requestErrors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderToon } from '../toonResponse.js';
import { refusalResult, CallExtra, isDashboardCall, isDirectoryCall, OWNER_ONLY_TOOLS, HIVE_TOOLS, registeredToolEntry } from './shared.js';

/**
 * Once every tool is registered: hides what a directory client or a tool profile does not get, and installs the tools/list and
 * tools/call wrappers (the owner-only tools, directory descriptions, the profile's descriptions and reply shape).
 */
export function finishToolSurface(ctx: ToolContext): void {
  const { config, directory, profile, server } = ctx;
  // Nor the tools directorySurface.ts keeps from a directory client: disabled the same way, once every one of them is registered.
  if (directory) for (const name of DIRECTORY_HIDDEN_TOOLS) registeredToolEntry(server, name).enabled = false;

  // The profile's tool subset: the others are disabled in the SDK's registry, so neither listed nor run.
  if (profile.tools || profile.descriptions) {
    const registered = Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {});
    checkProfileTools(profile, registered);
    if (profile.tools) for (const name of registered) if (!profile.tools.has(name)) registeredToolEntry(server, name).enabled = false;
  }

  // Every tool is registered above; the SDK's own handlers (initialize included) are mapped in the same pass.
  mapInvalidParams(server.server);
  // Layer 1 above: the owner-only tool is in the answer only when this request carries the mark. It is decided on the answer, after the
  // SDK and whatever wraps it have built the list: a flag flipped around this call would be put back before PostHog's listing wrapper,
  // which awaits first, reached the SDK. The hive tools leave the answer the same way for a directory client.
  const listHandlers = (server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: CallExtra) => unknown>;
  })._requestHandlers;
  const listTools = listHandlers.get('tools/list');
  if (!listTools) throw new Error('tools/list handler missing');
  listHandlers.set('tools/list', async (request, extra) => {
    const answer = await listTools(request, extra) as { tools?: Array<{ name?: unknown; description?: unknown }> };
    const headers = extra?.requestInfo?.headers;
    const forDirectory = directory || isDirectoryCall(headers, config);
    const hidden = new Set<unknown>();
    if (!isDashboardCall(headers, config)) for (const name of OWNER_ONLY_TOOLS) hidden.add(name);
    if (forDirectory) for (const name of [...HIVE_TOOLS, ...DIRECTORY_HIDDEN_TOOLS]) hidden.add(name);
    if (hidden.size === 0 && !forDirectory && !profile.descriptions) return answer;
    // An answer this cannot read is not passed on unfiltered.
    if (!Array.isArray(answer?.tools)) throw new Error('tools/list answered without a tools array');
    const tools = answer.tools.filter((tool) => !hidden.has(tool.name));
    // A directory client reads descriptions that say what a tool does, with no instruction to the model (directorySurface.ts).
    return {
      ...answer,
      tools: forDirectory
        ? tools.map((tool) => {
          const description = typeof tool.name === 'string' ? DIRECTORY_DESCRIPTIONS[tool.name] : undefined;
          return description ? { ...tool, description } : tool;
        })
        : profile.descriptions
          ? tools.map((tool) => {
            const name = typeof tool.name === 'string' ? tool.name : '';
            let own = profile.descriptions![name];
            if (own && name === 'remember' && typeof tool.description === 'string') {
              const at = tool.description.indexOf('Save something to memory:');
              if (at > 0 && own.startsWith('Save something to memory:')) own = tool.description.slice(0, at) + own;
            }
            const args = profile.argDescriptions?.[name];
            const schema = tool as { inputSchema?: { properties?: Record<string, { description?: string }> } };
            const props = schema.inputSchema?.properties;
            const inputSchema = args && props
              ? { ...schema.inputSchema, properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, args[k] ? { ...v, description: args[k] } : v])) }
              : undefined;
            if (!own && !inputSchema) return tool;
            return { ...tool, ...(own ? { description: own } : {}), ...(inputSchema ? { inputSchema } : {}) };
          })
          : tools,
    };
  });
  // The profile's reply shape: a read's text block as lines (renderLines); structuredContent, where there is one, is unchanged.
  if (profile.response === 'lines') {
    const callTool = listHandlers.get('tools/call');
    if (!callTool) throw new Error('tools/call handler missing');
    listHandlers.set('tools/call', async (request, extra) => {
      const result = await callTool(request, extra) as CallToolResult;
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (typeof name !== 'string' || !LINE_TOOLS.has(name) || result?.isError || !Array.isArray(result?.content)) return result;
      return { ...result, content: result.content.map((c, i) => (i === 0 && c.type === 'text' ? { ...c, text: renderLines(c.text) } : c)) };
    });
  } else if (profile.response === 'toon') {
    const callTool = listHandlers.get('tools/call');
    if (!callTool) throw new Error('tools/call handler missing');
    listHandlers.set('tools/call', async (request, extra) => {
      const result = await callTool(request, extra) as CallToolResult;
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (name !== 'search_memory' || result?.isError || result.content?.[0]?.type !== 'text') return result;
      try {
        const text = await renderToon(result.content[0].text);
        return { ...result, content: [{ ...result.content[0], text }, ...result.content.slice(1)] };
      } catch {
        return refusalResult({
          ok: false, error: 'toon-encoding-unsupported',
          note: 'This reply cannot be safely encoded as TOON. Use the default JSON response profile.',
        });
      }
    });
  }
}
