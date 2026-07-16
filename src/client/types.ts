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

export interface JobLogEntry {
  timestamp: string;
  step: JobStep;
  message: string;
  level: "info" | "warn" | "error" | "agent";
}

export interface Job {
  id: string;
  status: JobStep;
  createdAt: string;
  updatedAt: string;
  logs: JobLogEntry[];
  result: {
    githubUrl: string;
    gitlabUrl?: string;
    gitlabProjectPath?: string;
    agentId?: string;
    runId?: string;
    branch?: string;
  };
  error?: string;
}

export interface AppConfig {
  gitlabHost: string;
  gitlabNamespace: string;
  hasCursorApiKey: boolean;
  hasGitlabToken: boolean;
}

export interface StartJobPayload {
  githubUrl: string;
  gitlabNamespace?: string;
  gitlabHost?: string;
  gitlabToken?: string;
  cursorApiKey?: string;
  branch?: string;
}

declare global {
  interface Window {
    electronAPI?: { isElectron: boolean; platform: string };
  }
}
