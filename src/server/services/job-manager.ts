import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentProviderId,
  AppConfig,
  Job,
  JobLogEntry,
  JobStep,
  StartJobRequest,
} from "../types.js";
import { parseGithubUrl } from "../validation.js";
import {
  cleanupWorkDir,
  cloneGithubRepo,
  commitAllChanges,
  pushToRemote,
} from "./github.js";
import { GitlabService } from "./gitlab.js";
import { runMultiAgentDocumentation } from "./multi-agent-documenter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORK_DIR = path.join(__dirname, "../../../../data/workspaces");

type JobListener = (job: Job) => void;

interface ResolvedJobConfig extends AppConfig {
  provider: AgentProviderId;
  agentApiKey: string;
  agentModel?: string;
  workerConcurrency: number;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<JobListener>>();

  constructor(private readonly defaultConfig: AppConfig) {}

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  subscribe(id: string, listener: JobListener): () => void {
    if (!this.listeners.has(id)) {
      this.listeners.set(id, new Set());
    }
    this.listeners.get(id)!.add(listener);
    return () => this.listeners.get(id)?.delete(listener);
  }

  async startJob(request: StartJobRequest): Promise<Job> {
    const id = uuidv4();
    const now = new Date().toISOString();
    const job: Job = {
      id,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      logs: [],
      result: { githubUrl: request.githubUrl.trim() },
    };
    this.jobs.set(id, job);
    this.emit(job);

    void this.executeJob(job, request);
    return job;
  }

  private emit(job: Job): void {
    this.listeners.get(job.id)?.forEach((fn) => fn(job));
  }

  private log(
    job: Job,
    step: JobStep,
    message: string,
    level: JobLogEntry["level"] = "info",
  ): void {
    job.logs.push({
      timestamp: new Date().toISOString(),
      step,
      message,
      level,
    });
    job.updatedAt = new Date().toISOString();
    this.emit(job);
  }

  private setStatus(job: Job, status: JobStep): void {
    job.status = status;
    job.updatedAt = new Date().toISOString();
    this.emit(job);
  }

  private fail(job: Job, error: string): void {
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date().toISOString();
    this.log(job, "failed", error, "error");
    this.emit(job);
  }

  private resolveConfig(request: StartJobRequest): ResolvedJobConfig {
    const provider: AgentProviderId =
      request.agentProvider ??
      this.defaultConfig.defaultProvider ??
      "cursor";

    const cursorApiKey =
      request.cursorApiKey?.trim() ||
      this.defaultConfig.cursorApiKey ||
      process.env.CURSOR_API_KEY ||
      "";
    const claudeApiKey =
      request.claudeApiKey?.trim() ||
      this.defaultConfig.claudeApiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_API_KEY ||
      "";

    return {
      cursorApiKey,
      claudeApiKey,
      gitlabToken:
        request.gitlabToken?.trim() ||
        this.defaultConfig.gitlabToken ||
        process.env.GITLAB_TOKEN ||
        "",
      gitlabHost:
        request.gitlabHost?.trim() ||
        this.defaultConfig.gitlabHost ||
        process.env.GITLAB_HOST ||
        "https://gitlab.com",
      gitlabNamespace:
        request.gitlabNamespace?.trim() ||
        this.defaultConfig.gitlabNamespace ||
        process.env.GITLAB_NAMESPACE ||
        "",
      workDir: this.defaultConfig.workDir || DEFAULT_WORK_DIR,
      defaultProvider: this.defaultConfig.defaultProvider,
      provider,
      agentApiKey: provider === "claude" ? claudeApiKey : cursorApiKey,
      agentModel: request.agentModel?.trim() || undefined,
      workerConcurrency: request.workerConcurrency ?? 3,
    };
  }

