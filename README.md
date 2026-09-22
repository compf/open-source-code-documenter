# Open Source Code Documenter

Mirror a GitHub repository to a GitLab namespace, then use a **multi-agent documentation pipeline** (Cursor or Claude) to add extensive, beginner-friendly documentation. The documented result is pushed back to GitLab.

Available as an **Electron desktop app** and as a **web UI** served by the same Express backend.

## How it works

```mermaid
flowchart LR
  A[GitHub URL] --> B[Clone locally]
  B --> C[Create GitLab project]
  C --> D[Push mirror to GitLab]
  D --> E[Planner agent]
  E --> F[n worker agents]
  F --> G[Integrator agent]
  G --> H[Commit docs]
  H --> I[Push to GitLab]
```

1. You provide a GitHub repo URL and GitLab namespace.
2. The app clones the repo, creates (or reuses) a GitLab project, and pushes an initial mirror.
3. A **planner** agent explores the repo, chooses how many parts (**n**) to use, and assigns disjoint path sets.
4. Up to *concurrency* **worker** agents run in parallel, each documenting its part as deeply as possible (inline comments, class/module docs, nested READMEs, language-appropriate doc comments such as Javadoc).
5. An **integrator** agent writes cross-cutting docs (root README, `docs/`, `CONTRIBUTING.md`).
6. Changes are committed and pushed to GitLab.

> **Note:** Cursor cloud agents currently clone **GitHub** repos only. This app uses **local** agents on the cloned copy so the final documented repo lives on **GitLab**.

## Prerequisites

- **Node.js** 20+
- **Git** installed and on `PATH`
- One of:
  - **Cursor API key** — [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations)
  - **Anthropic API key** — [Anthropic Console](https://console.anthropic.com/) (for Claude)
- **GitLab personal access token** with `api` and `write_repository` scopes
- A GitLab **group or username** (namespace) where projects can be created

## Setup

```bash
cp .env.example .env
# Edit .env with your credentials

npm install
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `CURSOR_API_KEY` | Cursor user or service-account API key (Cursor provider) |
| `ANTHROPIC_API_KEY` | Anthropic API key (Claude provider); `CLAUDE_API_KEY` also accepted |
| `AGENT_PROVIDER` | Default provider: `cursor` or `claude` |
| `GITLAB_TOKEN` | GitLab PAT (`glpat-...`) |
| `GITLAB_HOST` | GitLab instance URL (default: `https://gitlab.com`) |
| `GITLAB_NAMESPACE` | Target group path or username |
| `PORT` | API server port (default: `3847`) |

You can also enter API keys and pick the provider in the UI (values are sent to your local server only and are not stored).

## Usage

### Desktop (Electron)

```bash
npm run dev
```

This starts the API server, Vite dev frontend, and Electron window.

### Web only

Terminal 1 — API + built frontend:

```bash
npm run start:web
```

Or for development with hot reload:

```bash
# Terminal 1
npm run dev:server

# Terminal 2
npm run dev:client
```

Open [http://localhost:5173](http://localhost:5173) (dev) or [http://localhost:3847](http://localhost:3847) (production).

The web and desktop UIs share the same React frontend and REST/SSE API.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/config` | Non-secret config defaults |
| `POST` | `/api/jobs` | Start a documentation job |
| `GET` | `/api/jobs/:id` | Job status |
| `GET` | `/api/jobs/:id/stream` | SSE live updates |

### Example

```bash
curl -X POST http://localhost:3847/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "githubUrl": "https://github.com/owner/repo",
    "agentProvider": "claude",
    "workerConcurrency": 3
  }'
```

### Job body fields

| Field | Description |
|-------|-------------|
| `githubUrl` | Required GitHub repo URL |
| `agentProvider` | `cursor` or `claude` (defaults to `AGENT_PROVIDER`) |
| `cursorApiKey` / `claudeApiKey` | Optional overrides for `.env` keys |
| `workerConcurrency` | Max parallel workers (1–8, default 3) |
| `agentModel` | Optional model id override |
| `branch` | Optional clone branch |

## Documentation scope

Workers focus on deep, local documentation:

- Inline docstrings / JSDoc / TSDoc / Javadoc / language-appropriate comments
- Class- and module-level explanations
- Per-module READMEs where useful

The integrator adds the project-wide layer:

- Root README with architecture diagram, glossary, and tutorials
- `docs/` guides (`ARCHITECTURE.md`, `CONCEPTS.md`, `GETTING_STARTED.md`, etc.)
- `CONTRIBUTING.md`

Runs take longer on large repositories because many agents explore and edit files; quality on large projects is much higher than a single-agent pass.

## Project structure

```
electron/          # Electron main & preload
src/server/        # Express API, GitLab/GitHub services, multi-agent documenter
src/client/        # React UI (Vite)
data/workspaces/   # Temporary clone directories (gitignored)
```

## License

MIT
