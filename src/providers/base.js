function bulletList(items = []) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- None';
}

function capabilityIds(entries = []) {
  return entries.map((entry) => entry.id);
}

export function buildTaskPrompt({ task, route, capabilities = {}, receiptPath }) {
  if (!task?.id || !task?.objective) throw new TypeError('task.id and task.objective are required');
  if (!receiptPath) throw new TypeError('receiptPath is required');

  return `# Bounded worker task\n\n` +
    `You are an execution worker selected by the root orchestrator. Do not delegate this task to another agent.\n` +
    `Do not broaden scope, choose a different model, or invoke unlisted capabilities.\n\n` +
    `## Task\n` +
    `- ID: ${task.id}\n` +
    `- Title: ${task.title ?? task.id}\n` +
    `- Objective: ${task.objective}\n` +
    `- Kind: ${task.kind}\n` +
    `- Role: ${task.role}\n` +
    `- Risk: ${task.risk}\n` +
    `- Complexity: ${task.complexity ?? 'standard'}\n` +
    `- Write access: ${task.write === true ? 'allowed within scope' : 'read-only'}\n\n` +
    `## Selected route\n` +
    `- Provider: ${route.provider}\n` +
    `- Model: ${route.model}\n` +
    `- Effort: ${route.effort}\n\n` +
    `## Allowed scope\n${bulletList(task.allowedScope)}\n\n` +
    `## Forbidden scope\n${bulletList(task.forbiddenScope)}\n\n` +
    `## Acceptance criteria\n${bulletList(task.acceptanceCriteria)}\n\n` +
    `## Capabilities\n` +
    `- Skills: ${capabilityIds(capabilities.skills).join(', ') || 'none'}\n` +
    `- Plugins: ${capabilityIds(capabilities.plugins).join(', ') || 'none'}\n` +
    `- Hooks: ${capabilityIds(capabilities.hooks).join(', ') || 'none'}\n\n` +
    `Before substantive work, invoke each listed skill through the provider's native skill mechanism. Use only listed plugins when their tools are needed. Listed hooks are pre-installed provider lifecycle policies; the wrapper exports their exact IDs through AORCH_SELECTED_HOOKS but does not hot-load arbitrary hooks. If a required capability is unavailable or inactive, return blocked rather than silently replacing it.\n\n` +
    `## Verification\n${bulletList(task.verificationCommands)}\n\n` +
    `## Evidence contract\n` +
    `Return a final JSON receipt matching the supplied schema; the wrapper will persist it to ${receiptPath}. Include status, files inspected, files changed, commands with exit codes, acceptance-criterion evidence, findings (an empty list unless the task asked you to rank findings), unresolved risks, and confidence.\n` +
    `filesChanged is checked for exact equality against the working-tree delta between the moment your task started and the moment you finish: list every path you or your verification commands changed during this task and nothing else. That includes the source path of any rename or move, every deleted path, and any file your verification commands create (build output, coverage, snapshots) unless it is gitignored. Do not list files that were already modified before your task started — git status may show them, but they are not your changes. If you changed nothing, filesChanged must be an empty array. Omitting or over-listing a path fails the change guard.\n` +
    `Never report success without fresh verification evidence.`;
}
