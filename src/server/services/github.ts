import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { parseGithubUrl } from "../validation.js";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly step: "cloning" | "push" | "commit" | "workspace",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function formatGitError(err: unknown, action: string): string {
  if (!err || typeof err !== "object") {
    return `${action} failed: ${String(err)}`;
  }

  const anyErr = err as {
    message?: string;
    stderr?: string;
    task?: string;
    git?: { stderr?: string };
  };

  const stderr =
    (typeof anyErr.stderr === "string" && anyErr.stderr.trim()) ||
    (typeof anyErr.git?.stderr === "string" && anyErr.git.stderr.trim()) ||
    "";
  const message =
    (typeof anyErr.message === "string" && anyErr.message.trim()) ||
    String(err);

  // simple-git often embeds stderr in message; prefer the clearest line
  const detail = stderr || message;
  const cleaned = detail
    .replace(/^Error:\s*/i, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" | ");

  return `${action} failed: ${cleaned}`;
}

export function workspacePathForRepo(
  workDir: string,
  owner: string,
  repo: string,
  branch?: string,
): string {
  const branchSuffix = branch?.trim()
    ? `-${branch.trim().replace(/[^\w.-]+/g, "_")}`
    : "";
  return path.join(workDir, `${owner}-${repo}${branchSuffix}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(localPath: string): Promise<boolean> {
  try {
    const git = simpleGit(localPath);
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/**
 * Prepare a shallow local checkout. Reuses an existing workspace for the same
 * owner/repo(/branch) so a failed push/document run does not require recloning.
 */
export async function prepareGithubWorkspace(
  githubUrl: string,
  workDir: string,
  branch?: string,
): Promise<{
  localPath: string;
  defaultBranch: string;
  reused: boolean;
}> {
  const { owner, repo, cloneUrl } = parseGithubUrl(githubUrl);
  const localPath = workspacePathForRepo(workDir, owner, repo, branch);
  await mkdir(workDir, { recursive: true });

  if (await pathExists(localPath)) {
    if (await isGitRepo(localPath)) {
      try {
        const repoGit = simpleGit(localPath);
        const summary = await repoGit.branchLocal();
        const defaultBranch = branch ?? summary.current ?? "main";
        const status = await repoGit.status();
        // Refresh only when the tree is clean so a failed mid-document run
        // can resume with its local edits intact.
        if (status.isClean()) {
          try {
            await repoGit.fetch([
              "origin",
              defaultBranch,
              "--depth",
              "1",
              "--force",
            ]);
            await repoGit.reset(["--hard", "FETCH_HEAD"]);
          } catch {
            // Keep existing tree if fetch is unavailable
          }
        }
        return { localPath, defaultBranch, reused: true };
      } catch (err) {
        throw new WorkspaceError(
          formatGitError(err, "Reusing existing workspace"),
          "workspace",
          err,
        );
      }
    }

    // Stale non-git directory from a partial clone — remove and reclone
    await rm(localPath, { recursive: true, force: true });
  }

  try {
    const git = simpleGit();
    const cloneOptions = ["--depth", "1", "--single-branch"];
    if (branch) {
      cloneOptions.push("--branch", branch);
    }

    await git.clone(cloneUrl, localPath, cloneOptions);

    const repoGit = simpleGit(localPath);
    const summary = await repoGit.branchLocal();
    const defaultBranch = branch ?? summary.current ?? "main";
    return { localPath, defaultBranch, reused: false };
  } catch (err) {
    // Leave no half-cloned directory behind
    await cleanupWorkDir(localPath);
    throw new WorkspaceError(
      formatGitError(err, `Shallow clone of ${owner}/${repo}`),
      "cloning",
      err,
    );
  }
}

/** @deprecated Use prepareGithubWorkspace */
export async function cloneGithubRepo(
  githubUrl: string,
  workDir: string,
  branch?: string,
): Promise<{ localPath: string; defaultBranch: string }> {
  const result = await prepareGithubWorkspace(githubUrl, workDir, branch);
  return { localPath: result.localPath, defaultBranch: result.defaultBranch };
}

export async function cleanupWorkDir(localPath: string): Promise<void> {
  try {
    await rm(localPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Drop the cloned Git history (shallow GitHub clones are rejected by GitLab)
 * and create a normal single-commit repository from the working tree.
 * Skipped when the workspace is already a non-shallow repo we created earlier,
 * so a retry can push again without recloning or discarding local edits.
 */
export async function reinitializeAsFreshRepo(
  localPath: string,
  branch: string,
): Promise<{ replaced: boolean }> {
  const git = simpleGit(localPath);
  const isRepo = await git.checkIsRepo();
  if (isRepo) {
    const shallow = (
      await git.raw(["rev-parse", "--is-shallow-repository"])
    ).trim();
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    const originUrl = `${origin?.refs?.fetch ?? ""} ${origin?.refs?.push ?? ""}`;
    const fromGithub = /github\.com/i.test(originUrl);
    if (shallow !== "true" && !fromGithub) {
      return { replaced: false };
    }
  }

  await rm(path.join(localPath, ".git"), { recursive: true, force: true });

  try {
    const fresh = simpleGit(localPath);
    await fresh.raw(["init", "--initial-branch", branch]);
    await fresh.addConfig("user.email", "documenter@localhost");
    await fresh.addConfig("user.name", "Open Source Code Documenter");
    await fresh.add(["-A"]);
    const status = await fresh.status();
    if (status.isClean()) {
      await fresh.commit("Initial import", { "--allow-empty": null });
    } else {
      await fresh.commit(
        "Initial import\n\nFresh repository created from a shallow GitHub checkout.",
      );
    }
    return { replaced: true };
  } catch (err) {
    throw new WorkspaceError(
      formatGitError(err, "Creating a fresh git repository"),
      "commit",
      err,
    );
  }
}

export async function commitAllChanges(
  localPath: string,
  message: string,
): Promise<boolean> {
  try {
    const git = simpleGit(localPath);
    const status = await git.status();
    if (status.isClean()) {
      return false;
    }
    await git.add(".");
    await git.commit(message);
    return true;
  } catch (err) {
    throw new WorkspaceError(
      formatGitError(err, "Committing documentation changes"),
      "commit",
      err,
    );
  }
}

export async function pushToRemote(
  localPath: string,
  remoteName: string,
  branch: string,
): Promise<void> {
  try {
    const git = simpleGit(localPath);
    await git.push(remoteName, branch, ["--set-upstream"]);
  } catch (err) {
    throw new WorkspaceError(
      formatGitError(err, `Pushing to remote "${remoteName}"`),
      "push",
      err,
    );
  }
}
