export type JobStep =
  | "queued"
  | "validating"
  | "cloning"
  | "creating_gitlab_project"
  | "pushing_to_gitlab"
  | "documenting"
  | "committing"
  | "pushing_documentation"
  | "completed"
  | "failed";

export type AgentProviderId = "cursor" | "claude";

export interface JobLogEntry {
  timestamp: string;
  step: JobStep;
  message: string;
  level: "info" | "warn" | "error" | "agent";
}

export interface JobResult {
  githubUrl: string;
  gitlabUrl?: string;
  gitlabProjectPath?: string;
  agentId?: string;
  runId?: string;
  branch?: string;
  provider?: AgentProviderId;
  partCount?: number;
}

export interface Job {
  id: string;
  status: JobStep;
  createdAt: string;
  updatedAt: string;
  logs: JobLogEntry[];
  result: JobResult;
  error?: string;
}

export interface StartJobRequest {
  githubUrl: string;
  gitlabNamespace?: string;
  gitlabHost?: string;
  gitlabToken?: string;
  /** @deprecated Prefer agentProvider + matching API key field */
  cursorApiKey?: string;
  claudeApiKey?: string;
  agentProvider?: AgentProviderId;
  agentModel?: string;
  workerConcurrency?: number;
  branch?: string;
}

export interface AppConfig {
  cursorApiKey: string;
  claudeApiKey: string;
  gitlabToken: string;
  gitlabHost: string;
  gitlabNamespace: string;
  workDir: string;
  defaultProvider: AgentProviderId;
}
