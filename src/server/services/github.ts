import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import { parseGithubUrl } from "../validation.js";

const execFileAsync = promisify(execFile);

/** Env vars simple-git refuses to forward unless an unsafe override is enabled. */
const BLOCKED_GIT_ENV = new Set([
  "editor",
  "git_askpass",
  "git_config",
  "git_config_count",
  "git_config_global",
  "git_config_system",
  "git_editor",
  "git_exec_path",
  "git_external_diff",
  "git_pager",
  "git_proxy_command",
  "git_sequence_editor",
  "git_ssh",
  "git_ssh_command",
  "git_template_dir",
  "pager",
  "prefix",
  "ssh_askpass",
]);

function safeGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (BLOCKED_GIT_ENV.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_LFS_SKIP_PUSH = "1";
  return env;
}

/** Skip Git LFS without forwarding credential-helper env vars simple-git blocks. */
export function gitWithoutLfs(localPath?: string) {
  const git = localPath ? simpleGit(localPath) : simpleGit();
  return git.env(safeGitEnv());
}

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
    const git = gitWithoutLfs();
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

const LFS_ATTR = /(?:^|\s)(?:filter|diff|merge)=lfs(?:\s|$)/;
const LFS_POINTER_MARKER = "https://git-lfs.github.com/spec/v1";
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";
const LFS_OMITTED_BODY = "Git LFS content was omitted.\n";

async function gitGrepPaths(localPath: string, extraArgs: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", localPath, "grep", "-a", "-l", LFS_POINTER_MARKER, ...extraArgs],
      { maxBuffer: 20_000_000 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("HEAD:") ? line.slice("HEAD:".length) : line));
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return [];
    throw new WorkspaceError(
      formatGitError(err, "Searching for Git LFS pointer files"),
      "workspace",
      err,
    );
  }
}

/**
 * GitLab rejects a push when any blob is an LFS pointer whose object was never
 * uploaded. Replace those small pointer files with plain text and report how many changed.
 */
export async function replaceGitLfsPointers(localPath: string): Promise<number> {
  const isRepo = await simpleGit(localPath).checkIsRepo();
  if (!isRepo) return 0;

  const paths = await gitGrepPaths(localPath, []);
  let replaced = 0;
  for (const relative of paths) {
    const file = path.join(localPath, relative);
    let raw: string;
    try {
      const buf = await readFile(file);
      if (buf.length > 2048) continue;
      raw = buf.toString("utf8");
    } catch {
      continue;
    }
    if (!raw.startsWith(LFS_POINTER_HEADER)) continue;
    await writeFile(file, LFS_OMITTED_BODY);
    replaced += 1;
  }
  return replaced;
}

async function headContainsLfsPointers(localPath: string): Promise<boolean> {
  const isRepo = await simpleGit(localPath).checkIsRepo();
  if (!isRepo) return false;
  const paths = await gitGrepPaths(localPath, ["HEAD"]);
  return paths.length > 0;
}

/**
 * Remove Git LFS rules so GitLab does not reject the push for missing LFS objects.
 * Pointer or binary files stay in the tree as ordinary blobs.
 */
export async function removeGitLfsTracking(localPath: string): Promise<boolean> {
  let stdout = "";
  try {
    const result = await execFileAsync(
      "find",
      [
        localPath,
        "(",
        "-name",
        ".git",
        "-o",
        "-name",
        "node_modules",
        ")",
        "-prune",
        "-o",
        "(",
        "-name",
        ".gitattributes",
        "-o",
        "-name",
        ".lfsconfig",
        ")",
        "-print",
      ],
      { maxBuffer: 10_000_000 },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new WorkspaceError(
      formatGitError(err, "Searching for Git LFS configuration"),
      "workspace",
      err,
    );
  }

  let changed = false;
  for (const file of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (path.basename(file) === ".lfsconfig") {
      await rm(file, { force: true });
      changed = true;
      continue;
    }

    const raw = await readFile(file, "utf8");
    const kept = raw.split("\n").filter((line) => !LFS_ATTR.test(line));
    const next = kept.join("\n");
    if (next === raw) continue;
    if (!next.trim()) {
      await rm(file, { force: true });
    } else {
      await writeFile(file, next);
    }
    changed = true;
  }
  return changed;
}

/**
 * Drop the cloned Git history (shallow GitHub clones are rejected by GitLab)
 * and create a normal single-commit repository from the working tree.
 * Also rewrites history when Git LFS rules are present, because GitLab checks
 * every commit in the push. A later commit that only deletes the rules is not enough.
 * Skipped when the workspace is already a non-shallow, non-LFS repo we created earlier.
 */
export async function reinitializeAsFreshRepo(
  localPath: string,
  branch: string,
): Promise<{ replaced: boolean; lfsRemoved: boolean }> {
  const attrsRemoved = await removeGitLfsTracking(localPath);
  const pointersReplaced = await replaceGitLfsPointers(localPath);
  const committedPointers = await headContainsLfsPointers(localPath);
  const lfsRemoved = attrsRemoved || pointersReplaced > 0 || committedPointers;

  const git = simpleGit(localPath);
  const isRepo = await git.checkIsRepo();
  if (isRepo && !lfsRemoved) {
    const shallow = (
      await git.raw(["rev-parse", "--is-shallow-repository"])
    ).trim();
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    const originUrl = `${origin?.refs?.fetch ?? ""} ${origin?.refs?.push ?? ""}`;
    const fromGithub = /github\.com/i.test(originUrl);
    if (shallow !== "true" && !fromGithub) {
      return { replaced: false, lfsRemoved: false };
    }
  }

  await rm(path.join(localPath, ".git"), { recursive: true, force: true });

  try {
    const fresh = gitWithoutLfs(localPath);
    await fresh.raw(["init", "--initial-branch", branch]);
    await fresh.addConfig("user.email", "documenter@localhost");
    await fresh.addConfig("user.name", "Open Source Code Documenter");
    await fresh.add(["-A"]);
    const status = await fresh.status();
    if (status.isClean()) {
      await fresh.commit("Initial import", { "--allow-empty": null });
    } else {
      await fresh.commit(
        "Initial import\n\nFresh repository created from a shallow GitHub checkout. Git LFS tracking removed.",
      );
    }
    return { replaced: true, lfsRemoved };
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
    const git = gitWithoutLfs(localPath);
    await git.push(remoteName, branch, ["--set-upstream"]);
  } catch (err) {
    throw new WorkspaceError(
      formatGitError(err, `Pushing to remote "${remoteName}"`),
      "push",
      err,
    );
  }
}
