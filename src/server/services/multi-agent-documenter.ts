import type { AgentProviderId, RunAgentResult } from "./agent-provider.js";
import { createAgentProvider } from "./agent-provider.js";
import {
  INTEGRATOR_PROMPT,
  PLANNER_PROMPT,
  buildWorkerPrompt,
  type AgentStreamEvent,
  type DocumentationPart,
  type DocumentationPlan,
} from "./documentation-prompt.js";

export interface MultiAgentDocumenterOptions {
  cwd: string;
  provider: AgentProviderId;
  apiKey: string;
  model?: string;
  /** Max worker agents running at once (default 3) */
  concurrency?: number;
  onEvent: (event: AgentStreamEvent) => void;
}

export interface MultiAgentDocumenterResult {
  provider: AgentProviderId;
  plan: DocumentationPlan;
  planner: RunAgentResult;
  workers: RunAgentResult[];
  integrator: RunAgentResult;
  agentIds: string[];
  runIds: string[];
  status: "finished" | "error";
  summary: string;
}

const FALLBACK_PLAN: DocumentationPlan = {
  rationale: "Fallback single-part plan after planner JSON parse failure",
  parts: [
    {
      id: "part-1",
      title: "Entire repository",
      paths: ["."],
      focus:
        "Document the whole codebase thoroughly with inline comments and module READMEs",
    },
  ],
};

export async function runMultiAgentDocumentation(
  options: MultiAgentDocumenterOptions,
): Promise<MultiAgentDocumenterResult> {
  const {
    cwd,
    provider: providerId,
    apiKey,
    model,
    concurrency = 3,
    onEvent,
  } = options;

  const provider = createAgentProvider(providerId);
  const agentIds: string[] = [];
  const runIds: string[] = [];

  onEvent({
    type: "status",
    content: `Multi-agent documentation starting (provider=${providerId})`,
  });

  // --- Phase 1: Planner ---
  onEvent({ type: "status", content: "Phase 1/3: Planning documentation parts..." });
  const planner = await provider.run({
    cwd,
    apiKey,
    model,
    name: "Documentation Planner",
    prompt: PLANNER_PROMPT,
    readOnly: true,
    onEvent: prefixEvents(onEvent, "planner"),
  });
  agentIds.push(planner.agentId);
  runIds.push(planner.runId);

  if (planner.status === "error") {
    return failedResult(providerId, FALLBACK_PLAN, planner, [], {
      agentId: "n/a",
      runId: "n/a",
      status: "error",
      text: "",
    }, agentIds, runIds, "Planner agent failed");
  }

  const plan = parsePlan(planner.text) ?? FALLBACK_PLAN;
  onEvent({
    type: "status",
    content: `Plan: ${plan.parts.length} part(s) — ${plan.rationale}`,
  });
  for (const part of plan.parts) {
    onEvent({
      type: "status",
      content: `  • ${part.id}: ${part.title} [${part.paths.join(", ")}]`,
    });
  }

  // --- Phase 2: Workers (bounded parallelism) ---
  onEvent({
    type: "status",
    content: `Phase 2/3: Spawning ${plan.parts.length} worker agent(s) (concurrency=${concurrency})...`,
  });

  const workers = await mapPool(
    plan.parts,
    concurrency,
    async (part: DocumentationPart) => {
      onEvent({
        type: "status",
        content: `Worker ${part.id} starting: ${part.title}`,
      });
      const result = await provider.run({
        cwd,
        apiKey,
        model,
        name: `Documentation Worker (${part.id})`,
        prompt: buildWorkerPrompt(part, plan.parts),
        onEvent: prefixEvents(onEvent, part.id),
      });
      agentIds.push(result.agentId);
      runIds.push(result.runId);
      onEvent({
        type: "status",
        content: `Worker ${part.id} ${result.status}`,
      });
      return result;
    },
  );

  const failedWorkers = workers.filter((w) => w.status === "error");
  if (failedWorkers.length === workers.length && workers.length > 0) {
    return failedResult(
      providerId,
      plan,
      planner,
      workers,
      {
        agentId: "n/a",
        runId: "n/a",
        status: "error",
        text: "",
      },
      agentIds,
      runIds,
      "All worker agents failed",
    );
  }

  // --- Phase 3: Integrator ---
  onEvent({
    type: "status",
    content: "Phase 3/3: Integrating cross-cutting documentation...",
  });
  const integrator = await provider.run({
    cwd,
    apiKey,
    model,
    name: "Documentation Integrator",
    prompt: INTEGRATOR_PROMPT,
    onEvent: prefixEvents(onEvent, "integrator"),
  });
  agentIds.push(integrator.agentId);
  runIds.push(integrator.runId);

  const status =
    integrator.status === "error" && failedWorkers.length > 0
      ? "error"
      : integrator.status === "error"
        ? "error"
        : "finished";

  const summary = [
    `Documented with ${plan.parts.length} worker part(s) via ${providerId}.`,
    plan.rationale,
    failedWorkers.length
      ? `${failedWorkers.length} worker(s) reported errors.`
      : undefined,
    integrator.summary,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    provider: providerId,
    plan,
    planner,
    workers,
    integrator,
    agentIds,
    runIds,
    status,
    summary,
  };
}

