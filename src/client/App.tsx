import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentProviderId,
  AppConfig,
  Job,
  JobLogEntry,
  StartJobPayload,
} from "./types";

const STEP_LABELS: Record<string, string> = {
  queued: "Queued",
  validating: "Validating",
  cloning: "Cloning from GitHub",
  creating_gitlab_project: "Creating GitLab project",
  pushing_to_gitlab: "Pushing mirror to GitLab",
  documenting: "Multi-agent documentation",
  committing: "Committing changes",
  pushing_documentation: "Pushing documentation to GitLab",
  completed: "Completed",
  failed: "Failed",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [gitlabNamespace, setGitlabNamespace] = useState("");
  const [gitlabHost, setGitlabHost] = useState("https://gitlab.com");
  const [gitlabToken, setGitlabToken] = useState("");
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [agentProvider, setAgentProvider] = useState<AgentProviderId>("cursor");
  const [workerConcurrency, setWorkerConcurrency] = useState(3);
  const [branch, setBranch] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const isElectron = Boolean(window.electronAPI?.isElectron);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: AppConfig) => {
        setConfig(data);
        setGitlabHost(data.gitlabHost);
        setGitlabNamespace(data.gitlabNamespace);
        setAgentProvider(data.defaultProvider ?? "cursor");
      })
      .catch(() => setError("Could not reach API server. Is it running?"));
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [job?.logs.length]);

  const subscribeToJob = useCallback((jobId: string) => {
    const source = new EventSource(`/api/jobs/${jobId}/stream`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as Job;
      setJob(data);
      if (data.status === "completed" || data.status === "failed") {
        source.close();
        setSubmitting(false);
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setJob(null);

    const payload: StartJobPayload = {
      githubUrl: githubUrl.trim(),
      gitlabNamespace: gitlabNamespace.trim() || undefined,
      gitlabHost: gitlabHost.trim() || undefined,
      branch: branch.trim() || undefined,
      agentProvider,
      workerConcurrency,
    };

    if (showSecrets) {
      if (gitlabToken.trim()) payload.gitlabToken = gitlabToken.trim();
      if (cursorApiKey.trim()) payload.cursorApiKey = cursorApiKey.trim();
      if (claudeApiKey.trim()) payload.claudeApiKey = claudeApiKey.trim();
    }

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start job");
      }
      setJob(data as Job);
      subscribeToJob(data.id);
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const progressSteps = [
    "validating",
    "cloning",
    "creating_gitlab_project",
    "pushing_to_gitlab",
    "documenting",
    "committing",
    "pushing_documentation",
    "completed",
  ];

  const currentStepIndex = job
    ? progressSteps.indexOf(job.status === "failed" ? "documenting" : job.status)
    : -1;

  const providerReady =
    agentProvider === "claude"
      ? Boolean(config?.hasClaudeApiKey || claudeApiKey.trim())
      : Boolean(config?.hasCursorApiKey || cursorApiKey.trim());

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <div className="brand-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                <path d="M8 7h8M8 11h8M8 15h5" />
              </svg>
            </div>
            <div>
              <h1>Open Source Code Documenter</h1>
              <p className="subtitle">
                Mirror a GitHub repo to GitLab, then document it with a planner plus parallel worker agents (Cursor or Claude).
              </p>
            </div>
          </div>
          <span className="mode-badge">{isElectron ? "Desktop" : "Web"}</span>
        </div>
      </header>

      <main className="main">
        <section className="card form-card">
          <h2>New documentation job</h2>
          <form onSubmit={handleSubmit}>
            <label>
              GitHub repository URL
              <input
                type="url"
                required
                placeholder="https://github.com/owner/repo"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                disabled={submitting}
              />
            </label>

            <div className="row">
              <label>
                GitLab namespace
                <input
                  type="text"
                  required={!config?.gitlabNamespace}
                  placeholder="my-group or username"
                  value={gitlabNamespace}
                  onChange={(e) => setGitlabNamespace(e.target.value)}
                  disabled={submitting}
                />
              </label>
              <label>
                GitLab host
                <input
                  type="url"
                  placeholder="https://gitlab.com"
                  value={gitlabHost}
                  onChange={(e) => setGitlabHost(e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <div className="row">
              <label>
                Agent provider
                <select
                  value={agentProvider}
                  onChange={(e) =>
                    setAgentProvider(e.target.value as AgentProviderId)
                  }
                  disabled={submitting}
                >
                  <option value="cursor">Cursor</option>
                  <option value="claude">Claude (Anthropic API)</option>
                </select>
              </label>
              <label>
                Worker concurrency
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={workerConcurrency}
                  onChange={(e) =>
                    setWorkerConcurrency(
                      Math.min(8, Math.max(1, Number(e.target.value) || 1)),
                    )
                  }
                  disabled={submitting}
                />
              </label>
            </div>

            <label>
              Branch (optional)
              <input
                type="text"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={submitting}
              />
            </label>

            <div className="secrets-toggle">
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowSecrets((v) => !v)}
              >
                {showSecrets ? "Hide" : "Show"} API credentials
              </button>
              {config && (
                <span className="env-hint">
                  {providerReady && config.hasGitlabToken
                    ? "Using .env defaults where set"
                    : "Credentials required via form or .env"}
                </span>
              )}
            </div>

            {showSecrets && (
              <div className="secrets-panel">
                {agentProvider === "cursor" ? (
                  <label>
                    Cursor API key
                    <input
                      type="password"
                      placeholder={
                        config?.hasCursorApiKey
                          ? "•••••••• (from .env)"
                          : "cursor_..."
                      }
                      value={cursorApiKey}
                      onChange={(e) => setCursorApiKey(e.target.value)}
                      disabled={submitting}
                    />
                  </label>
                ) : (
                  <label>
                    Anthropic API key
                    <input
                      type="password"
                      placeholder={
                        config?.hasClaudeApiKey
                          ? "•••••••• (from .env)"
                          : "sk-ant-..."
                      }
                      value={claudeApiKey}
                      onChange={(e) => setClaudeApiKey(e.target.value)}
                      disabled={submitting}
                    />
                  </label>
                )}
                <label>
                  GitLab token
                  <input
                    type="password"
                    placeholder={config?.hasGitlabToken ? "•••••••• (from .env)" : "glpat-..."}
                    value={gitlabToken}
                    onChange={(e) => setGitlabToken(e.target.value)}
                    disabled={submitting}
                  />
                </label>
              </div>
            )}

            {error && <div className="alert error">{error}</div>}

            <button type="submit" className="primary-btn" disabled={submitting}>
              {submitting ? "Running…" : "Mirror & Document"}
            </button>
          </form>
        </section>

        {job && (
          <section className="card status-card">
            <div className="status-header">
              <h2>Job status</h2>
              <span className={`status-pill status-${job.status}`}>
                {STEP_LABELS[job.status] ?? job.status}
              </span>
            </div>

            <div className="progress-track">
              {progressSteps.slice(0, -1).map((step, i) => (
                <div
                  key={step}
                  className={`progress-step ${
                    i < currentStepIndex
                      ? "done"
                      : i === currentStepIndex
                        ? "active"
                        : ""
                  } ${job.status === "failed" && i === currentStepIndex ? "failed-step" : ""}`}
                >
                  <div className="step-dot" />
                  <span>{STEP_LABELS[step]}</span>
                </div>
              ))}
            </div>

            {job.result.gitlabUrl && (
              <div className="result-links">
                <a href={job.result.gitlabUrl} target="_blank" rel="noreferrer">
                  GitLab: {job.result.gitlabProjectPath}
                </a>
                {job.result.provider && (
                  <span className="meta">Provider: {job.result.provider}</span>
                )}
                {job.result.partCount != null && (
                  <span className="meta">Parts: {job.result.partCount}</span>
                )}
                {job.result.workspaceReused && (
                  <span className="meta">Workspace reused</span>
                )}
                {job.result.localPath && (
                  <span className="meta">Local: {job.result.localPath}</span>
                )}
                {job.result.agentId && (
                  <span className="meta">Agents: {job.result.agentId}</span>
                )}
              </div>
            )}
            {!job.result.gitlabUrl && job.result.localPath && (
              <div className="result-links">
                <span className="meta">Workspace: {job.result.localPath}</span>
                {job.result.workspaceReused && (
                  <span className="meta">Reused existing clone</span>
                )}
              </div>
            )}

            {job.error && <div className="alert error">{job.error}</div>}

            <div className="log-panel">
              <h3>Activity log</h3>
              <div className="log-entries">
                {job.logs.map((entry: JobLogEntry, i: number) => (
                  <div key={i} className={`log-entry log-${entry.level}`}>
                    <time>{formatTime(entry.timestamp)}</time>
                    <span className="log-step">[{STEP_LABELS[entry.step] ?? entry.step}]</span>
                    <pre>{entry.message}</pre>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          </section>
        )}

        <section className="card info-card">
          <h2>What this does</h2>
          <ol>
            <li>Clones the GitHub repository locally</li>
            <li>Creates (or reuses) a project in your GitLab namespace and pushes a mirror</li>
            <li>
              Runs a <strong>planner</strong> agent that splits the repo into parts, then
              spawns <strong>parallel worker</strong> agents for deep inline/module docs,
              plus an <strong>integrator</strong> for README / <code>docs/</code> / CONTRIBUTING
            </li>
            <li>Commits and pushes the documented version back to GitLab</li>
          </ol>
          <p className="note">
            Choose Cursor or Claude (Anthropic API key). Large repos benefit from more worker
            parts; concurrency controls how many workers run at once.
          </p>
        </section>
      </main>
    </div>
  );
}
