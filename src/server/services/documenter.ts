import { Agent, CursorAgentError } from "@cursor/sdk";
import {
  DOCUMENTATION_PROMPT,
  type AgentStreamEvent,
} from "./documentation-prompt.js";

export interface DocumenterResult {
  agentId: string;
  runId: string;
  status: "finished" | "error";
  summary?: string;
}

export async function runDocumentationAgent(
  cwd: string,
  apiKey: string,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<DocumenterResult> {
  await using agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    name: "Open Source Code Documenter",
    local: {
      cwd,
      settingSources: [],
      sandboxOptions: { enabled: false },
    },
  });

  onEvent({ type: "status", content: `Agent created: ${agent.agentId}` });

  let runId = "";
  try {
    const run = await agent.send(DOCUMENTATION_PROMPT);
    runId = run.id;
    onEvent({ type: "status", content: `Run started: ${runId}` });

    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text.trim()) {
            onEvent({ type: "text", content: block.text });
          }
        }
      } else if (event.type === "tool_call" && event.status === "running") {
        onEvent({ type: "tool", content: `Using ${event.name}...` });
      } else if (event.type === "status") {
        onEvent({
          type: "status",
          content: `${event.status}${event.message ? `: ${event.message}` : ""}`,
        });
      }
    }

    const result = await run.wait();
    if (result.status === "error") {
      onEvent({ type: "error", content: `Agent run failed: ${result.id}` });
      return {
        agentId: agent.agentId,
        runId,
        status: "error",
      };
    }

    const summary =
      typeof result.result === "string"
        ? result.result
        : "Documentation agent completed successfully.";

    return {
      agentId: agent.agentId,
      runId,
      status: "finished",
      summary,
    };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      onEvent({
        type: "error",
        content: `Agent startup failed: ${err.message}`,
      });
      throw err;
    }
    throw err;
  }
}
