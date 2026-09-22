export interface AgentStreamEvent {
  type: "text" | "status" | "tool" | "error";
  content: string;
}

export interface DocumentationPart {
  id: string;
  title: string;
  paths: string[];
  focus: string;
}

export interface DocumentationPlan {
  rationale: string;
  parts: DocumentationPart[];
}

export const SHARED_CONSTRAINTS = `
## Shared constraints (all agents)

- **Do NOT** run git commands, create commits, or push — only modify files in the working tree
- **Do NOT** delete existing documentation; improve and extend it
- **Do NOT** add license headers or change licensing
- **Do NOT** break existing functionality — documentation / comments only
- Skip generated, vendor, binary, lockfile, and build-output artifacts
- Prefer American English; short paragraphs; define jargon on first use
- Use Mermaid diagrams where they clarify architecture or flows
`.trim();

export const PLANNER_PROMPT = `You are a documentation planning agent. Explore this repository and decide how to split it into independent documentation parts so multiple worker agents can document it thoroughly in parallel.

## Your job

1. Explore the repository structure (top-level dirs, entry points, packages/modules).
2. Choose a good number of parts **n** (typically 2–8; use 1 only for tiny repos; use more for large multi-package monorepos).
3. Assign **disjoint** path sets so workers will not edit the same files.
4. Leave cross-cutting root docs (README overhaul, docs/ARCHITECTURE.md, CONTRIBUTING.md, glossary) for a later integrator — do **not** assign those global files exclusively to a worker unless a part owns a nested package README.

## Output format

When finished exploring, reply with **only** a single JSON object (no markdown fences, no commentary) matching:

{
  "rationale": "brief why this split",
  "parts": [
    {
      "id": "part-1",
      "title": "short title",
      "paths": ["src/auth", "src/middleware/auth.ts"],
      "focus": "what to document deeply in this part"
    }
  ]
}

Rules for parts:
- paths are repo-relative directories and/or files
- parts must not overlap
- cover the important source areas; omit noise dirs (node_modules, dist, .git, vendor, build)
- n should reflect repo size/complexity

${SHARED_CONSTRAINTS}

- **Do not modify any files** during planning — explore and emit the JSON plan only

Begin by exploring, then output the JSON plan only as your final message.`;

export function buildWorkerPrompt(part: DocumentationPart, allParts: DocumentationPart[]): string {
  const otherParts = allParts
    .filter((p) => p.id !== part.id)
    .map((p) => `- ${p.id}: ${p.title} → ${p.paths.join(", ")}`)
    .join("\n");

  return `You are a documentation worker agent. Document **only** your assigned part of this repository as extensively as possible.

## Your assignment

- **Part id:** ${part.id}
- **Title:** ${part.title}
- **Paths (you may edit only these):** ${part.paths.join(", ")}
- **Focus:** ${part.focus}

## Other parts (do NOT edit their files)

${otherParts || "(none)"}

## Required deliverables for your part

1. **Inline documentation** — add or expand docstrings / JSDoc / TSDoc / Javadoc / doc comments on every public function, class, method, and non-trivial type under your paths.
2. **Class / module-level comments** — explain purpose, responsibilities, and how the piece fits the system.
3. **Brief inline comments** for non-obvious logic, algorithms, and business rules (not for self-explanatory one-liners).
4. **Module README** — if a significant directory lacks a README.md, add one explaining the module's role and key entry points.
5. **Nested docs** — optional \`docs/\` notes under your area only if they help (do not rewrite the root README).

## Style

- Beginner-friendly, concrete examples, define domain terms
- Language-appropriate comment styles (Javadoc for Java, godoc for Go, etc.)

${SHARED_CONSTRAINTS}

- Stay strictly within your assigned paths; if you need context from other areas, read them but do not modify them

Process: explore your paths, then systematically add documentation throughout. Be thorough — depth over breadth outside your paths.`;
}

