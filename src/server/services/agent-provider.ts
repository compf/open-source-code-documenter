import type { AgentStreamEvent } from "./documentation-prompt.js";
import { ClaudeAgentProvider } from "./providers/claude-provider.js";
import { CursorAgentProvider } from "./providers/cursor-provider.js";

export type AgentProviderId = "cursor" | "claude";

export interface RunAgentOptions {
  cwd: string;
  prompt: string;
  name: string;
  apiKey: string;
  /** Provider-specific model id override */
  model?: string;
  /** When true, agents should only explore (Claude enforces read-only tools) */
  readOnly?: boolean;
  onEvent: (event: AgentStreamEvent) => void;
}

export interface RunAgentResult {
  agentId: string;
  runId: string;
  status: "finished" | "error";
  summary?: string;
  /** Concatenated assistant text — useful for parsing planner JSON */
  text: string;
}

export interface AgentProvider {
  id: AgentProviderId;
  run(options: RunAgentOptions): Promise<RunAgentResult>;
}

export function createAgentProvider(id: AgentProviderId): AgentProvider {
  switch (id) {
    case "cursor":
      return new CursorAgentProvider();
    case "claude":
      return new ClaudeAgentProvider();
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown agent provider: ${_exhaustive}`);
    }
  }
}
