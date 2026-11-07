import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The Cursor plugin (engine/cursor-plugin) follows cursor/plugins' plugin.json schema: kebab-case name, only the
 * schema's keys, paths relative and inside the plugin, declared components that exist. Its one MCP entry is the hosted
 * endpoint with no credential, and its skill names only tools the hosted server registers.
 */
const PLUGIN = path.join(__dirname, '../../cursor-plugin');
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.cursor-plugin/plugin.json'), 'utf8'));
// Tools are registered in server.ts and, since it was split, in one module each under src/mvp/tools/.
const MVP_DIR = path.join(__dirname, '../../src/mvp');
const SERVER_SRC = [path.join(MVP_DIR, 'server.ts'), ...fs.readdirSync(path.join(MVP_DIR, 'tools')).filter((f) => f.endsWith('.ts')).map((f) => path.join(MVP_DIR, 'tools', f))]
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const HOSTED_TOOLS = new Set([...SERVER_SRC.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]));

// HOSTED_TOOLS is read from the engine source (the hosted server's registry on main), not from the live endpoint.
// Every top-level key plugin.schema.json allows.
const SCHEMA_KEYS = new Set([
  'name', 'displayName', 'description', 'version', 'minClientVersions', 'author', 'publisher', 'homepage', 'repository',
  'license', 'logo', 'keywords', 'category', 'tags', 'commands', 'agents', 'skills', 'rules', 'hooks', 'variables',
  'mcpServers',
]);

describe('cursor plugin manifest', () => {
  it('uses only schema keys and a valid name and version', () => {
    expect(Object.keys(manifest).filter((k) => !SCHEMA_KEYS.has(k))).toEqual([]);
    expect(manifest.name).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(Object.keys(manifest.author)).toEqual(['name']);
  });

  it('declares only relative paths that exist inside the plugin', () => {
    for (const key of ['logo', 'skills', 'mcpServers']) {
      const rel: string = manifest[key];
      expect(path.isAbsolute(rel), key).toBe(false);
      expect(rel.split('/')).not.toContain('..');
      expect(fs.existsSync(path.join(PLUGIN, rel)), key).toBe(true);
    }
  });
});

describe('cursor plugin MCP entry', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'mcp.json'), 'utf8'));
  it('is the hosted endpoint with OAuth and no credential', () => {
    expect(mcp).toEqual({ mcpServers: { renor: { type: 'http', url: 'https://mcp.renor.cloud/mcp' } } });
  });
});

describe('cursor plugin skill', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills/renor-memory/SKILL.md'), 'utf8');
  it('has frontmatter with a name and a description', () => {
    expect(skill).toMatch(/^---\nname: renor-memory\ndescription: '.+'\n---\n/);
  });
  it('names only tools the hosted server has, and carries no token', () => {
    const start = skill.indexOf('The core tools, by their base names');
    const end = skill.indexOf('## When to use it');
    expect(start).toBeGreaterThan(-1);
    const named = skill.slice(start, end).split('\n').filter((l) => l.startsWith('- '))
      .flatMap((l) => [...l.matchAll(/^- `([a-z][a-z_]+)`|; `([a-z][a-z_]+)` —/g)].map((m) => m[1] ?? m[2]));
    expect(named).toContain('get_context');
    expect(named).toContain('remember');
    expect(named).toContain('whats_new');
    for (const tool of named) expect(HOSTED_TOOLS.has(tool), `${tool} is not a hosted tool`).toBe(true);
    expect(skill).not.toMatch(/Bearer|YOUR_RENOR_TOKEN|127\.0\.0\.1/);
  });
});
