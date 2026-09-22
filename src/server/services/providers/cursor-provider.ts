import { Agent, CursorAgentError } from "@cursor/sdk";
import type {
  AgentProvider,
  RunAgentOptions,
  RunAgentResult,
} from "../agent-provider.js";

const DEFAULT_MODEL = "composer-2.5";

export class CursorAgentProvider implements AgentProvider {
  readonly id = "cursor" as const;

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const { cwd, prompt, name, apiKey, model, onEvent } = options;
    const textParts: string[] = [];

    await using agent = await Agent.create({
      apiKey,
      model: { id: model ?? DEFAULT_MODEL },
      name,
      local: {
        cwd,
        settingSources: [],
        sandboxOptions: { enabled: false },
      },
    });

    onEvent({ type: "status", content: `Cursor agent created: ${agent.agentId}` });

    let runId = "";
    try {
      const run = await agent.send(prompt);
      runId = run.id;
      onEvent({ type: "status", content: `Run started: ${runId}` });

      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text.trim()) {
              textParts.push(block.text);
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
      const text = textParts.join("\n");

      if (result.status === "error") {
        onEvent({ type: "error", content: `Agent run failed: ${result.id}` });
        return {
          agentId: agent.agentId,
          runId,
          status: "error",
          text,
        };
      }

      const summary =
        typeof result.result === "string"
          ? result.result
          : "Agent completed successfully.";

      return {
        agentId: agent.agentId,
        runId,
        status: "finished",
        summary,
        text: text || summary,
      };
    } catch (err) {
      if (err instanceof CursorAgentError) {
        onEvent({
          type: "error",
          content: `Agent startup failed: ${err.message}`,
        });
      }
      throw err;
    }
  }
}
