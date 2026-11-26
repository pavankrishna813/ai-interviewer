# Scripts & Development Reference Manual

> **Application:** Troven (Aural OSS)  
> **Repository:** `ai-interviewer`  
> **Tech Stack:** Next.js 14 (App Router) • React 18 • TypeScript 5 • Supabase (PostgreSQL / RLS / Auth / Storage) • tRPC • Tailwind CSS • WebSockets (Volcengine Doubao S2S & OpenAI Realtime) • Monaco Editor • Excalidraw

This document serves as the comprehensive reference manual for all development scripts, database operations, background relay servers, testing pipelines, seeding utilities, and execution environments available within this application.

---

## Table of Contents

1. [Quick Reference Cheat Sheet](#1-quick-reference-cheat-sheet)
2. [Prerequisites & Initial Setup](#2-prerequisites--initial-setup)
3. [Core Application Scripts (`package.json`)](#3-core-application-scripts-packagejson)
4. [Voice Relay Servers (Real-time Speech-to-Speech)](#4-voice-relay-servers-real-time-speech-to-speech)
5. [Database Management & Supabase Workflows](#5-database-management--supabase-workflows)
6. [Data Seeding Utility (`scripts/seed_roles.ts`)](#6-data-seeding-utility-scriptsseed_rolests)
7. [Testing & Quality Assurance Scripts](#7-testing--quality-assurance-scripts)
8. [Code Execution Sandbox & Proctoring](#8-code-execution-sandbox--proctoring)
9. [Developer REST API (`/api/v1`) Workflows](#9-developer-rest-api-apiv1-workflows)
10. [Continuous Integration (CI/CD) Pipeline](#10-continuous-integration-cicd-pipeline)
11. [Environment Variables Dictionary](#11-environment-variables-dictionary)
12. [Troubleshooting & FAQ](#12-troubleshooting--faq)

---

## 1. Quick Reference Cheat Sheet

| Command | Category | Description | Default Port / Target |
| :--- | :--- | :--- | :--- |
| `npm run dev` | Core | Start Next.js development server | `http://localhost:3000` |
| `npm run build` | Core | Build production-ready Next.js bundle | `.next/` |
| `npm run start` | Core | Run production Next.js server | `http://localhost:3000` |
| `npm run lint` | QA | Run ESLint across code workspace | Next.js ESLint |
| `npx tsc --noEmit` | QA | Run TypeScript type checks | Whole workspace |
| `npm run dev:voice` | Voice | Start Volcengine Doubao S2S Voice Relay | `ws://localhost:8081` |
| `npm run dev:openai-voice` | Voice | Start Azure / OpenAI Realtime Voice Relay | `ws://localhost:8082` |
| `npm run db:types` | Database | Regenerate Supabase TypeScript types | `src/lib/supabase/types.ts` |
| `npm run test:web` | Testing | Run all 13 unit & integration test suites | Node test runner + `tsx` |
| `npm run test:functional`| Testing | Run Playwright browser functional E2E tests | Headless Chromium |
| `npx tsx tests/live-session-simulation.ts` | Testing | Simulate live WebSocket interview session | `ws://localhost:8082` |
| `npx tsx scripts/seed_roles.ts` | Database | Seed preconfigured interview roles and questions | Supabase DB |
| `npx supabase start` | Database | Start local Supabase Docker containers | `54321` (API), `54322` (DB) |
| `npx supabase db reset` | Database | Wipe local DB and re-apply all migrations | Supabase Local |
| `npx supabase db push` | Database | Push migrations to remote Supabase project | Remote Supabase |

---

## 2. Prerequisites & Initial Setup

### System Requirements
* **Node.js**: `v18.0.0` or higher (`v20.x` or `v22.x` recommended)
* **npm**: `v9.0.0` or higher
* **Docker Desktop**: Required only when running local Supabase (`supabase start`) or local Piston code runner.
* **API Keys**: At least one LLM provider configured (`OPENAI_API_KEY`, `KIMI_API_KEY`, or `MINIMAX_API_KEY`).

### Step-by-Step Setup

```bash
# 1. Install workspace dependencies
npm install

# 2. Duplicate environment configuration
cp .env.example .env.local

# 3. If using local Supabase (requires Docker running):
npx supabase start

# 4. Generate TypeScript database types
npm run db:types
```

> [!IMPORTANT]
> If you encounter `Cannot find package 'tsx'`, it means `node_modules` is not yet installed. Run `npm install` in the project root directory first.

---

## 3. Core Application Scripts (`package.json`)

### `npm run dev`
* **Command:** `next dev`
* **Purpose:** Runs the Next.js development server with hot-module replacement (HMR).
* **Port:** `3000` (customizable via `next dev --port <PORT>`).
* **Key Routes:**
  * Landing page: `http://localhost:3000`
  * Sign in / Register: `http://localhost:3000/login` | `http://localhost:3000/register`
  * Dashboard: `http://localhost:3000/dashboard`
  * Candidate Interview Experience: `http://localhost:3000/i/[slug]`

### `npm run build`
* **Command:** `next build`
* **Purpose:** Compiles the application for production.
* **Details:**
  * Bundles client-side pages and serverless API routes.
  * Treats `pdf-parse`, `ws`, `bufferutil`, `utf-8-validate`, and `esbuild` as external server components.
  * Server-side bundling aliases `@vladmandic/human` to `false` to avoid SSR browser-canvas compilation errors.

### `npm run start`
* **Command:** `next start`
* **Purpose:** Boots the optimized production server after `npm run build`.
* **Port:** Default `3000`.

### `npm run lint`
* **Command:** `next lint`
* **Purpose:** Runs ESLint checks using `.eslintrc.json` and Next.js presets.

---

## 4. Voice Relay Servers (Real-time Speech-to-Speech)

Aural supports real-time voice interviews using low-latency WebSocket relay servers. Because browsers cannot attach custom authentication headers to standard WebSocket connections, these Node.js relay servers sit between the candidate's browser and speech API backends.

```
Candidate Browser ◄──WebSocket──► Voice Relay Server (Node.js) ◄──WebSocket──► AI Voice API
```

### 1. Primary Relay: Volcengine Doubao (`npm run dev:voice`)
* **File:** `server/voice-relay.ts`
* **Protocol & Helpers:** `server/volcengine-protocol.ts`, `server/volcengine-asr.ts`, `server/voice-relay-helpers.ts`
* **Port:** `8081` (fallback `8766`, set by `VOICE_RELAY_PORT`)
* **Frontend Connection:** `NEXT_PUBLIC_VOICE_RELAY_URL=ws://localhost:8081`
* **Capabilities:**
  * Full Speech-to-Speech (S2S) processing.
  * Multi-lingual support (optimized for Chinese & English).
  * Per-question interview state tracking with LLM context summarization.
  * Automatic server-side reconnection (up to 3 retries with backoff).
  * SayHello prompts and candidate turn detection.
* **Required Environment Variables:**
  ```env
  VOICE_RELAY_PORT=8081
  DOUBAO_APP_ID=your_app_id
  DOUBAO_ACCESS_TOKEN=your_access_token
  DOUBAO_SECRET_KEY=your_secret_key
  DOUBAO_APP_KEY=your_app_key
  DOUBAO_RESOURCE_ID=your_resource_id
  DOUBAO_VOICE_ZH=your_chinese_voice_id
  DOUBAO_VOICE_EN=your_english_voice_id
  ```

### 2. Secondary Relay: Azure OpenAI / Direct OpenAI (`npm run dev:openai-voice`)
* **File:** `server/openai-voice-relay.ts`
* **Helpers:** `server/openai-voice-relay-helpers.ts`
* **Port:** `8082` (fallback `8767`, set by `OPENAI_VOICE_RELAY_PORT`)
* **Frontend Connection:** `NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL=ws://localhost:8082`
* **Capabilities:**
  * Azure OpenAI Realtime API (`gpt-4o-realtime-preview` / `gpt-realtime-1.5`) OR Direct OpenAI Realtime (`gpt-realtime-mini`).
  * Real-time Whisper transcription (`whisper-1`).
  * Proctoring disruption alerts (warns candidates if face leaves camera or tab changes).
  * Echo stripping, candidate barge-in detection, and answer completion signals.
* **Required Environment Variables:**
  ```env
  OPENAI_VOICE_RELAY_PORT=8082
  # For Azure:
  AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
  AZURE_OPENAI_API_KEY=your_azure_key
  AZURE_OPENAI_DEPLOYMENT=gpt-4o-realtime-preview
  AZURE_OPENAI_VOICE=alloy
  # Or for direct OpenAI:
  OPENAI_API_KEY=sk-...
  ```

> [!TIP]
> Both relays can run simultaneously in separate terminals. Set `NEXT_PUBLIC_VOICE_RELAY_PRIMARY=auto` to let the application automatically select the optimal relay based on the interview's configured language.

---

## 5. Database Management & Supabase Workflows

Troven relies on Supabase for PostgreSQL database, Row Level Security (RLS), Authentication, and S3-compatible audio/attachment storage.

### Schema & Migrations Structure
All migrations reside in `supabase/migrations/`:
* `001_initial_schema.sql`: Core schema (users, profiles, organizations, projects, interviews, questions, sessions, transcripts, evaluations, api_keys, webhooks).
* `002_activity_segments.sql`: Real-time session activity segment tracking.
* `003_audio_recordings.sql`: Multi-segment interview audio recordings and metadata.
* `combined_schema.sql`: Single consolidated script for executing full schema setup manually in Supabase SQL Editor.

### Supabase CLI Commands

#### Starting Local Database Containers
```bash
npx supabase start
```
Spins up Docker containers for:
* PostgreSQL Database: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
* REST & Auth API: `http://127.0.0.1:54321`
* Supabase Studio (Web GUI): `http://127.0.0.1:54323`
* InBucket (Email testing inbox): `http://127.0.0.1:54324`

#### Generating TypeScript Types
```bash
npm run db:types
# Under the hood:
# npx supabase gen types typescript --local > src/lib/supabase/types.ts
```
Generates end-to-end type safety for all database tables, columns, enums, and JSON structures into `src/lib/supabase/types.ts`.

#### Resetting Local Database
```bash
npx supabase db reset
```
Drops local database tables and re-executes all migrations from scratch in clean sequential order.

#### Deploying Migrations to Supabase Cloud
```bash
# Link local CLI to your cloud project
npx supabase link --project-ref <your-project-ref>

# Push pending migrations
npx supabase db push
```

---

## 6. Data Seeding Utility (`scripts/seed_roles.ts`)

* **Script Path:** `scripts/seed_roles.ts`
* **Execution Command:**
  ```bash
  npx tsx scripts/seed_roles.ts
  ```

### What It Does
Populates Supabase with production-grade interview templates, assessment criteria rubrics, and structured interview questions across real-world tech roles:
1. **Backend Python Engineer** (FastAPI, ASGI, Concurrency, Pydantic, Microservice Architecture, Coding Question)
2. **Frontend React Developer** (React 18, Reactivity, Hooks, DOM Reconciliation, State Management)
3. Additional pre-configured technical and behavioral tracks.

### Question Types Generated
* `OPEN_ENDED`: Multi-turn conversational questions with targeted AI follow-up probes.
* `CODING`: Interactive live-coding challenges with Monaco editor starter code and test execution.
* `WHITEBOARD`: System design questions utilizing Excalidraw canvas.

### Prerequisites to Run Seeder
Ensure `.env` or `.env.local` contains:
```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

---

## 7. Testing & Quality Assurance Scripts

### 1. Web Unit & Integration Tests (`npm run test:web`)
* **Execution:**
  ```bash
  npm run test:web
  ```
* **Engine:** Node.js native test runner (`node --import tsx --test`)
* **Coverage Scope:**
  * `tests/session-score.test.ts`: Scoring algorithm, category weights, and multi-dimensional analysis.
  * `tests/relay-routing.test.ts`: Relay auto-detection and language routing logic.
  * `tests/voice-save-route.test.ts`: Audio recording upload, persistence, and S3 / Supabase storage endpoints.
  * `tests/playback-jitter-buffer.test.ts`: Client-side audio packet buffer and latency handling.
  * `tests/openai-voice-relay-helpers.test.ts`: Audio framing, echo cancellation, barge-in detection, and wrap-up triggers.
  * `tests/voice-interview-flow.test.ts`: Full state machine transition of voice interviews.
  * `tests/interviewer-failure-modes.test.ts`: Handling LLM timeouts, network degradation, and fallback states.
  * `tests/voice-relay-helpers.test.ts`: Volcengine audio protocol encoding and chunk parsing.
  * `tests/api-rate-limit.test.ts`: In-memory sliding window rate-limiter (60 requests/min).
  * `tests/interview-templates.test.ts`: Template loading, validation, and question formatting.
  * `tests/api-key-auth.test.ts`: Validation of `dlv_*` API keys and permission scoping.
  * `tests/session-lifecycle.test.ts`: Lifecycle states (`pending` -> `in_progress` -> `completed` / `expired`).
  * `tests/voice-relay-reconnect.test.ts`: Relay reconnection logic with exponential backoff.

### 2. Functional End-to-End Tests (`npm run test:functional`)
* **Execution:**
  ```bash
  npm run test:functional
  ```
* **Engine:** Playwright + Node Test Runner (`node --import tsx --test --test-concurrency=1 tests/functional.test.ts`)
* **Scope:**
  * Automatically spawns an isolated Next.js dev server on a dynamic free port with `ENABLE_FUNCTIONAL_TEST_PAGES=1`.
  * Launches headless Chromium to test candidate audio permission checklists, microphone capture, and simulated voice relay streams.

### 3. Live Session Simulation Script (`tests/live-session-simulation.ts`)
* **Execution:**
  ```bash
  npx tsx tests/live-session-simulation.ts
  ```
* **Purpose:** Simulates a candidate connecting to the OpenAI Voice Relay (`ws://localhost:8082`), sends init context with conceptual and coding questions, triggers greeting, responds to questions, and validates audio streaming events.

### 4. Static Type Verification
* **Execution:**
  ```bash
  npx tsc --noEmit
  ```
* **Purpose:** Verifies that all TypeScript definitions compile without errors across both frontend and backend routers.

---

## 8. Code Execution Sandbox & Proctoring

Troven allows candidates to execute code during live coding assessments.

### Code Execution Flow
* **API Endpoint:** `/api/code/execute` (`src/app/api/code/execute/route.ts`)
* **In-Browser Sandbox:** `src/lib/code-runner/sandbox-runner.ts` (Isolated Web Worker with infinite-loop detection)
* **Server-Side Execution Modes:**
  1. **JavaScript / TypeScript / React:** Executed in-process via Node.js `vm` module and `esbuild` transpiler. React components are statically rendered via `react-dom/server`.
  2. **Python / C / C++ / Go / Java / Rust / SQL / Bash:**
     * **Remote Runner:** If `PISTON_URL` is set (default: `http://127.0.0.1:2000`), execution is dispatched to a sandboxed Piston instance.
     * **Local Runner:** If Piston is unavailable, falls back to local processes (`python3`, `node`, `gcc`, etc.) with strict timeouts (4000ms).

### Anti-Cheating & Proctoring Stack
* **Location:** `src/lib/proctor/`
  * `vision-proctor.ts`: MediaPipe vision task orchestrator (`@mediapipe/tasks-vision`).
  * `face-check.ts`: Real-time face detection (verifies only one candidate is visible).
  * `human-check.ts`: Body posture and gaze verification (`@vladmandic/human`).
  * Client event listeners: Tab switch tracking (`visibilitychange`), multi-monitor detection, and clipboard paste interception.

---

## 9. Developer REST API (`/api/v1`) Workflows

The platform exposes a REST API for programmatic interview management.

* **OpenAPI 3.1 Specification:** `GET /api/v1/openapi.json`
* **Authentication:** HTTP Bearer token prefixed with `dlv_`:
  ```http
  Authorization: Bearer dlv_your_api_key_here
  ```
* **Rate Limiting:** 60 requests per minute per key (returns `429 Too Many Requests` with `Retry-After`).

### Core Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/interviews` | List interviews (paginated) |
| `POST` | `/api/v1/interviews` | Create a new interview |
| `GET` | `/api/v1/interviews/{id}` | Retrieve interview details & questions |
| `PATCH` | `/api/v1/interviews/{id}` | Update interview settings or rubric |
| `DELETE`| `/api/v1/interviews/{id}` | Archive interview |
| `POST` | `/api/v1/interviews/{id}/publish` | Generate public shareable candidate link |
| `GET` | `/api/v1/interviews/{id}/questions` | List questions for interview |
| `POST` | `/api/v1/interviews/{id}/questions` | Bulk create or append questions |
| `GET` | `/api/v1/interviews/{id}/sessions` | List candidate interview sessions |
| `GET` | `/api/v1/sessions/{id}` | Retrieve session report, score & transcript |
| `GET` | `/api/v1/usage` | Organization token usage & interview stats |

### Example API Request (cURL)
```bash
# 1. Create a voice interview
curl -X POST http://localhost:3000/api/v1/interviews \
  -H "Authorization: Bearer dlv_demo_key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Senior Cloud Architect",
    "voiceEnabled": true,
    "chatEnabled": true,
    "timeLimitMinutes": 30
  }'

# 2. Add question to interview
curl -X POST http://localhost:3000/api/v1/interviews/<INTERVIEW_ID>/questions \
  -H "Authorization: Bearer dlv_demo_key" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "text": "How do you architect zero-downtime database migrations in distributed Kubernetes clusters?",
      "type": "OPEN_ENDED",
      "order": 0
    }
  ]'
```

---

## 10. Continuous Integration (CI/CD) Pipeline

* **File:** `.github/workflows/ci.yml`
* **Triggers:** Push to `main` branch or Pull Requests targeting `main`.

### Pipeline Stages
1. **Checkout & Environment Setup:** Node.js `20.x` with npm package cache.
2. **Clean Dependency Install:** `npm ci`
3. **Lint Verification:** `npm run lint`
4. **TypeScript Type Check:** `npx tsc --noEmit`
5. **Test Suite Execution:** `npm run test:web --if-present`

---

## 11. Environment Variables Dictionary

All variables should be placed in `.env.local` for local development.

### Supabase & Database
| Variable | Description | Local Value |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL exposed to browser | `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anonymous key for client requests | `<from supabase status>` |
| `SUPABASE_URL` | Server-side Supabase URL | `http://127.0.0.1:54321` |
| `SUPABASE_ANON_KEY` | Server-side anonymous key | `<from supabase status>` |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key bypassing RLS policies | `<from supabase status>` |
| `DATABASE_URL` | Direct PostgreSQL connection string | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

### LLM Providers
| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `OPENAI_API_KEY` | OpenAI API key (Chat, Whisper, Generation) | `sk-...` |
| `OPENAI_BASE_URL` | Optional proxy URL for OpenAI compatible endpoints | `https://api.openai.com/v1` |
| `KIMI_API_KEY` | Moonshot Kimi API key (Alternative provider) | `sk-...` |
| `KIMI_BASE_URL` | Moonshot base URL | `https://api.moonshot.cn/v1` |
| `MINIMAX_API_KEY` | MiniMax API key (Alternative provider) | `sk-...` |
| `MINIMAX_BASE_URL` | MiniMax base URL | `https://api.minimax.chat/v1` |
| `REPORT_MODEL` | Override model for post-session reports | `gpt-4o` / `kimi-k2.5` |
| `GENERATOR_MODEL` | Override model for interview question generation | `gpt-4o-mini` |

### Voice Relays & Speech-to-Speech
| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `VOICE_RELAY_PORT` | Port for Volcengine Doubao S2S relay | `8081` |
| `OPENAI_VOICE_RELAY_PORT` | Port for Azure / OpenAI Realtime relay | `8082` |
| `NEXT_PUBLIC_VOICE_RELAY_URL` | Browser WebSocket URL for Volcengine relay | `ws://localhost:8081` |
| `NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL`| Browser WebSocket URL for OpenAI relay | `ws://localhost:8082` |
| `NEXT_PUBLIC_VOICE_RELAY_PRIMARY` | Relay selection mode (`auto`, `voice`, `openai`) | `auto` |
| `DOUBAO_APP_ID` | Volcengine Doubao Application ID | - |
| `DOUBAO_ACCESS_TOKEN` | Volcengine Bearer Access Token | - |
| `DOUBAO_SECRET_KEY` | Volcengine Secret Key | - |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint URL | `https://xxx.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API Key | - |
| `AZURE_OPENAI_DEPLOYMENT` | Azure Realtime deployment model name | `gpt-4o-realtime-preview` |

---

## 12. Troubleshooting & FAQ

### Q1: `Cannot find package 'tsx'` when running test scripts
**Cause:** Node dependencies have not yet been installed in your workspace.  
**Resolution:** Run `npm install` before executing any test or seed scripts.

### Q2: Port 8081 or 8082 is already in use
**Cause:** A previous voice relay instance is still running in the background.  
**Resolution:**
```powershell
# On Windows (PowerShell):
Get-Process -Id (Get-NetTCPConnection -LocalPort 8081,8082).OwningProcess | Stop-Process -Force
```

### Q3: How to test the voice interview locally without Chinese Volcengine keys?
**Resolution:** Use the OpenAI voice relay:
1. Ensure `OPENAI_API_KEY` is present in `.env.local`.
2. Start the OpenAI relay: `npm run dev:openai-voice`.
3. In `.env.local`, set `NEXT_PUBLIC_VOICE_RELAY_PRIMARY=openai`.

### Q4: Database migration errors during `supabase start`
**Cause:** Stale Docker volumes or conflicting containers.  
**Resolution:**
```bash
npx supabase stop --no-backup
npx supabase start
```
