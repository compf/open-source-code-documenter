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
  WorkspaceError,
  cleanupWorkDir,
  commitAllChanges,
  prepareGithubWorkspace,
  reinitializeAsFreshRepo,
} from "./github.js";
import { GitlabService } from "./gitlab.js";
import { runMultiAgentDocumentation } from "./multi-agent-documenter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORK_DIR = path.join(__dirname, "../../../../data/workspaces");

type JobListener = (job: Job) => void;

interface PublishContext {
  localPath: string;
  branch: string;
  repo: string;
  namespace: string;
  host: string;
  token: string;
  description: string;
  publishing?: boolean;
}

interface ResolvedJobConfig extends AppConfig {
  provider: AgentProviderId;
  agentApiKey: string;
  agentModel?: string;
  workerConcurrency: number;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<JobListener>>();
  private readonly pendingPublish = new Map<string, PublishContext>();

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
    let keepWorkspace = false;

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
      this.log(
        job,
        "cloning",
        `Preparing shallow clone (depth 1) of ${request.githubUrl}...`,
      );

      const prepared = await prepareGithubWorkspace(
        request.githubUrl,
        config.workDir,
        request.branch,
      );
      localPath = prepared.localPath;
      keepWorkspace = true;
      job.result.localPath = localPath;
      job.result.workspaceReused = prepared.reused;
      const branch = prepared.defaultBranch;
      job.result.branch = branch;

      if (prepared.reused) {
        this.log(
          job,
          "cloning",
          `Reused existing workspace at ${localPath} (branch: ${branch}) — skipped full reclone.`,
        );
      } else {
        this.log(
          job,
          "cloning",
          `Shallow-cloned to ${localPath} (branch: ${branch})`,
        );
      }

      const fresh = await reinitializeAsFreshRepo(localPath, branch);
      if (fresh.replaced) {
        this.log(
          job,
          "cloning",
          fresh.lfsRemoved
            ? "Removed Git LFS rules and pointer files, then created a new single-commit repository."
            : "Removed the shallow GitHub .git directory and created a new repository with a single commit.",
        );
      } else {
        this.log(
          job,
          "cloning",
          "Workspace already has a non-shallow repository; keeping it for this retry.",
        );
      }

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
          (docResult.summary ||
            "Documentation agents failed. Check logs for details.") +
            ` Workspace kept at ${localPath} — re-run to resume without recloning.`,
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

      await this.finishPublish(job, {
        localPath,
        branch,
        repo,
        namespace: config.gitlabNamespace,
        host: config.gitlabHost,
        token: config.gitlabToken,
        description: `Mirrored from ${request.githubUrl} — documented by Open Source Code Documenter`,
      }, false);
    } catch (err) {
      const message =
        err instanceof WorkspaceError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      const withHint =
        keepWorkspace && localPath && !message.includes("Workspace kept")
          ? `${message} Workspace kept at ${localPath} — re-run this job to resume without recloning.`
          : message;
      this.fail(job, withHint);
    } finally {
      // The workspace stays on disk until a successful push, including while
      // waiting for confirmation to replace an existing GitLab project.
    }
  }

  confirmGitlabReplace(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error("Job not found");
    }
    if (job.status !== "awaiting_gitlab_confirmation") {
      throw new Error(
        "This job is not waiting for confirmation to replace a GitLab project",
      );
    }
    const ctx = this.pendingPublish.get(id);
    if (!ctx) {
      throw new Error(
        "The publish step expired. Re-run the job; the local workspace is still on disk.",
      );
    }
    if (ctx.publishing) {
      return job;
    }
    ctx.publishing = true;
    void this.finishPublish(job, ctx, true);
    return job;
  }

  private async finishPublish(
    job: Job,
    ctx: PublishContext,
    replaceExisting: boolean,
  ): Promise<void> {
    const gitlab = new GitlabService(ctx.host, ctx.token);
    const pathWithNamespace = `${ctx.namespace}/${ctx.repo}`;

    try {
      const existing = await gitlab.findProject(pathWithNamespace);
      if (existing && !replaceExisting) {
        job.result.gitlabUrl = existing.webUrl;
        job.result.gitlabProjectPath = existing.pathWithNamespace;
        this.pendingPublish.set(job.id, ctx);
        this.setStatus(job, "awaiting_gitlab_confirmation");
        this.log(
          job,
          "awaiting_gitlab_confirmation",
          `GitLab project already exists at ${existing.webUrl}. Nothing was deleted. Confirm to delete it and push the documented repository.`,
        );
        return;
      }

      this.setStatus(job, "creating_gitlab_project");
      const project = existing
        ? await gitlab.recreateProject(ctx.repo, ctx.namespace, ctx.description)
        : await gitlab.createOrUpdateProject(
            ctx.repo,
            ctx.namespace,
            ctx.description,
          );
      job.result.gitlabUrl = project.webUrl;
      job.result.gitlabProjectPath = project.pathWithNamespace;
      this.log(
        job,
        "creating_gitlab_project",
        existing
          ? `Deleted the existing project and created ${project.webUrl}`
          : `Created GitLab project ${project.webUrl}`,
      );

      this.setStatus(job, "pushing_documentation");
      this.log(
        job,
        "pushing_documentation",
        "Pushing the documented repository to GitLab...",
      );
      await gitlab.mirrorToGitlab(ctx.localPath, project, ctx.branch);
      this.pendingPublish.delete(job.id);

      this.setStatus(job, "completed");
      this.log(
        job,
        "completed",
        `Done! View documented repo: ${project.webUrl}`,
      );
      await cleanupWorkDir(ctx.localPath);
      job.result.localPath = undefined;
      this.log(job, "completed", `Cleaned up workspace ${ctx.localPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.publishing = false;
      const hint = `${message} Workspace kept at ${ctx.localPath}.`;
      if (replaceExisting) {
        this.pendingPublish.set(job.id, ctx);
        job.error = hint;
        this.setStatus(job, "awaiting_gitlab_confirmation");
        this.log(
          job,
          "awaiting_gitlab_confirmation",
          `${hint} Confirm again to retry the replace and push.`,
          "error",
        );
        return;
      }
      this.pendingPublish.delete(job.id);
      this.fail(job, hint);
    }
  }
}
