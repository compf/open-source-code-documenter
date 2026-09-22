import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProviderId } from "./types.js";
import { JobManager } from "./services/job-manager.js";
import { startJobSchema } from "./validation.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3847);
const isProduction = process.env.NODE_ENV === "production";

function resolveDefaultProvider(): AgentProviderId {
  const raw = (process.env.AGENT_PROVIDER ?? "cursor").toLowerCase();
  return raw === "claude" ? "claude" : "cursor";
}

const jobManager = new JobManager({
  cursorApiKey: process.env.CURSOR_API_KEY ?? "",
  claudeApiKey:
    process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? "",
  gitlabToken: process.env.GITLAB_TOKEN ?? "",
  gitlabHost: process.env.GITLAB_HOST ?? "https://gitlab.com",
  gitlabNamespace: process.env.GITLAB_NAMESPACE ?? "",
  workDir: process.env.WORK_DIR ?? "",
  defaultProvider: resolveDefaultProvider(),
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: isProduction ? "production" : "development",
    configured: {
      cursorApiKey: Boolean(process.env.CURSOR_API_KEY),
      claudeApiKey: Boolean(
        process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
      ),
      gitlabToken: Boolean(process.env.GITLAB_TOKEN),
      gitlabNamespace: Boolean(process.env.GITLAB_NAMESPACE),
      agentProvider: resolveDefaultProvider(),
    },
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    gitlabHost: process.env.GITLAB_HOST ?? "https://gitlab.com",
    gitlabNamespace: process.env.GITLAB_NAMESPACE ?? "",
    defaultProvider: resolveDefaultProvider(),
    hasCursorApiKey: Boolean(process.env.CURSOR_API_KEY),
    hasClaudeApiKey: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
    ),
    hasGitlabToken: Boolean(process.env.GITLAB_TOKEN),
  });
});

app.get("/api/jobs", (_req, res) => {
  res.json(jobManager.listJobs());
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/jobs/:id/stream", (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send(job);
  const unsubscribe = jobManager.subscribe(req.params.id, send);

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});

app.post("/api/jobs", async (req, res) => {
  const parsed = startJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const job = await jobManager.startJob(parsed.data);
    res.status(202).json(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

if (isProduction) {
  const clientDir = path.join(__dirname, "../../client");
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

export function startServer(): void {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