function prefixEvents(
  onEvent: (event: AgentStreamEvent) => void,
  prefix: string,
): (event: AgentStreamEvent) => void {
  return (event) => {
    onEvent({
      ...event,
      content: `[${prefix}] ${event.content}`,
    });
  };
}

function parsePlan(text: string): DocumentationPlan | null {
  const candidates = extractJsonObjects(text);
  for (const raw of candidates.reverse()) {
    try {
      const parsed = JSON.parse(raw) as Partial<DocumentationPlan>;
      if (!Array.isArray(parsed.parts) || parsed.parts.length === 0) continue;
      const parts: DocumentationPart[] = [];
      for (const [i, part] of parsed.parts.entries()) {
        if (!part || typeof part !== "object") continue;
        const paths = Array.isArray(part.paths)
          ? part.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          : [];
        if (paths.length === 0) continue;
        parts.push({
          id: typeof part.id === "string" && part.id.trim() ? part.id.trim() : `part-${i + 1}`,
          title:
            typeof part.title === "string" && part.title.trim()
              ? part.title.trim()
              : `Part ${i + 1}`,
          paths,
          focus:
            typeof part.focus === "string" && part.focus.trim()
              ? part.focus.trim()
              : "Document this area thoroughly",
        });
      }
      if (parts.length === 0) continue;
      return {
        rationale:
          typeof parsed.rationale === "string" && parsed.rationale.trim()
            ? parsed.rationale.trim()
            : `Split into ${parts.length} parts`,
        parts,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

function extractJsonObjects(text: string): string[] {
  const results: string[] = [];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fenced) {
    results.push(match[1].trim());
  }

  // Scan for top-level { ... } blocks
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          results.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return results;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

function failedResult(
  provider: AgentProviderId,
  plan: DocumentationPlan,
  planner: RunAgentResult,
  workers: RunAgentResult[],
  integrator: RunAgentResult,
  agentIds: string[],
  runIds: string[],
  summary: string,
): MultiAgentDocumenterResult {
  return {
    provider,
    plan,
    planner,
    workers,
    integrator,
    agentIds,
    runIds,
    status: "error",
    summary,
  };
}

/** @deprecated Use runMultiAgentDocumentation */
export async function runDocumentationAgent(
  cwd: string,
  apiKey: string,
  onEvent: (event: AgentStreamEvent) => void,
  provider: AgentProviderId = "cursor",
): Promise<{ agentId: string; runId: string; status: "finished" | "error"; summary?: string }> {
  const result = await runMultiAgentDocumentation({
    cwd,
    provider,
    apiKey,
    onEvent,
  });
  return {
    agentId: result.agentIds.join(","),
    runId: result.runIds.join(","),
    status: result.status,
    summary: result.summary,
  };
}
