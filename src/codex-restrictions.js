import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A read-only sandbox does not prohibit computation through a shell.
// These profiles use the file MCP for evidence and omit executable tools.
export const NO_SHELL_FEATURES = Object.freeze({
  shell_tool: false, unified_exec: false, multi_agent: false, multi_agent_v2: false,
  code_mode: false, code_mode_only: false,
  hooks: false, plugins: false, remote_plugin: false,
  apps: false, browser_use: false, computer_use: false
});

export function readonlyFilesServer(root, packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  return { command: process.execPath, args: [path.join(packageRoot, 'src', 'readonly-files-mcp.js'), '--root', path.resolve(root)] };
}

export function noShellSettings(settings = {}) {
  return settings.features?.shell_tool === false;
}
