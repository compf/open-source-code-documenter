import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type RemoteWithRefs } from "simple-git";
import { parseGithubUrl } from "../validation.js";

export async function cloneGithubRepo(
  githubUrl: string,
  workDir: string,
  branch?: string,
): Promise<{ localPath: string; defaultBranch: string }> {
  const { owner, repo, cloneUrl } = parseGithubUrl(githubUrl);
  const localPath = path.join(workDir, `${owner}-${repo}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const git = simpleGit();
  const cloneOptions: string[] = [];
  if (branch) {
    cloneOptions.push("--branch", branch, "--single-branch");
  }

  await git.clone(cloneUrl, localPath, cloneOptions);

  const repoGit = simpleGit(localPath);
  const summary = await repoGit.branchLocal();
  const defaultBranch = branch ?? summary.current ?? "main";

  return { localPath, defaultBranch };
}

export async function cleanupWorkDir(localPath: string): Promise<void> {
  try {
    await rm(localPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

export async function commitAllChanges(
  localPath: string,
  message: string,
): Promise<boolean> {
  const git = simpleGit(localPath);
  const status = await git.status();
  if (status.isClean()) {
    return false;
  }
  await git.add(".");
  await git.commit(message);
  return true;
}

export async function pushToRemote(
  localPath: string,
  remoteName: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(localPath);
  await git.push(remoteName, branch, ["--set-upstream"]);
}
