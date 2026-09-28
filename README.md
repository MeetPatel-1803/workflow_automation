# Workflow Automation API

NestJS 11 + TypeScript (strict) · PostgreSQL 16 · Prisma 6 · Redis 7 · JWT (Passport) · Jest.

This repository contains the project foundation, the **AuthModule**, the **UsersModule**, the **WorkflowsModule**
(definition + retrieval) and, as of this step, the **ExecutionsModule** (API-facing scheduling) and the
**WorkflowEngineModule** (the BullMQ worker that actually runs a workflow). This is the core of the whole system —
see "How workflow execution works" below for the state machine, concurrency, retries, and failure-mode reasoning.

> ⚠️ **Migration note:** this step adds the `WorkflowExecution`, `StepExecution` and `IdempotencyRecord` tables plus
> the `ExecutionStatus`/`StepExecutionStatus` enums (`prisma/migrations/20260927132515_add_executions`) on top of the
> earlier `Organization.name` unique constraint, `Workflow` table, and `Workflow.contentHash` migrations. Run
> `npm run prisma:deploy` (or `prisma:migrate` in dev) against your existing dev/test databases to pick all of these
> up — they aren't applied automatically to a database you migrated before these changes.
>
> **This step also adds a second running process — the worker** (`src/worker.ts`, the `worker` service in
> `docker-compose.yml`). `docker compose up` now starts it alongside `api` automatically. If you're running things
> locally without Docker (Option B below), start it in a second terminal: `npm run start:worker:dev`. Nothing gets
> processed — executions sit at `PENDING` forever — without a worker running.

## Setup

Prerequisites: Node 22+, Docker with Compose v2.

### Option A — everything in Docker (single command)

```bash
cp .env.example .env
# generate a real secret and paste it into JWT_SECRET in .env:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

docker compose up --build
```

`docker compose up` starts Postgres and Redis, waits for their healthchecks, runs a one-shot
**`migrate` service** (`prisma migrate deploy`), and only then starts the API
(`depends_on: condition: service_completed_successfully`). No manual migration step is needed.
The API listens on http://localhost:3000.

> The app refuses to boot if `JWT_SECRET` is still the placeholder from `.env.example`.

### Option B — local Node process, infra in Docker

```bash
cp .env.example .env            # then set JWT_SECRET
npm ci
docker compose up -d postgres redis
npm run prisma:generate
npm run prisma:deploy           # apply migrations (use `npm run prisma:migrate` while developing schema changes)
npm run start:dev               # the API
npm run start:worker:dev        # in a second terminal — the worker; nothing executes without this running
```

## Environment Variables

All variables are validated at boot (`src/config/env.validation.ts`, class-validator). The process exits with a
list of problems if any required variable is missing or invalid. Real environment variables take precedence over `.env`.

| Variable                                              | Required     | Default       | Description                                                                                                                                                 |
| ----------------------------------------------------- | ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | yes          | –             | PostgreSQL connection string (`postgresql://user:pass@host:5432/db?schema=public`).                                                                         |
| `JWT_SECRET`                                          | yes          | –             | HMAC secret for HS256. Min 32 chars; rejects single-repeated-char values and the `.env.example` placeholder.                                                |
| `JWT_EXPIRES_IN`                                      | yes*         | `1h`          | Access-token lifetime: seconds (`3600`) or a duration (`15m`, `1h`, `7d`).                                                                                  |
| `REDIS_HOST`                                          | yes          | –             | Redis host (used for shared rate-limit storage; later for BullMQ).                                                                                          |
| `REDIS_PORT`                                          | yes          | –             | Redis port.                                                                                                                                                 |
| `REDIS_DB`                                            | no           | `0`           | Redis logical DB index.                                                                                                                                     |
| `PORT`                                                | no           | `3000`        | HTTP port.                                                                                                                                                  |
| `NODE_ENV`                                            | no           | `development` | `development` \| `production` \| `test`.                                                                                                                    |
| `TRUST_PROXY`                                         | no           | unset         | Reverse-proxy hops to trust when resolving client IPs. **Set this behind a load balancer**, otherwise every client shares the proxy's IP for rate limiting. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose only | –             | Credentials for the `postgres` container; compose builds the API's `DATABASE_URL` from them.                                                                |
| `WORKER_CONCURRENCY`                                   | no           | `5`           | Worker-process only (ignored by the API): how many `workflow-execution` jobs one worker handles concurrently.        |

\* has a default, so effectively optional.

## Running the app

```bash
npm run start:dev     # watch mode
npm run build && npm run start:prod
npm run prisma:studio # browse the database
```

Scripts: `start:dev`, `build`, `start:prod`, `test`, `test:e2e`, `test:cov`, `prisma:migrate`, `prisma:generate`, `prisma:studio`
(plus `prisma:deploy`).

## Running tests

```bash
npm test                 # unit tests (no infrastructure needed)
npm run test:cov         # unit tests + coverage
```

E2E tests run against a **real** Postgres and Redis (nothing mocked):

```bash
docker compose --profile test up -d postgres-test redis
npm run test:e2e
```

