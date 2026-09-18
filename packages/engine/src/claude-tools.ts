import { assertReadAccess, CLAUDE_SUBAGENT_TOOLS, type AgentRequest } from './contracts.js';
import { EngineError } from './error.js';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WITHHELD_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'Skill', 'ToolSearch'];

/** Bound Claude's available tools separately from permission approval. */
export function claudeToolOptions(
  request: Pick<AgentRequest, 'tools' | 'allowedTools' | 'workspaceMode' | 'leaf'>,
): { tools: string[] | undefined; allowedTools: string[] | undefined; disallowedTools: string[] | undefined } {
  try {
    assertReadAccess(request);
    const restricted = request.workspaceMode === 'none' || request.workspaceMode === 'read';
    let tools = request.tools;
    if (restricted) {
      for (const tool of tools ?? []) {
        if (!READ_TOOLS.has(tool) && !WITHHELD_TOOLS.includes(tool)) {
          throw new TypeError(`Claude cannot bound custom tool ${tool} in workspace mode ${request.workspaceMode}`);
        }
      }
      tools = request.workspaceMode === 'none'
        ? []
        : tools!.filter((tool) => READ_TOOLS.has(tool));
      if (request.workspaceMode === 'read' && tools.length === 0) {
        throw new TypeError('read workspace requires Read, Grep, or Glob');
      }
    }
    const allowedTools = request.allowedTools?.filter((rule) => {
      if (tools === undefined) return true;
      const name = /^([A-Za-z][A-Za-z0-9_-]*)(?:\([^\r\n]*\))?$/.exec(rule)?.[1];
      if (!name) throw new TypeError(`Claude cannot bound permission rule ${rule}`);
      return tools.includes(name);
    });
    return {
      tools,
      allowedTools,
      disallowedTools: restricted
        ? [...WITHHELD_TOOLS, 'mcp__*']
        : request.leaf ? CLAUDE_SUBAGENT_TOOLS : undefined,
    };
  } catch (cause) {
    throw new EngineError({
      kind: 'invalid-config',
      message: cause instanceof Error ? cause.message : 'invalid Claude workspace configuration',
      cause,
    });
  }
}