export const INTEGRATOR_PROMPT = `You are a documentation integrator agent. Worker agents have already added deep inline and module-level documentation to different parts of this repository. Your job is to create and improve **cross-cutting** documentation that ties the project together.

## Required deliverables

### 1. Root README overhaul
- Executive summary in plain language
- Prerequisites with why each is needed
- Step-by-step getting started
- Architecture overview with a Mermaid diagram
- Directory structure guide for top-level folders
- Configuration reference, common workflows, troubleshooting
- Glossary of domain-specific terms

### 2. docs/ directory (create if missing)
- \`docs/ARCHITECTURE.md\` — system design, data flow, component interactions (Mermaid)
- \`docs/GETTING_STARTED.md\` — first-time tutorial
- \`docs/CONCEPTS.md\` — domain/topic from first principles
- \`docs/API.md\` or \`docs/MODULES.md\` — public APIs / key modules
- \`docs/DEVELOPMENT.md\` — develop, test, debug, contribute
- \`docs/DIAGRAMS.md\` — additional Mermaid diagrams

### 3. CONTRIBUTING.md
- Workflow, style, tests, PR expectations

## Style

- Write for a smart developer new to this codebase and domain
- Prefer improving existing docs over deleting them
- Do not undo or strip worker inline comments; you may lightly adjust README/module docs for consistency

${SHARED_CONSTRAINTS}

Process: skim the repo structure and a sample of documented modules, then produce the cross-cutting docs above.`;

/** @deprecated Prefer multi-agent prompts; kept for reference / single-agent fallback */
export const DOCUMENTATION_PROMPT = `You are an expert technical writer and software educator. Your task is to add **extensive, beginner-friendly documentation** to this repository so that someone completely unfamiliar with both this codebase AND the domain/topic it covers can understand most of it.

## Goals

Make this repo approachable to a smart developer who has never seen this project or field before. Go far beyond typical open-source documentation.

## Required deliverables

### 1. Root README overhaul
- Executive summary in plain language (what problem this solves, for whom)
- Prerequisites with explanations of *why* each tool/library is needed
- Step-by-step getting started (clone, install, configure, run, test)
- Architecture overview with a Mermaid diagram
- Directory structure guide explaining every top-level folder
- Configuration reference
- Common workflows and troubleshooting
- Glossary of domain-specific terms used in this project

### 2. docs/ directory (create if missing)
Create comprehensive guides:
- \`docs/ARCHITECTURE.md\` — system design, data flow, component interactions (include Mermaid diagrams)
- \`docs/GETTING_STARTED.md\` — tutorial for first-time users
- \`docs/CONCEPTS.md\` — explain the underlying domain/topic from first principles
- \`docs/API.md\` or \`docs/MODULES.md\` — document public APIs, modules, or key interfaces
- \`docs/DEVELOPMENT.md\` — how to develop, test, debug, and contribute
- \`docs/DIAGRAMS.md\` — additional Mermaid diagrams (sequence, class, flow, deployment)

### 3. Inline code documentation
- Add or expand docstrings/JSDoc/TSDoc/doc comments on **every** public function, class, method, and non-trivial type
- Add brief inline comments explaining non-obvious logic, algorithms, and business rules
- Do NOT add noisy comments on self-explanatory one-liners

### 4. Package / module READMEs
- Add or expand README.md in significant subdirectories explaining that module's role and how it connects to the rest

### 5. CONTRIBUTING.md
- Contribution workflow, code style, how to run tests, PR expectations

## Style guidelines

- Write for clarity: short paragraphs, concrete examples, avoid jargon or define it immediately
- Use analogies where helpful for complex concepts
- Include code examples that can be copy-pasted
- Use Mermaid for architecture, sequence, and flow diagrams
- Prefer American English
- Do not remove or break existing functionality — documentation changes only unless a tiny comment-only adjacent fix is needed

${SHARED_CONSTRAINTS}

## Process

1. Explore the repository structure and understand what it does
2. Identify the domain concepts a newcomer would need
3. Create the docs/ structure and README overhaul
4. Add inline documentation throughout the codebase systematically
5. Add diagrams that reflect the actual architecture you discovered

Begin by exploring the codebase, then implement all documentation deliverables.`;
