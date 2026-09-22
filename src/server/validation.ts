import { z } from "zod";

const GITHUB_REPO_REGEX =
  /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i;

export function parseGithubUrl(url: string): {
  owner: string;
  repo: string;
  cloneUrl: string;
  webUrl: string;
} {
  const normalized = url.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
  const match = normalized.match(
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)$/i,
  );
  if (!match) {
    throw new Error(
      "Invalid GitHub URL. Expected format: https://github.com/owner/repo",
    );
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    webUrl: `https://github.com/${owner}/${repo}`,
  };
}

export const startJobSchema = z.object({
  githubUrl: z
    .string()
    .min(1)
    .refine((v) => GITHUB_REPO_REGEX.test(v.trim()) || parseGithubUrlSafe(v), {
      message: "Must be a valid GitHub repository URL",
    }),
  gitlabNamespace: z.string().min(1).optional(),
  gitlabHost: z.string().url().optional(),
  gitlabToken: z.string().min(1).optional(),
  cursorApiKey: z.string().min(1).optional(),
  claudeApiKey: z.string().min(1).optional(),
  agentProvider: z.enum(["cursor", "claude"]).optional(),
  agentModel: z.string().min(1).optional(),
  workerConcurrency: z.number().int().min(1).max(8).optional(),
  branch: z.string().min(1).optional(),
});

function parseGithubUrlSafe(url: string): boolean {
  try {
    parseGithubUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function normalizeGitlabHost(host: string): string {
  return host.replace(/\/$/, "");
}
