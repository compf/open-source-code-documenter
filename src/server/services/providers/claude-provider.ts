import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  RunAgentOptions,
  RunAgentResult,
} from "../agent-provider.js";
import {
  CLAUDE_TOOL_DEFINITIONS,
  executeClaudeTool,
} from "./claude-tools.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 80;

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = "claude" as const;

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const { cwd, prompt, name, apiKey, model, readOnly, onEvent } = options;
    const agentId = `claude-${randomUUID()}`;
    const runId = randomUUID();
    const textParts: string[] = [];

    onEvent({
      type: "status",
      content: `Claude agent started: ${name} (${agentId})`,
    });

    const client = new Anthropic({ apiKey });
    const allowed = readOnly
      ? new Set(["list_dir", "glob", "grep", "read_file"])
      : null;
    const tools: Anthropic.Tool[] = CLAUDE_TOOL_DEFINITIONS.filter((t) =>
      allowed ? allowed.has(t.name) : true,
    ).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object",
        properties: t.input_schema.properties as Record<string, unknown>,
        required: [...(t.input_schema.required ?? [])],
      },
    }));

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: prompt,
      },
    ];

    const systemText = readOnly
      ? "You are a read-only planning agent. Explore the repository with tools and produce the requested output. Do not attempt to modify files."
      : "You are a documentation agent working inside a local git checkout. " +
        "Use the provided tools to explore and edit files. " +
        "Do not run git commands. Prefer edit_file for small changes and write_file for new files. " +
        "Be thorough and write beginner-friendly documentation.";

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await client.messages.create({
          model: model ?? DEFAULT_MODEL,
          max_tokens: 16_384,
          system: [
            {
              type: "text",
              text: systemText,
            },
          ],
          tools,
          messages,
        });

        const assistantContent = response.content;
        messages.push({ role: "assistant", content: assistantContent });

        const toolUses: Anthropic.ToolUseBlock[] = [];
        for (const block of assistantContent) {
          if (block.type === "text" && block.text.trim()) {
            textParts.push(block.text);
            onEvent({ type: "text", content: block.text });
          } else if (block.type === "tool_use") {
            toolUses.push(block);
          }
        }

        if (response.stop_reason === "end_turn" || toolUses.length === 0) {
          const text = textParts.join("\n");
          onEvent({
            type: "status",
            content: `Claude agent finished after ${turn + 1} turn(s)`,
          });
          return {
            agentId,
            runId,
            status: "finished",
            summary: text.slice(-2000) || "Claude agent completed successfully.",
            text,
          };
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
          onEvent({ type: "tool", content: `Using ${toolUse.name}...` });
          const input =
            typeof toolUse.input === "object" && toolUse.input !== null
              ? (toolUse.input as Record<string, unknown>)
              : {};
          const result = await executeClaudeTool(cwd, toolUse.name, input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      onEvent({
        type: "error",
        content: `Claude agent hit max turns (${MAX_TURNS})`,
      });
      return {
        agentId,
        runId,
        status: "error",
        text: textParts.join("\n"),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", content: `Claude agent failed: ${message}` });
      throw err;
    }
  }
}