The e2e run applies the committed migrations (`prisma migrate deploy`) to the test database before the tests start. Defaults
(`test/test-env.ts`): Postgres `localhost:5433/workflow_test`, Redis `localhost:6379` **DB 15**, which the tests flush
between cases to reset rate-limit counters. Override with `TEST_DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`.
**Redis 6.2+ is required** (BullMQ's own recommendation) — the `redis-test`/`redis` compose services already use
`redis:7`; only worth checking if you point `REDIS_HOST`/`REDIS_PORT` at some other, older instance.

`test/workflow-execution.e2e-spec.ts` boots **both** `AppModule` and `WorkflowEngineWorkerModule` in one test process
(a real worker actually processing jobs, not mocked) and uses `nock` to mock the external HTTP endpoints workflows
call out to — real BullMQ, real Postgres locking, real (mocked-at-the-network-layer) external calls. It also
directly exercises `WorkflowExecutionTickService.processTick()` for the two required concurrency tests (see "How
concurrency is handled"), bypassing the queue entirely so those two are deterministic rather than timing-dependent.

## How auth works

**Tenant model (explicit scope decision).** `POST /auth/register` _always_ creates a brand-new `Organization` with the new
user as its sole member. There is no "join an existing organization" flow; that is intentionally out of scope.

All routes are served under the `/api/v1` prefix (e.g. `POST /api/v1/auth/register`).

| Endpoint              | Body                                    | Success `data`                                | Success `meta.accessToken`  | Errors                                                                                     |
| --------------------- | --------------------------------------- | ---------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /auth/register` | `{ email, password, organizationName }` | `201 { id, email, organizationId }` (the user)  | JWT                           | `400` validation (field-level messages), `409` email already registered, `429`             |
| `POST /auth/login`    | `{ email, password }`                   | `200 { id, email, organizationId }` (the user)  | JWT                           | `400`, `401 "Invalid credentials"` (identical for unknown email and wrong password), `429` |

- **Passwords** are hashed with **argon2id** (`argon2` package, library defaults). Login always performs one argon2
  verification, even for unknown emails (against a dummy hash), so response time doesn't reveal whether an email exists.
- **Registration** creates Organization + User inside one Prisma `$transaction`; a unique-constraint violation (`P2002`, e.g. a race
  between two identical requests) is mapped to `409`. Emails are trimmed and lower-cased before storage/lookup.
- **Organization names are unique** (`Organization.name` has a DB unique constraint). A duplicate name on `POST /auth/register`
  is `409 "Organization name already taken"` — distinguished from a duplicate email by inspecting the Prisma error's
  `meta.modelName` (`Organization` vs `User`), since both are `P2002` on the same transaction. Matching is exact/case-sensitive;
  no normalization (case-folding, whitespace collapsing beyond trim) is applied — out of scope for this assessment.
- **Password policy:** minimum 8 characters (max 128, to bound hashing cost). Stronger policy (complexity rules, breached-password
  checks) is **out of scope** for this assessment.
- **JWT:** HS256, signed with `JWT_SECRET`, payload `{ sub: userId, orgId, email }`, lifetime `JWT_EXPIRES_IN`. The verifier pins
  `algorithms: ['HS256']` (so `alg: none` and other algorithms are rejected).
- **Refresh tokens and token revocation are out of scope.** Short-lived access tokens (default 1h) are the accepted trade-off:
  a stolen token stays valid until it expires, and there is no server-side logout.
- **Secure by default:** `JwtAuthGuard` is registered globally (`APP_GUARD`). Every route requires a valid `Authorization: Bearer <token>`
  unless it is marked `@Public()` (`/auth/*` are). On success `request.user` is `{ userId, orgId, email }`; controllers read it with
  `@CurrentUser()` / `@CurrentUser('orgId')` instead of touching the request.
- **Responses never contain `passwordHash`:** response DTOs use an allow-list (`@Exclude()` at class level + `@Expose()` per field),
  enforced by a global `ClassSerializerInterceptor`.
- **Rate limiting:** `@nestjs/throttler` with a **Redis** store (shared across API instances). Global default 100 req/min per IP;
  `POST /auth/register` 5/min, `POST /auth/login` 10/min. Stricter per-route limits will be added per module as they are built.
- **Global pipes/headers:** `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, `transform`) rejects unknown
  body fields; `helmet` sets security headers.

### Response envelope

Every response — success or error, from any module — has the same two-key shape. Services return only the domain
**payload** (e.g. the user, the organization) plus any non-payload values (e.g. a token); controllers are the only
place that build the envelope, via `ResponseService` (`src/shared/response/apiResponse.service.ts`). `data` holds
*only* the payload — a token, a message, or anything else that isn't the resource itself goes into `meta`:

```ts
{ data: T | null, meta: { code: 1 | 0, message?: string, ...extras } }
```

`meta.code` is a fixed success/fail flag (`CONSTANTS.META_CODE`, `src/common/constants/app.constants.ts` — `SUCCESS: 1`,
`FAIL: 0`), **not** the HTTP status. The real HTTP status is still set normally (`@HttpCode`, or the status carried by a
thrown error) and is also echoed into `meta.statusCode` for errors.

Services return a plain, strictly-typed result object built directly in each method (e.g. `AuthService.register`/`login`
return `AuthResult = { user: UserResponseDto, accessToken: string }`, see `src/modules/auth/auth.types.ts`) — there is no
shared "build the response" helper; the controller destructures that result and decides what's `data` vs. `meta`.

Success (`201 POST /auth/register`) — `user` is `data`, `accessToken` is an extra on `meta`:

```json
{
  "data": { "id": "...", "email": "alice@example.com", "organizationId": "..." },
  "meta": { "code": 1, "message": "Registered successfully", "accessToken": "..." }
}
```

Error (`409 POST /auth/register`, duplicate email) — built by the global `AllExceptionsFilter`
(`src/common/filters/all-exceptions.filter.ts`), the single place every thrown error is turned into a response.
Services throw `ApiError` (`src/shared/response/apiError.service.ts`, e.g. `ApiError.conflict(...)`,
`ApiError.unauthorized(...)`) for expected domain errors; Nest's own `HttpException`s (validation pipe, unknown route,
throttler) are normalized the same way. Anything else is logged server-side with its stack trace and returned as an
opaque `500`:

```json
{
  "data": null,
  "meta": {
    "code": 0,
    "message": "Email already registered",
    "statusCode": 409,
    "error": "Conflict",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "path": "/api/v1/auth/register"
  }
}
```

For validation failures `meta.message` is an array of field-level strings.

## How org membership works

**Tenancy rule this module exists to enforce:** a user can only ever see or modify members of their *own*
organization. Every endpoint below reads `orgId` from the caller's verified JWT (`@CurrentUser('orgId')`) — never
from a body or URL param — so there is no way to pass a different organization's id and act on it. All routes
require authentication (no `@Public()`; the global `JwtAuthGuard` applies as normal).

| Endpoint            | Body                | Success `data`                               | Errors                                                                    |
| ------------------- | -------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /users`         | –                    | `200` array of `{ id, email, organizationId }` (caller's org, oldest first) | –                                                            |
| `POST /users`        | `{ email, password }` | `201 { id, email, organizationId }` (new member, added to caller's org) | `400` validation, `409` email already registered, `401`      |
| `DELETE /users/:id`  | –                    | `200 null`                                    | `400` malformed id / removing yourself / last remaining member, `401`, `404` member not found (also returned for an id that belongs to a *different* org — see below) |

- **Adding a member** creates a full login-capable account (email + password, hashed with argon2id, same policy as
  registration) directly inside the caller's organization — there is no invite/accept-by-email flow; that's out of
  scope for this assessment. Email is unique system-wide (same `User.email` constraint used by registration).
- **Removing a member** is cross-tenant-safe by construction: the target is looked up with
  `WHERE id = :id AND organizationId = :callerOrgId`. If that lookup misses — because the id doesn't exist *or*
  because it belongs to a different organization — the response is the same `404 "Member not found"`, so this
  endpoint never confirms whether a given user id exists elsewhere.
- **Guardrails:** a member cannot remove themself through this endpoint (`400`), and the last remaining member of an
  organization cannot be removed (`400`) — there is no "delete organization" flow yet, so that would otherwise orphan it.
- **No roles yet.** The schema has no admin/owner distinction — any authenticated member of an organization can add
  or remove any other member of that same organization. Role-based restrictions on membership management are
  out of scope for this assessment.

## How workflows work

**Tenancy rule this module exists to enforce:** *"a user must only be able to access workflows belonging to their
organization."* Every endpoint reads `organizationId` from the caller's verified JWT (`@CurrentUser('orgId')`) —
never from the request body/params/query — and every query is scoped to it at the database level, in the same
query, not "fetch, then filter in application code." All routes require authentication (no `@Public()`).

| Endpoint              | Body/Query                     | Success `data`                                                    | Errors                                    |
| --------------------- | ------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| `POST /workflows`     | `CreateWorkflowDto` (below)      | `201` full workflow, **including `webhookKey`**                      | `400` validation, `401`, `409` identical workflow already exists in this org (see below) |
| `GET /workflows`      | `?page=1&limit=20`               | `200` array of **summaries** — `{ id, name, stepCount, createdAt }`   | `400` invalid pagination, `401`               |
| `GET /workflows/:id`  | –                                | `200` full workflow, including the complete `steps` array            | `400` malformed id, `401`, `404` not found (see below) |

`GET /workflows` also returns pagination metadata on `meta`: `{ page, limit, total, totalPages }`.

### Workflow schema (`CreateWorkflowDto`)

```
{
  name: string,          // required, non-empty, max 200 chars
  steps: StepDto[]        // required, 1–50 steps
}
```

Each step is `{ id: string, type: 'http' | 'condition' | 'delay' | 'complete', config: <shape below> }`. `id` is the
user-facing step identifier (referenced by condition steps and, later, execution tracking) — **not** the DB primary
key.

| `type`        | `config` shape                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `http`        | `method` (`GET`\|`POST`\|`PUT`\|`PATCH`\|`DELETE`, required), `url` (absolute URL, required), `headers?` (object of string→string), `body?` (any JSON), `timeoutMs?` (100–60000, default 10000) |
| `condition`   | `field` (non-empty string — a dotted path into the previous step's output, e.g. `"data.status"`), `operator` (`eq`\|`neq`\|`gt`\|`gte`\|`lt`\|`lte`\|`contains`), `value` (any, required — the comparison target; `null` is a valid value, only `undefined`/missing is rejected) |
| `delay`       | `durationMs` (1000–86400000, required)                                                                  |
| `complete`    | none — the terminal marker step; a `config` object, if present, is ignored                              |

**Structural rules, enforced at `POST /workflows` (400 on violation), each a reusable `@ValidatorConstraint`
(`src/modules/workflows/validators/`):**
- **Unique step ids** (`UniqueStepIds`) — no two steps may share an `id`.
- **Exactly one `complete` step, and it must be last** (`ExactlyOneCompleteStep`) — decided this way (not merely
  "present somewhere") because it's the simplest shape for an execution engine to reason about: it can stop as soon
  as it runs the final step, with no separate "is this workflow done" check anywhere else.
- **A `condition` step cannot be at index 0** (`ValidConditionReferences`) — it evaluates the *previous* step's
  output, so it needs a predecessor. This only checks the array is well-formed enough to evaluate at runtime; it
  can't (and doesn't try to) verify that `field`/`operator` will resolve to something meaningful against whatever
  the previous step actually returns — that's inherently a runtime concern for the execution engine.
- Every step's `config` is validated against its declared `type`'s exact shape — a `delay` step with an `http`-shaped
  config (or vice versa) is rejected at `400`, never silently coerced or accepted with extra/missing fields.

### Duplicate workflow detection

`POST /workflows` rejects (`409`) re-creating a workflow that is **identical** — same `name` **and** same `steps`
(deep-equal, step order matters) — to one that already exists in the *same organization*. Same name with different
steps, or the same steps under a different name, are both allowed; the identical payload is also allowed again in a
*different* organization.

- **How:** `WorkflowsService.create` computes a sha256 hash of the canonicalized `{ name, steps }`
  (`src/modules/workflows/workflow-content-hash.ts` — object keys are deep-sorted so hashing doesn't depend on
  incidental key order, but array/step order is preserved since it's meaningful) and stores it in a new
  `Workflow.contentHash` column, unique per `(organizationId, contentHash)`.
- **Why a DB constraint and not a "check, then insert":** a unique constraint is race-safe — two identical requests
  fired concurrently can't both slip through a "does this already exist?" read followed by a separate write. This
  mirrors how `Organization.name` and `User.email` uniqueness are already enforced in this codebase (see "How auth
  works" above): compute upfront, attempt the insert, catch `P2002` on that specific constraint (checked via
  `error.meta.target`, since `Workflow` also has a `webhookKey` unique constraint that must *not* be reported as a
  duplicate-content conflict) and translate it to a clean `409`.
- **What this doesn't catch:** this is exact-content deduplication, not "materially equivalent" detection — e.g.
  reordering two independent `http`/`delay` steps that don't depend on each other still counts as a different
  workflow, since step order is part of the hash. Broader equivalence checking is out of scope.

### Security decisions

- **`condition` steps cannot execute arbitrary expressions.** There is no `eval()`/`new Function()` anywhere in this
  codebase. `ConditionStepConfigDto`'s fixed `field`/`operator`/`value` shape is the deliberate, safe alternative to
  a user-supplied expression language — the engine only ever needs to read one path, look up one operator in a fixed
  table, and compare against one value.
- **Tenant isolation is 404, not 403.** `GET /workflows/:id` returns the identical `404 "Workflow not found"` whether
  the id doesn't exist at all, or exists but belongs to a different organization. A `403` in the cross-org case would
  confirm the workflow *exists* to a user who has no business knowing that — the assessment's `test/workflows.e2e-spec.ts`
  asserts the two response bodies are indistinguishable (aside from `path`/`timestamp`).
- **`webhookKey` is a separate identifier from `id`.** It's a random UUID, distinct from and unrelated to the
  workflow's primary key, generated for the public webhook URL a later module will expose. The internal `id` is
  never meant to appear in a public-facing path; `webhookKey` is. It's returned in full on `POST`/`GET :id` (the
  owner needs it to configure their caller) but treated as sensitive-ish: this app has no request/response
  access-logging middleware, so it currently can't leak into logs, and no service code logs it directly (only
  workflow/org ids are logged, e.g. on creation).

### Technical decisions

- **`steps` is JSONB, not a normalized table.** Steps are always read/written as a whole unit with their parent
  workflow, never queried individually, and the shape is heterogeneous per step type (an `http` step and a `delay`
  step share almost nothing) — a normalized `StepDefinition` table would need a wide nullable-everything schema or
  per-type tables, for no query benefit here. JSONB avoids that premature normalization. Validation strictness lives
  entirely at the API layer (the discriminated-union DTOs above): what's persisted is always already-valid, so the
  execution engine (a later module) never has to defensively re-check step config shapes.
- **Workflows are immutable after creation.** There is no `PATCH`/`PUT /workflows/:id` — ties to "no workflow
  versioning" in this assessment's own scope limitations. Changing a workflow means creating a new one.
- **List vs. detail are different shapes.** `GET /workflows` returns `{ id, name, stepCount, createdAt }` per row,
  never the `steps` blob; `GET /workflows/:id` returns the full definition. A workflow can have up to 50 steps with
  arbitrary nested config, and the list view has no use for that payload. The list query is also written as a raw
  SQL query (parametrized via `Prisma.sql`, not string interpolation) rather than a normal Prisma `findMany`,
  specifically so `steps` is never transferred from Postgres in the first place for a list call — `stepCount` comes
  from `jsonb_array_length(steps)` and the pagination `total` from a `COUNT(*) OVER()` window function, both computed
  in the same query.
- **`delay`'s 24h max and `http`'s 60s timeout max are configurable limits, not architectural ceilings** — bounds
  against a typo'd duration or an unbounded timeout tying up a worker, not a hard design constraint. They can be
  raised later without a schema change.

## How workflow execution works

**ExecutionsModule** (`src/modules/executions/`) is the API-facing half: it validates a request, resolves tenancy,
writes the one row that kicks everything off, and enqueues a job. **WorkflowEngineModule** (`src/modules/
workflow-engine/`) is the worker-facing half: the BullMQ processor, the step handlers, and the state machine that
actually walks a workflow to completion. They're deliberately separate NestJS modules in separate processes — see
"BullMQ setup" below.

| Endpoint                       | Body / Header                    | Success `data`                                        | Errors                                       |
| ------------------------------- | ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `POST /workflows/:id/execute`   | `Idempotency-Key` header, optional | `202` (new) or `200` (idempotent replay) `{ executionId, status }` | `400` malformed id/key, `401`, `404` workflow not found |
| `GET /executions/:id`           | –                                   | `200` `{ executionId, workflowId, status, currentStep, startedAt, completedAt, error, stepExecutions[] }` | `400` malformed id, `401`, `404` not found (see below) |

Same tenant-isolation rule as workflows: `organizationId` only ever comes from the caller's JWT.
`WorkflowExecution.organizationId` is denormalized from the workflow at creation time specifically so
`GET /executions/:id` can check tenancy directly on this row (`WHERE id = :id AND organizationId = :callerOrgId`),
with no join through `Workflow` — and so the org is locked in at the moment of execution even if workflow
reassignment across orgs were ever introduced later (it isn't, and workflows are immutable, but this column's
correctness doesn't depend on that staying true). Same 404-not-403 reasoning as `GET /workflows/:id` applies here too.

**Rate limiting:** `POST /workflows/:id/execute` is limited by *organization* (`OrgThrottlerGuard`,
`src/modules/executions/org-throttler.guard.ts`, tracked via a separate `perOrgExecute` named throttler — see
`AppModule`), 20/min by default, in addition to the global per-IP default — an org shouldn't be able to flood the
queue regardless of how many IPs it spreads requests across, and one IP shouldn't be able to exhaust another org's
budget.

### BullMQ setup

One queue, `workflow-execution` (`WORKFLOW_EXECUTION_QUEUE`). Every job's payload is **minimal and carries no
business state**: `{ executionId }`. The processor (`WorkflowExecutionProcessor`) is a thin wrapper — it does
nothing but call `WorkflowExecutionTickService.processTick(executionId)`, which **re-reads current state from
Postgres on every single invocation**. The job payload is never trusted for anything beyond "which execution to
look at" — that's what makes a stale, retried, or duplicated job always safe to process again.

Every enqueue uses the same options (`WorkflowExecutionQueueService`): `attempts: 3`,
`backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: { age: 3600, count: 1000 }`,
`removeOnFail: { age: 86400 }`. **This is a genuinely different layer from step-level business retry** (see "How
retries work" below): this outer layer protects against *infra*-level failure — the processor threw an unexpected
exception (a bug, a transient DB connection error), or the worker process crashed hard mid-job. The inner,
business-level retry is what implements "an http step's call failed, retry per the step's own
`maxAttempts`/`retryDelayMs`" — a step that exhausts its *business* retries resolves cleanly (`FAILED`) and never
touches this outer layer at all.

Worker config (`WorkflowExecutionProcessor`, `@Processor(...)` options): `concurrency` (env `WORKER_CONCURRENCY`,
default 5), `lockDuration: 30000`, `maxStalledCount: 2`. `lockDuration` only needs to cover this processor's own
overhead (a few DB round trips) — **not** the external HTTP call itself: BullMQ auto-extends a job's lock while it's
still actively being processed, so an http step's own `timeoutMs` (up to 60s) safely outliving the 30s lock window is
expected, not a bug.

`api` and `worker` are separate processes from the same image (see `docker-compose.yml`): `WorkflowEngineModule`
(queue registration + the producer service) is imported by the API; `WorkflowEngineWorkerModule` (the processor, the
tick service, the reconciliation cron) is imported **only** by `src/worker.ts`'s own root module, never by the API's
`AppModule`. The API enqueues; it never runs a step itself.

### jobId strategy

Every enqueue call (`WorkflowExecutionQueueService`) uses a specific jobId, and the exact scheme matters — this was
tightened during implementation after two real bugs surfaced, both empirically confirmed against BullMQ (not
guessed):

| Purpose                                  | jobId                                    |
| ------------------------------------------ | ------------------------------------------- |
| Initial dispatch (`enqueueInitial`)        | `executionId`                                |
| Immediate next-step advancement (`enqueueNextStep`) | `` `${executionId}-${nextStepId}` `` |
| Delay-step resume (`enqueueDelayWake`)     | `` `${executionId}-${stepId}-wait` ``        |
| Retry backoff (`enqueueRetryWake`)         | `` `${executionId}-${stepId}-retry-${nextAttempt}` `` |

Two confirmed BullMQ behaviors this scheme relies on:
- Re-adding a jobId that's still `waiting`/`delayed` is a **safe no-op** — no duplicate, no error. This is what makes
  the initial-dispatch and reconciliation re-sweeps safe to repeat.
- Re-adding a jobId whose previous job already **completed** is *also* a silent no-op — but it does **not** run
  again. Colons (`:`) in a custom jobId are rejected outright (`Error: Custom Id cannot contain :` — reserved for
  BullMQ's own repeatable-job id format), so any step id containing one is defensively stripped.

The bug this surfaced during implementation: a **wake job (delay-resume or retry-backoff) must never reuse the bare
`executionId`** the way the very first version of this code did, copying the "wake jobs all share one id" reasoning
from the initial-dispatch case. The wake job is enqueued *from inside* the currently-executing job's own callback,
**before that job has returned** — so at the moment of the `.add()` call, a job with that same bare id is still
*active*, not merely idle. Re-adding it hit the exact same "reuse while not-yet-completed" no-op — no new job was
ever actually created — and when the original invocation's callback then returned normally (no throw, since a
retryable failure isn't an exception), BullMQ marked that job **completed**, and the scheduled resume simply never
happened. The fix: every wake job's id is namespaced by *which step* (and, for retries, *which attempt*) it's
resuming, so it's never the same string as whatever job is currently running when it gets scheduled.

### How idempotency works

Controlled entirely by the optional `Idempotency-Key` header on `POST /workflows/:id/execute`.
**If it's omitted, every call creates a new execution — no dedup.** That's a deliberate choice, not an oversight:
callers that want at-most-once semantics opt in explicitly by sending a key; callers that don't send one always get
a fresh execution, with no hidden behavior change based on request shape.

When a key **is** sent (`ExecutionsService.execute`):
1. Look up `IdempotencyRecord` for `(organizationId, key)`. If found, return **that** execution's
   `{ executionId, status }` with `200` — nothing new was created, so nothing gets enqueued again.
2. If not found, create the `WorkflowExecution` (`PENDING`) **and** the `IdempotencyRecord` together in one Prisma
   `$transaction`, then enqueue (`enqueueInitial`) — but **only after that transaction commits**, and only when it
   created something new. `202` is returned for this case.

**The exact race, and why a unique constraint (not the transaction alone) is what closes it:** two concurrent
requests with the same key can *both* pass step 1's existence check before either commits step 2 — the check and
the write aren't atomic with each other across two separate requests. What actually prevents two executions from
being created is the **`@@unique([organizationId, key])`** constraint on `IdempotencyRecord`: whichever request's
transaction commits first wins; the second's `$transaction` fails with Prisma `P2002` on that exact constraint. The
loser catches it, **re-queries** for the record the winner just created, and returns *its* `executionId` — never a
500, never a second execution. The included e2e test fires 10 truly concurrent requests with the same key
(`Promise.all`) and asserts exactly one `WorkflowExecution` row exists and every response carries the same
`executionId`.

**Known limitation:** enqueueing is a separate call *after* the DB transaction commits (queueing a job inside the
transaction would couple two different systems' commit semantics together, which is worse) — so there's a narrow
window where the commit succeeds but the `queue.add()` call itself fails (a Redis blip). The mitigation is the
reconciliation cron below: a `PENDING` execution older than 30s with (as far as it can tell) no job for it gets
re-enqueued, using the same `executionId` jobId the original dispatch would have used — safe to repeat if the
original job is actually still there.

### How concurrency is handled

Two layers, and they're not interchangeable:
- **Primary correctness mechanism:** `SELECT * FROM "WorkflowExecution" WHERE id = :id FOR UPDATE`, taken at the
  very start of every state-changing operation (`WorkflowExecutionTickService`'s `claimTick`, `persistOutcome`,
  `persistDelayResume`, `advanceOnly`, `ensureFailed` — every one of them re-locks the row). This is what actually
  guarantees only one tick advances an execution's state at a time, regardless of how many workers or duplicate jobs
  are involved. Each of these transactions is intentionally **short**: it only ever reads/writes the execution
  pointer and step-execution rows — it never sits open across an external HTTP call, a delay, or anything else that
  isn't near-instant.
- **First line of defense, not the guarantee:** BullMQ's `lockDuration`/`maxStalledCount` (see "BullMQ setup").
  This is what notices a worker has died mid-job and makes the job available again — it's what triggers a *retry*
  of a stuck tick, not what makes concurrent ticks safe. The Postgres lock is what makes that retry safe to run
  even if the "dead" worker wasn't really dead (see "What happens when a worker crashes").

Both required concurrency tests in `test/workflow-execution.e2e-spec.ts` exercise the FOR UPDATE lock directly,
deliberately bypassing anything BullMQ-level so the outcome is deterministic rather than timing-dependent:
- **Same-execution double-processing:** `Promise.all([tickService.processTick(id), tickService.processTick(id)])`
  — two truly concurrent calls, no queue involved. Only one performs the actual HTTP call (asserted via a call
  counter on the mock endpoint); the other observes the row is already locked, waits, and finds state has already
  moved past what it expected.
- **Duplicate job delivery:** two real BullMQ jobs, **different** jobIds, identical `{ executionId }` payload,
  processed by the real worker — reusing the *same* jobId is already a no-op at the queue level (see "jobId
  strategy"), so this specifically tests that our own Postgres locking (not BullMQ's dedup) is what prevents
  double-execution when the queue genuinely delivers two distinct jobs for one execution — the realistic version of
  this is a stalled-job redelivery landing on a second worker while the first is still finishing up.

Even with the lock serializing access, a *duplicate* delivery (different jobId, same execution) can still slip past
`claimTick`'s "resume a RUNNING attempt" branch and reach the same step-execution row from two different ticks in
sequence (the lock is only held for each short transaction, not the whole tick) — `persistOutcome` /
`persistDelayResume` handle that defensively: if the row they expect to update no longer matches (Prisma `P2025`),
that means a concurrent tick already resolved it first, and they log a warning and no-op rather than throwing.

### What happens when a worker crashes

BullMQ's stalled-job detection (`maxStalledCount: 2`) is the trigger: if a worker dies mid-job, the job becomes
available again after its lock expires. Recovery itself is entirely Postgres-state-driven, not anything
exception-handling related — `claimTick` reads the actual current `StepExecution` row for whatever step is current:
- `RUNNING`/`PENDING` (an attempt was started but never got a result persisted) → **resume that exact attempt** —
  never skip it, never bump the attempt counter, never duplicate the row. This is the same branch a genuinely
  concurrent duplicate delivery hits (see "How concurrency is handled") — from Postgres's point of view "a crash"
  and "another tick is still working on this" look the same, and both resolve the same safe way.
- `WAITING` with `resumeAt` already passed → resume the wait (`complete-wait`).
- `COMPLETED`/`FAILED` already → defensively advance past it / re-affirm the execution's failure without redoing
  anything.

**At-least-once caveat, stated plainly:** if a worker dies in the narrow window *after* an external call has
already succeeded but *before* the DB commit that records it, the next attempt resumes the same attempt number and
**can call the external endpoint again**. This system does not implement exactly-once external side effects (that
would need idempotency keys on the *outbound* call, which is a property of the target API, not something this
service can guarantee on its behalf) — it guarantees the *workflow's own state* never gets skipped, duplicated, or
stuck, which is a different and weaker guarantee than "the HTTP call itself never fires twice." Documented here
rather than silently assumed away.

### How retries work

Two distinct layers (see "BullMQ setup" for the infra one):
- **Infra-level** (BullMQ `attempts: 3`, exponential backoff starting at 2s): guards against the processor itself
  throwing unexpectedly or the worker dying hard. Not configurable per-step; the same for every job.
- **Business-level** (per `http` step only — see below): `maxAttempts` (1–10, default 1 = no retry) and
  `retryDelayMs` (100–60000ms, default 1000) on `HttpStepConfigDto`. Only a **retryable** failure — a network
  error, DNS failure, or timeout — counts against `maxAttempts`; a completed non-2xx response is a *success* at
  this layer (see "SSRF protections" section's neighbor, "How http step failures are classified", in the code
  comments on `http-step.handler.ts`) and a `condition` step's false result is *never* retryable (the truth value
  won't change on retry) regardless of any retry config — which is why `condition`/`delay`/`complete` step configs
  don't declare `maxAttempts`/`retryDelayMs` at all: the global `ValidationPipe`'s `forbidNonWhitelisted` rejects
  them there at `400` automatically, rather than silently accepting and ignoring a no-op setting.
- **Backoff formula:** `retryDelayMs * 2 ** (attempt - 1)` — exponential, starting at `retryDelayMs` for the first
  retry. Scheduled the same way a delay step schedules its resume: a `StepExecution` row set to `RETRYING`, and a
  BullMQ delayed job (`enqueueRetryWake`) that re-invokes the same tick logic when it fires.
- **Exhaustion:** the step and the execution both resolve to `FAILED` with the last failure's error message. An
  execution is never left `RUNNING` indefinitely because retries ran out.

### How delays survive a restart

A `delay` step's first dispatch computes `resumeAt = now() + durationMs` and returns immediately — no
`setTimeout`/sleep anywhere. `WorkflowExecutionTickService` persists `StepExecution.status = WAITING` with that
`resumeAt` and schedules a BullMQ delayed job (`enqueueDelayWake`) for when it should fire. When that job runs, the
tick logic finds the `WAITING` row with `resumeAt` in the past and resumes — no special-casing needed on the resume
path itself, it's the same `claimTick` every other job goes through.

**The backstop for "what if Redis loses the delayed job"** (e.g. a Redis restart without persistence configured, or
the enqueue-after-commit gap described under idempotency): `ReconciliationService`
(`src/modules/workflow-engine/reconciliation.service.ts`), a `@Cron('*/60 * * * * *')` job that runs **only in the
worker process** (`WorkflowEngineWorkerModule`, never imported by the API). Every 60s it:
1. Re-enqueues any `PENDING` execution older than 30s (the commit-succeeded-but-enqueue-failed case).
2. Re-enqueues any `StepExecution` still `WAITING` with `resumeAt` already in the past.

Both re-sweeps use the exact same jobId the original dispatch would have used (see "jobId strategy") — if that
original job is actually still legitimately pending, BullMQ's own dedup makes the re-sweep a safe no-op; if it's
genuinely gone, this is what brings the execution back.

### SSRF protections

`assertSafeExternalUrl` (`src/modules/workflow-engine/ssrf/assert-safe-external-url.ts`) runs before every `http`
step's request:
- **DNS-resolve, then check the resolved IP** — never a regex on the hostname string. A hostname can resolve to a
  private IP without looking like one; `dns.lookup(hostname, { all: true })` is checked against every returned
  address (both IPv4 and IPv6), not just the first.
- **Blocked ranges:** loopback (`127.0.0.0/8`, `::1`), RFC1918 private (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`), link-local (`169.254.0.0/16` — this is what blocks cloud metadata endpoints like
  `169.254.169.254`), carrier-grade NAT, documentation/benchmarking ranges, multicast, reserved, and IPv6
  unique-local (`fc00::/7`)/link-local (`fe80::/10`), including IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`,
  checked against the embedded IPv4).
- **Redirects are never followed** (`maxRedirects: 0`) — a redirect to an internal address is a classic bypass of a
  hostname-only check. Supporting redirects safely would mean re-validating each `Location` header manually before
  following it; that's out of scope here, so redirects are simply never auto-followed (a `3xx` response is returned
  as-is, as a normal step success, for a downstream `condition` step to act on if it matters).
- **Response size is bounded** (`maxContentLength`/`maxBodyLength`, 1MB) — an unbounded response from an external
  API is a resource-exhaustion risk against the worker itself. The stored `output.body` is separately truncated
  (10,000 chars) so a large-but-under-the-limit response doesn't bloat the `StepExecution` row indefinitely.
- **Documented residual gap:** this checks the resolved address at call time; nothing pins the actual outbound
  socket to that exact IP, so a DNS answer that changes between this check and the real connection (attacker-
  controlled DNS rebinding) isn't fully closed by this function alone. Combined with never following redirects,
  this covers the two vectors most directly reachable from a workflow definition; a fully rebinding-proof
  implementation would need to pin the resolved IP into the actual connection, which wasn't implemented here.

### Architecture (execution path)

```
Client
  │  POST /workflows/:id/execute  (Idempotency-Key?)
  ▼
API process (ExecutionsController → ExecutionsService)
  │  1. resolve workflow WHERE id + organizationId (tenant check)
  │  2. Postgres: create WorkflowExecution (+ IdempotencyRecord if a key was sent, one transaction)
  ▼
Postgres  ── commits ──▶  API process
  │                          │  3. AFTER commit: enqueue { executionId } — jobId per "jobId strategy"
  ▼                          ▼
IdempotencyRecord         BullMQ (Redis) — `workflow-execution` queue
  (organizationId, key)      │
  → executionId              ▼
                          Worker process (WorkflowExecutionProcessor → WorkflowExecutionTickService)
                              │  claimTick: SELECT ... FOR UPDATE, decide current step, commit (short tx)
                              ▼
                          Step handler (http / condition / delay / complete) — OUTSIDE any open transaction
                              │                                  │
                              │ http only                        │
                              ▼                                  │
                          assertSafeExternalUrl → axios ──▶ External API
                              │                                  │
                              ◀──────────────────────────────────┘
                              ▼
                          persistOutcome / persistDelayResume: SELECT ... FOR UPDATE, write StepExecution +
                          WorkflowExecution, commit (short tx)
                              │
                              ▼  (if not terminal) enqueue the next tick — jobId per step/attempt
                          BullMQ ──▶ Worker (loop continues until COMPLETED/FAILED)

              ReconciliationService (worker only, every 60s):
                Postgres → stuck PENDING / overdue WAITING rows → re-enqueue (safe no-op if still pending)
```

## Architecture

Current layout is feature-module based:

```
src/
  common/          filters, guards, decorators, constants (interceptors/, pipes/ reserved)
  config/          typed configuration + env validation
  prisma/          global PrismaModule / PrismaService
  shared/          response/  ApiError + ResponseService (global) — see "Response envelope" above
  modules/
    auth/          registration, login, JWT
    users/         org membership (add/remove/list members)
    workflows/     workflow definition + retrieval — dto/step-configs/, validators/
    executions/    API-facing scheduling: POST /workflows/:id/execute, GET /executions/:id, idempotency
    workflow-engine/ worker-facing execution engine: BullMQ processor, step-handlers/, ssrf/, condition/,
                   reconciliation cron — see "How workflow execution works" above
    organizations/ placeholder
  worker.module.ts, worker.ts   the separate worker process entrypoint
prisma/            schema.prisma + migrations
test/              e2e tests
```

## API examples

Auth, then create and fetch a workflow:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse","organizationName":"Acme"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).meta.accessToken')

curl -X POST localhost:3000/api/v1/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "Ping example.com",
    "steps": [
      { "id": "ping", "type": "http", "config": { "method": "GET", "url": "https://example.com" } },
      { "id": "done", "type": "complete" }
    ]
  }'

curl localhost:3000/api/v1/workflows -H "Authorization: Bearer $TOKEN"
```

Execute it (a worker process must be running — see the migration note at the top) and poll for the result:

```bash
WORKFLOW_ID=... # from the create response above

EXEC=$(curl -s -X POST "localhost:3000/api/v1/workflows/$WORKFLOW_ID/execute" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: my-first-run")   # optional — omit it and every call creates a new execution
EXECUTION_ID=$(echo "$EXEC" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.executionId')

# Poll until status is COMPLETED or FAILED
curl localhost:3000/api/v1/executions/$EXECUTION_ID -H "Authorization: Bearer $TOKEN"
```
