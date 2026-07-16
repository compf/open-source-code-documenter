import { simpleGit, type RemoteWithRefs } from "simple-git";
import { normalizeGitlabHost } from "../validation.js";

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

  async resolveNamespaceId(namespace: string): Promise<number> {
    const encoded = encodeURIComponent(namespace);
    const groupRes = await fetch(
      `${this.apiBase()}/groups/${encoded}`,
      { headers: this.headers() },
    );
    if (groupRes.ok) {
      const group = (await groupRes.json()) as { id: number };
      return group.id;
    }

    const userRes = await fetch(`${this.apiBase()}/user`, {
      headers: this.headers(),
    });
    if (!userRes.ok) {
      throw new Error(
        `Failed to resolve GitLab namespace "${namespace}": ${userRes.statusText}`,
      );
    }
    const user = (await userRes.json()) as { username: string; id: number };
    if (user.username === namespace) {
      return user.id;
    }

    throw new Error(
      `GitLab namespace "${namespace}" not found. Use a group path or your username.`,
    );
  }

  async findProject(pathWithNamespace: string): Promise<GitlabProjectInfo | null> {
    const encoded = encodeURIComponent(pathWithNamespace);
    const res = await fetch(`${this.apiBase()}/projects/${encoded}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GitLab project lookup failed: ${res.statusText}`);
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
      const body = await res.text();
      throw new Error(`Failed to create GitLab project: ${res.status} ${body}`);
    }

    return this.mapProject(await res.json());
  }

  async mirrorToGitlab(
    localPath: string,
    project: GitlabProjectInfo,
    branch: string,
  ): Promise<void> {
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
