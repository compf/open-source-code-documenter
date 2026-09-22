import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_READ_CHARS = 120_000;
const MAX_GREP_MATCHES = 80;
const MAX_GLOB_RESULTS = 200;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

function resolveSafe(cwd: string, relativeOrAbsolute: string): string {
  const absolute = path.isAbsolute(relativeOrAbsolute)
    ? path.normalize(relativeOrAbsolute)
    : path.resolve(cwd, relativeOrAbsolute);
  const root = path.resolve(cwd);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`Path escapes working directory: ${relativeOrAbsolute}`);
  }
  return absolute;
}

function toRelative(cwd: string, absolute: string): string {
  return path.relative(cwd, absolute) || ".";
}

function matchGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(normalized);
}

async function walkFiles(cwd: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(cwd, absolute, out);
    } else if (entry.isFile()) {
      out.push(toRelative(cwd, absolute));
    }
  }
}

export const CLAUDE_TOOL_DEFINITIONS = [
  {
    name: "list_dir",
    description: "List files and directories at a path relative to the repo root.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to repo root (default: '.')",
        },
      },
      required: [] as string[],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern under the repo root.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. 'src/**/*.ts'",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents with a regular expression.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regular expression pattern" },
        path: {
          type: "string",
          description: "Optional subdirectory or file to search within",
        },
        glob: {
          type: "string",
          description: "Optional filename glob filter, e.g. '*.ts'",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to repo root" },
        offset: {
          type: "number",
          description: "1-based start line (optional)",
        },
        limit: {
          type: "number",
          description: "Max number of lines to return (optional)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file. Creates parent directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to repo root" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string occurrence in a file. Fails if old_string is not found uniquely (unless replace_all).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to repo root" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence (default false)",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
] as const;

type ToolInput = Record<string, unknown>;

export async function executeClaudeTool(
  cwd: string,
  name: string,
  input: ToolInput,
): Promise<string> {
  try {
    switch (name) {
      case "list_dir":
        return await listDir(cwd, String(input.path ?? "."));
      case "glob":
        return await globFiles(cwd, String(input.pattern ?? ""));
      case "grep":
        return await grepFiles(
          cwd,
          String(input.pattern ?? ""),
          input.path ? String(input.path) : undefined,
          input.glob ? String(input.glob) : undefined,
        );
      case "read_file":
        return await readTextFile(
          cwd,
          String(input.path ?? ""),
          typeof input.offset === "number" ? input.offset : undefined,
          typeof input.limit === "number" ? input.limit : undefined,
        );
      case "write_file":
        return await writeTextFile(
          cwd,
          String(input.path ?? ""),
          String(input.content ?? ""),
        );
      case "edit_file":
        return await editTextFile(
          cwd,
          String(input.path ?? ""),
          String(input.old_string ?? ""),
          String(input.new_string ?? ""),
          Boolean(input.replace_all),
        );
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function listDir(cwd: string, relativePath: string): Promise<string> {
  const dir = resolveSafe(cwd, relativePath || ".");
  const entries = await readdir(dir, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.isDirectory() ? "dir" : "file"}\t${e.name}`);
  return lines.join("\n") || "(empty)";
}

async function globFiles(cwd: string, pattern: string): Promise<string> {
  if (!pattern.trim()) {
    return "Error: pattern is required";
  }
  const all: string[] = [];
  await walkFiles(cwd, cwd, all);
  const matches = all.filter((f) => matchGlob(f, pattern)).slice(0, MAX_GLOB_RESULTS);
  return matches.length ? matches.join("\n") : "No matches";
}

async function grepFiles(
  cwd: string,
  pattern: string,
  searchPath?: string,
  fileGlob?: string,
): Promise<string> {
  if (!pattern.trim()) {
    return "Error: pattern is required";
  }
  const target = searchPath ? resolveSafe(cwd, searchPath) : cwd;
  const info = await stat(target);
  const args = ["-rn", "--color=never", "-E", pattern];
  if (fileGlob) {
    args.push(`--include=${fileGlob}`);
  }
  args.push(info.isDirectory() ? toRelative(cwd, target) || "." : toRelative(cwd, target));
  try {
    const { stdout } = await execFileAsync("grep", args, {
      cwd,
      maxBuffer: 4_000_000,
    });
    const allLines = stdout.split("\n").filter(Boolean);
    const lines = allLines.slice(0, MAX_GREP_MATCHES);
    const truncated =
      allLines.length > MAX_GREP_MATCHES
        ? `\n... truncated to ${MAX_GREP_MATCHES} matches`
        : "";
    return (lines.join("\n") || "No matches") + truncated;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return "No matches";
    return `grep failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function readTextFile(
  cwd: string,
  relativePath: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const file = resolveSafe(cwd, relativePath);
  const raw = await readFile(file, "utf8");
  let lines = raw.split("\n");
  const start = offset && offset > 0 ? offset - 1 : 0;
  if (start > 0 || limit) {
    lines = lines.slice(start, limit ? start + limit : undefined);
  }
  let text = lines.map((line, i) => `${start + i + 1}|${line}`).join("\n");
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS) + "\n... truncated";
  }
  return text || "(empty file)";
}

async function writeTextFile(
  cwd: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const file = resolveSafe(cwd, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return `Wrote ${toRelative(cwd, file)} (${content.length} chars)`;
}

async function editTextFile(
  cwd: string,
  relativePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<string> {
  const file = resolveSafe(cwd, relativePath);
  await access(file);
  const raw = await readFile(file, "utf8");
  if (!raw.includes(oldString)) {
    return "Error: old_string not found in file";
  }
  if (!replaceAll) {
    const first = raw.indexOf(oldString);
    const second = raw.indexOf(oldString, first + oldString.length);
    if (second !== -1) {
      return "Error: old_string found multiple times; set replace_all=true or provide more context";
    }
  }
  const updated = replaceAll
    ? raw.split(oldString).join(newString)
    : raw.replace(oldString, newString);
  await writeFile(file, updated, "utf8");
  return `Edited ${toRelative(cwd, file)}`;
}