  private async executeJob(job: Job, request: StartJobRequest): Promise<void> {
    let localPath: string | undefined;

    try {
      this.setStatus(job, "validating");
      const config = this.resolveConfig(request);

      if (!config.agentApiKey) {
        throw new Error(
          config.provider === "claude"
            ? "ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required for the Claude provider. Set it in .env or the form."
            : "CURSOR_API_KEY is required for the Cursor provider. Set it in .env or the form.",
        );
      }
      if (!config.gitlabToken) {
        throw new Error(
          "GITLAB_TOKEN is required. Set it in .env or the form.",
        );
      }
      if (!config.gitlabNamespace) {
        throw new Error(
          "GITLAB_NAMESPACE is required. Set it in .env or the form.",
        );
      }

      const { owner, repo } = parseGithubUrl(request.githubUrl);
      this.log(job, "validating", `Validated GitHub repo: ${owner}/${repo}`);
      this.log(
        job,
        "validating",
        `Agent provider: ${config.provider}` +
          (config.agentModel ? ` (model: ${config.agentModel})` : ""),
      );

      this.setStatus(job, "cloning");
      this.log(job, "cloning", `Cloning ${request.githubUrl}...`);
      const cloned = await cloneGithubRepo(
        request.githubUrl,
        config.workDir,
        request.branch,
      );
      localPath = cloned.localPath;
      const branch = cloned.defaultBranch;
      job.result.branch = branch;
      this.log(job, "cloning", `Cloned to ${localPath} (branch: ${branch})`);

      this.setStatus(job, "creating_gitlab_project");
      const gitlab = new GitlabService(config.gitlabHost, config.gitlabToken);
      const project = await gitlab.createOrUpdateProject(
        repo,
        config.gitlabNamespace,
        `Mirrored from ${request.githubUrl} — documented by Open Source Code Documenter`,
      );
      job.result.gitlabUrl = project.webUrl;
      job.result.gitlabProjectPath = project.pathWithNamespace;
      this.log(
        job,
        "creating_gitlab_project",
        `GitLab project ready: ${project.webUrl}`,
      );

      this.setStatus(job, "pushing_to_gitlab");
      this.log(job, "pushing_to_gitlab", "Pushing mirror to GitLab...");
      await gitlab.mirrorToGitlab(localPath, project, branch);
      this.log(job, "pushing_to_gitlab", "Mirror pushed successfully.");

      this.setStatus(job, "documenting");
      this.log(
        job,
        "documenting",
        `Starting multi-agent documentation via ${config.provider}...`,
      );

      const docResult = await runMultiAgentDocumentation({
        cwd: localPath,
        provider: config.provider,
        apiKey: config.agentApiKey,
        model: config.agentModel,
        concurrency: config.workerConcurrency,
        onEvent: (event) => {
          const level: JobLogEntry["level"] =
            event.type === "error"
              ? "error"
              : event.type === "text" || event.type === "tool"
                ? "agent"
                : "info";
          this.log(job, "documenting", event.content, level);
        },
      });

      job.result.provider = docResult.provider;
      job.result.partCount = docResult.plan.parts.length;
      job.result.agentId = docResult.agentIds.join(",");
      job.result.runId = docResult.runIds.join(",");

      if (docResult.status === "error") {
        throw new Error(
          docResult.summary ||
            "Documentation agents failed. Check logs for details.",
        );
      }

      this.log(job, "documenting", docResult.summary, "agent");

      this.setStatus(job, "committing");
      this.log(job, "committing", "Committing documentation changes...");
      const committed = await commitAllChanges(
        localPath,
        "docs: add extensive documentation via multi-agent documenter\n\n" +
          `Provider: ${config.provider}. Split into ${docResult.plan.parts.length} part(s) ` +
          "with planner, parallel workers, and integrator. Includes expanded README, " +
          "docs/ guides, inline comments, and contributor documentation.",
      );

      if (!committed) {
        this.log(
          job,
          "committing",
          "No file changes detected after agent run.",
          "warn",
        );
      } else {
        this.log(job, "committing", "Documentation changes committed.");
      }

      this.setStatus(job, "pushing_documentation");
      if (committed) {
        this.log(
          job,
          "pushing_documentation",
          "Pushing documented repo to GitLab...",
        );
        await pushToRemote(localPath, "gitlab", branch);
        this.log(
          job,
          "pushing_documentation",
          `Documentation pushed to ${project.webUrl}`,
        );
      }

      this.setStatus(job, "completed");
      this.log(
        job,
        "completed",
        `Done! View documented repo: ${project.webUrl}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(job, message);
    } finally {
      if (localPath) {
        await cleanupWorkDir(localPath);
      }
    }
  }
}
