import { simpleGit, type RemoteWithRefs } from "simple-git";
import { normalizeGitlabHost } from "../validation.js";
import { WorkspaceError, formatGitError } from "./github.js";

export interface GitlabProjectInfo {
  id: number;
  pathWithNamespace: string;
  webUrl: string;
  httpUrlToRepo: string;
  defaultBranch: string;
}

export class GitlabService {
  constructor(
    private readonly host: string,
    private readonly token: string,
  ) {}

  private apiBase(): string {
    return `${normalizeGitlabHost(this.host)}/api/v4`;
  }

  private headers(): HeadersInit {
    return {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    };
  }

  private async readErrorBody(res: Response): Promise<string> {
    try {
      const text = await res.text();
      if (!text.trim()) return res.statusText || String(res.status);
      try {
        const json = JSON.parse(text) as {
          message?: string | Record<string, unknown>;
          error?: string;
        };
        if (typeof json.message === "string") return json.message;
        if (json.message && typeof json.message === "object") {
          return JSON.stringify(json.message);
        }
        if (typeof json.error === "string") return json.error;
      } catch {
        // not JSON
      }
      return text.slice(0, 500);
    } catch {
      return res.statusText || String(res.status);
    }
  }

  async resolveNamespaceId(namespace: string): Promise<number> {
    const encoded = encodeURIComponent(namespace);
    const groupRes = await fetch(`${this.apiBase()}/groups/${encoded}`, {
      headers: this.headers(),
    });
    if (groupRes.ok) {
      const group = (await groupRes.json()) as { id: number };
      return group.id;
    }

    const userRes = await fetch(`${this.apiBase()}/user`, {
      headers: this.headers(),
    });
    if (!userRes.ok) {
      throw new Error(
        `Failed to resolve GitLab namespace "${namespace}": ${userRes.status} ${await this.readErrorBody(userRes)}. Check GITLAB_TOKEN scopes (needs api).`,
      );
    }
    const user = (await userRes.json()) as { username: string; id: number };
    if (user.username === namespace) {
      return user.id;
    }

    throw new Error(
      `GitLab namespace "${namespace}" not found as a group, and it is not your username (${user.username}).`,
    );
  }

  async findProject(pathWithNamespace: string): Promise<GitlabProjectInfo | null> {
    const encoded = encodeURIComponent(pathWithNamespace);
    const res = await fetch(`${this.apiBase()}/projects/${encoded}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GitLab project lookup failed for "${pathWithNamespace}": ${res.status} ${await this.readErrorBody(res)}`,
      );
    }
    return this.mapProject(await res.json());
  }

  async createOrUpdateProject(
    repoName: string,
    namespace: string,
    description: string,
  ): Promise<GitlabProjectInfo> {
    const pathWithNamespace = `${namespace}/${repoName}`;
    const existing = await this.findProject(pathWithNamespace);
    if (existing) {
      return existing;
    }

    const namespaceId = await this.resolveNamespaceId(namespace);
    const res = await fetch(`${this.apiBase()}/projects`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: repoName,
        path: repoName,
        namespace_id: namespaceId,
        description,
        visibility: "private",
        initialize_with_readme: false,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Failed to create GitLab project "${pathWithNamespace}": ${res.status} ${await this.readErrorBody(res)}`,
      );
    }

    return this.mapProject(await res.json());
  }

  async mirrorToGitlab(
    localPath: string,
    project: GitlabProjectInfo,
    branch: string,
  ): Promise<void> {
    try {
      const git = simpleGit(localPath);
      const pushUrl = this.authenticatedPushUrl(project.httpUrlToRepo);

      const remotes = await git.getRemotes(true);
      const hasGitlab = remotes.some((r: RemoteWithRefs) => r.name === "gitlab");
      if (!hasGitlab) {
        await git.addRemote("gitlab", pushUrl);
      } else {
        await git.remote(["set-url", "gitlab", pushUrl]);
      }

      await git.push("gitlab", branch, ["--set-upstream", "--force"]);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(
        formatGitError(
          err,
          `Pushing mirror to GitLab (${project.pathWithNamespace})`,
        ),
        "push",
        err,
      );
    }
  }

  private authenticatedPushUrl(httpUrl: string): string {
    const url = new URL(httpUrl);
    url.username = "oauth2";
    url.password = this.token;
    return url.toString();
  }

  private mapProject(data: Record<string, unknown>): GitlabProjectInfo {
    return {
      id: data.id as number,
      pathWithNamespace: data.path_with_namespace as string,
      webUrl: data.web_url as string,
      httpUrlToRepo: data.http_url_to_repo as string,
      defaultBranch: (data.default_branch as string) ?? "main",
    };
  }
}
