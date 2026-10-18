import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const CONTROLLER_REPOSITORY_REMOTE = "https://github.com/chriskulbaba2025/gacm-controller.git";

export interface ControllerSourceIdentity {
  repositoryRoot: string;
  repositoryIdentity: string;
  branch: string;
  sha: string;
  clean: true;
}

export type ContractProject = "prysm" | "gacm" | "sandbox";
export type ContractRunState = "RUNNING" | "COMPLETE" | "BLOCKED" | "FAILED" | "CANCELLED";
export type TerminalEvidence = "NONE" | "PROOF_PRESENT";
export type ProductAcceptance = "HOLD";

export type RunStatusDiagnostic =
  | "HISTORICAL_SOURCE_MISMATCH"
  | "UNAVAILABLE"
  | "CORRUPTED"
  | "UNVERIFIED";

export class RunStatusReadError extends Error {
  readonly diagnostic: RunStatusDiagnostic;
  readonly runId: string;
  readonly reason: string;

  constructor(diagnostic: RunStatusDiagnostic, runId: string, reason: string) {
    super(reason);
    this.name = "RunStatusReadError";
    this.diagnostic = diagnostic;
    this.runId = runId;
    this.reason = reason;
  }
}

export interface StatusContractContext {
  controllerSource: ControllerSourceIdentity;
  runId: string;
  project: ContractProject;
  proofDir: string;
  activeProcess: boolean;
  authority: StatusAuthorityContext;
}

export interface TrustedRepositoryAuthority {
  role: string;
  repositoryRoot: string;
  expectedRemote: string;
  observedRemote: string;
  authoritativeRef: string;
  authoritativeSha: string;
  observedBranch: string;
  observedSha: string;
}

export interface StatusAuthorityContext {
  project?: TrustedRepositoryAuthority;
  gacm?: {
    governance: TrustedRepositoryAuthority;
    application: TrustedRepositoryAuthority;
  };
}

const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "must be a 40-character Git SHA");
const TimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO timestamp");
const SourceIdentitySchema = z.object({
  repositoryRoot: z.string().min(1),
  repositoryIdentity: z.string().min(1),
  branch: z.string().min(1),
  sha: ShaSchema,
  clean: z.literal(true)
}).strict();

const WorkspaceAuthoritySchema = z.object({
  runId: z.string().min(1),
  trancheId: z.string().min(1),
  repositoryRole: z.string().min(1),
  repositoryRoot: z.string().min(1),
  repositoryIdentity: z.string().min(1),
  expectedRemote: z.string().min(1),
  authoritativeRef: z.string().min(1),
  authoritativeSha: ShaSchema,
  executionRoot: z.string().min(1),
  existingWorkspaceOnly: z.boolean().optional(),
  isolatedClone: z.boolean().optional()
}).strict();

const WorkspaceBindingSchema = z.object({
  version: z.literal(2),
  runId: z.string().min(1),
  trancheId: z.string().min(1),
  repositoryRole: z.string().min(1),
  repositoryRoot: z.string().min(1),
  repositoryIdentity: z.string().min(1),
  expectedRemote: z.string().min(1),
  authoritativeRef: z.string().min(1),
  authoritativeSha: ShaSchema,
  workspacePath: z.string().min(1),
  executionBranch: z.string().min(1),
  createdAt: TimestampSchema
}).strict();

const RepoStatusSchema = z.object({
  project: z.enum(["prysm", "gacm", "sandbox"]),
  root: z.string().min(1),
  topLevel: z.string().min(1),
  remote: z.string().min(1),
  expectedRemote: z.string().min(1),
  remoteParity: z.literal(true),
  branch: z.string(),
  sha: ShaSchema,
  dirty: z.boolean(),
  porcelain: z.string()
}).passthrough();

const AuthorityStatusSchema = z.object({
  role: z.enum(["GACM_GOVERNANCE", "GACM_APPLICATION"]),
  root: z.string().min(1),
  expectedRemote: z.string().min(1),
  authoritativeRef: z.string().min(1),
  authoritativeSha: ShaSchema,
  authoritativeParentSha: ShaSchema.optional(),
  acceptedBoundary: z.literal("FOUNDATION_13_ACCEPTED"),
  available: z.boolean(),
  status: RepoStatusSchema.optional(),
  error: z.string().optional()
}).strict();

const AuthoritySetSchema = z.object({
  governance: AuthorityStatusSchema,
  application: AuthorityStatusSchema,
  foundation13: z.literal("ACCEPTED")
}).strict();

const RunStatusSchema = z.object({
  version: z.literal(1),
  controllerSource: SourceIdentitySchema,
  runId: z.string().regex(/^(prysm|gacm|sandbox)-[A-Za-z0-9._-]+$/),
  project: z.enum(["prysm", "gacm", "sandbox"]),
  tranche: z.string().min(1).max(120),
  objective: z.string().min(1).max(12_000),
  model: z.string().min(1),
  state: z.enum(["RUNNING", "COMPLETE", "BLOCKED", "FAILED", "CANCELLED"]),
  pid: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  proofDir: z.string().min(1),
  preRunSha: ShaSchema,
  preRunDirty: z.boolean(),
  repositoryRole: z.enum(["GACM_GOVERNANCE", "GACM_APPLICATION"]).optional(),
  authority: AuthoritySetSchema.optional(),
  workspaceAuthority: WorkspaceAuthoritySchema,
  workspaceBinding: WorkspaceBindingSchema,
  terminalEvidence: z.enum(["NONE", "PROOF_PRESENT"]),
  productAcceptance: z.literal("HOLD"),
  notification: z.enum(["PENDING", "SENT", "NOT_CONFIGURED", "FAILED", "SUPPRESSED"])
}).strict();

export type PersistedRunStatus = z.infer<typeof RunStatusSchema>;

const SQLITE_FILENAME = "status.sqlite";

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("/", "\\").replace(/[\\]+$/g, "").toLowerCase();
}

function normalizeRemote(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function identityOf(status: PersistedRunStatus): unknown {
  return {
    version: status.version,
    controllerSource: status.controllerSource,
    runId: status.runId,
    project: status.project,
    tranche: status.tranche,
    objective: status.objective,
    model: status.model,
    startedAt: status.startedAt,
    proofDir: status.proofDir,
    preRunSha: status.preRunSha,
    preRunDirty: status.preRunDirty,
    repositoryRole: status.repositoryRole,
    authority: status.authority,
    workspaceAuthority: status.workspaceAuthority,
    workspaceBinding: status.workspaceBinding
  };
}

function validateStateSemantics(status: PersistedRunStatus): void {
  if (status.controllerSource.repositoryIdentity !== CONTROLLER_REPOSITORY_REMOTE) {
    throw new Error("Persisted controller source identity does not match the authorized controller repository.");
  }
  if (status.project === "gacm" && (!status.repositoryRole || !status.authority)) {
    throw new Error("GACM status is missing its repository role or authority identity.");
  }
  if (status.project !== "gacm" && (status.repositoryRole || status.authority)) {
    throw new Error("Non-GACM status contains a GACM authority identity.");
  }
  const expectedProjectRole = `${status.project.toUpperCase()}_PROJECT`;
  if (status.project !== "gacm" && status.workspaceAuthority.repositoryRole !== expectedProjectRole) {
    throw new Error("Project status workspace role does not match its project identity.");
  }
  if (status.project === "gacm") {
    const role = status.repositoryRole!;
    const selected = role === "GACM_GOVERNANCE" ? status.authority!.governance : status.authority!.application;
    if (selected.role !== role || !selected.available || !selected.status) {
      throw new Error("GACM status authority is unavailable or does not match its selected role.");
    }
    if (selected.authoritativeSha !== status.workspaceAuthority.authoritativeSha ||
        normalizeRemote(selected.expectedRemote) !== normalizeRemote(status.workspaceAuthority.expectedRemote) ||
        normalizePath(selected.root) !== normalizePath(status.workspaceAuthority.repositoryRoot)) {
      throw new Error("GACM authority and workspace identities do not match.");
    }
  }
  if (status.workspaceAuthority.runId !== status.runId || status.workspaceBinding.runId !== status.runId) {
    throw new Error("Workspace identity does not match the persisted run identity.");
  }
  if (status.workspaceAuthority.trancheId !== status.tranche || status.workspaceBinding.trancheId !== status.tranche) {
    throw new Error("Workspace identity does not match the persisted tranche identity.");
  }
  if (status.workspaceAuthority.authoritativeSha !== status.workspaceBinding.authoritativeSha) {
    throw new Error("Workspace authority and binding contain different authoritative SHAs.");
  }
  if (status.workspaceAuthority.repositoryRole !== status.workspaceBinding.repositoryRole ||
      normalizePath(status.workspaceAuthority.repositoryRoot) !== normalizePath(status.workspaceBinding.repositoryRoot) ||
      normalizeRemote(status.workspaceAuthority.repositoryIdentity) !== normalizeRemote(status.workspaceBinding.repositoryIdentity) ||
      normalizeRemote(status.workspaceAuthority.expectedRemote) !== normalizeRemote(status.workspaceBinding.expectedRemote) ||
      status.workspaceAuthority.authoritativeRef !== status.workspaceBinding.authoritativeRef) {
    throw new Error("Workspace authority and binding contain different repository identities.");
  }
  if (status.startedAt && status.finishedAt && Date.parse(status.finishedAt) < Date.parse(status.startedAt)) {
    throw new Error("Persisted status finished before it started.");
  }
  if (status.state === "RUNNING") {
    if (status.exitCode !== null || status.finishedAt !== null || status.terminalEvidence !== "NONE") {
      throw new Error("RUNNING status contains terminal evidence.");
    }
  } else {
    if (status.finishedAt === null) throw new Error("Terminal status is missing finishedAt.");
    if (status.state === "COMPLETE" && (status.exitCode !== 0 || status.terminalEvidence !== "PROOF_PRESENT" || status.productAcceptance !== "HOLD")) {
      throw new Error("COMPLETE status lacks execution evidence or is missing the independent product-acceptance HOLD.");
    }
  }
}

function validateTrustedAuthority(status: PersistedRunStatus, authority: StatusAuthorityContext): void {
  if (status.project !== "gacm") {
    const trusted = authority.project;
    if (!trusted) throw new Error("Status is missing independently observed project authority.");
    const workspace = status.workspaceAuthority;
    if (workspace.repositoryRole !== trusted.role ||
        normalizePath(workspace.repositoryRoot) !== normalizePath(trusted.repositoryRoot) ||
        normalizeRemote(workspace.repositoryIdentity) !== normalizeRemote(trusted.expectedRemote) ||
        normalizeRemote(workspace.expectedRemote) !== normalizeRemote(trusted.expectedRemote) ||
        normalizeRemote(trusted.observedRemote) !== normalizeRemote(trusted.expectedRemote) ||
        (!workspace.isolatedClone && (workspace.authoritativeRef !== trusted.authoritativeRef ||
          workspace.authoritativeSha !== trusted.authoritativeSha ||
          trusted.observedBranch !== trusted.authoritativeRef ||
          trusted.observedSha !== trusted.authoritativeSha))) {
      throw new Error("Project status authority does not match independently observed Git authority.");
    }
    return;
  }

  if (!status.repositoryRole || !status.authority || !authority.gacm) {
    throw new Error("GACM status is missing independently observed repository authority.");
  }
  const role = status.repositoryRole === "GACM_GOVERNANCE" ? "governance" : "application";
  const trusted = authority.gacm[role];
  const persisted = status.authority[role];
  const workspace = status.workspaceAuthority;
  if (workspace.repositoryRole !== trusted.role ||
      normalizePath(workspace.repositoryRoot) !== normalizePath(trusted.repositoryRoot) ||
      normalizeRemote(workspace.repositoryIdentity) !== normalizeRemote(trusted.expectedRemote) ||
      normalizeRemote(workspace.expectedRemote) !== normalizeRemote(trusted.expectedRemote) ||
      workspace.authoritativeRef !== trusted.authoritativeRef ||
      workspace.authoritativeSha !== trusted.authoritativeSha ||
      persisted.role !== trusted.role ||
      normalizePath(persisted.root) !== normalizePath(trusted.repositoryRoot) ||
      normalizeRemote(persisted.expectedRemote) !== normalizeRemote(trusted.expectedRemote) ||
      persisted.authoritativeRef !== trusted.authoritativeRef ||
      persisted.authoritativeSha !== trusted.authoritativeSha ||
      !persisted.status ||
      normalizePath(persisted.status.root) !== normalizePath(trusted.repositoryRoot) ||
      normalizePath(persisted.status.topLevel) !== normalizePath(trusted.repositoryRoot) ||
      normalizeRemote(persisted.status.remote) !== normalizeRemote(trusted.expectedRemote) ||
      normalizeRemote(persisted.status.expectedRemote) !== normalizeRemote(trusted.expectedRemote) ||
      !persisted.status.remoteParity ||
      persisted.status.branch !== trusted.observedBranch ||
      persisted.status.sha !== trusted.observedSha ||
      normalizeRemote(trusted.observedRemote) !== normalizeRemote(trusted.expectedRemote)) {
    throw new Error("GACM status authority does not match configured and independently observed Git authority.");
  }
}

export function validateRunStatus(raw: unknown, context: StatusContractContext): PersistedRunStatus {
  const status = RunStatusSchema.parse(raw);
  if (status.runId !== context.runId || status.project !== context.project) {
    throw new Error("Persisted status run/project identity does not match the requested record.");
  }
  if (normalizePath(status.proofDir) !== normalizePath(context.proofDir)) {
    throw new Error("Persisted status proof directory does not match the requested project/run path.");
  }
  if (stableJson(status.controllerSource) !== stableJson(context.controllerSource)) {
    throw new Error("Persisted status controller source identity is stale or mismatched.");
  }
  validateStateSemantics(status);
  validateTrustedAuthority(status, context.authority);
  if (status.state === "RUNNING" && !context.activeProcess) {
    throw new Error("Persisted RUNNING status is uncertain because no active process is present.");
  }
  return status;
}

function validateTransition(previous: PersistedRunStatus, next: PersistedRunStatus): void {
  if (stableJson(identityOf(previous)) !== stableJson(identityOf(next))) {
    throw new Error("Refusing to overwrite persisted status with a different run identity.");
  }
  if (previous.state !== "RUNNING") {
    if (stableJson(previous) !== stableJson(next)) {
      throw new Error("Refusing to overwrite valid terminal status evidence.");
    }
    return;
  }
  if (next.state === "RUNNING") return;
  if (!["COMPLETE", "BLOCKED", "FAILED", "CANCELLED"].includes(next.state)) {
    throw new Error("Invalid persisted status transition.");
  }
}

export async function readPersistedRunStatus(
  statusPath: string,
  context: StatusContractContext
): Promise<PersistedRunStatus> {
  const sqlitePath = path.join(path.dirname(statusPath), SQLITE_FILENAME);
  if (await pathIsPresent(sqlitePath)) return readSqliteStatus(sqlitePath, context);
  if (await pathIsPresent(statusPath)) return readLegacyJsonStatus(statusPath, context);
  throw new RunStatusReadError("UNAVAILABLE", context.runId, "Persisted run status is unavailable.");
}

async function pathIsPresent(target: string): Promise<boolean> {
  try { await statPath(target); return true; } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw new Error(`Persisted status path is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function statPath(target: string): Promise<void> {
  await stat(target);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function readSqliteStatus(sqlitePath: string, context: StatusContractContext): Promise<PersistedRunStatus> {
  let db: DatabaseSync | null = null;
  try {
    const sidecars = await sqliteSidecarState(sqlitePath);
    const immutable = sidecars === "ABSENT";
    if (immutable) await verifyWalFileHeader(sqlitePath);
    db = openReaderDatabase(sqlitePath, immutable);
    if (sidecars === "ABSENT" && await sqliteSidecarState(sqlitePath) !== "ABSENT") {
      throw new Error("SQLite WAL/SHM artifacts appeared during immutable status read.");
    }
    const row = db.prepare("SELECT payload FROM run_status WHERE run_id = ?").get(context.runId) as { payload?: string } | undefined;
    if (!row?.payload) throw new Error("SQLite status record is missing or corrupted.");
    let parsed: unknown;
    try { parsed = JSON.parse(row.payload); } catch { throw new Error("SQLite status payload is corrupted JSON."); }
    return validateRunStatus(parsed, context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const diagnostic = /controller source identity is stale or mismatched/i.test(reason)
      ? "HISTORICAL_SOURCE_MISMATCH"
      : /missing or corrupted|corrupted JSON|invalid or unreadable|not in WAL|not a database|schema|configuration/i.test(reason)
        ? "CORRUPTED"
        : "UNVERIFIED";
    throw new RunStatusReadError(diagnostic, context.runId, `Persisted SQLite status is invalid or unreadable: ${reason}`);
  } finally {
    try { db?.close(); } catch {}
  }
}

async function readLegacyJsonStatus(statusPath: string, context: StatusContractContext): Promise<PersistedRunStatus> {
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new RunStatusReadError("UNAVAILABLE", context.runId, "Persisted run status is unavailable.");
    }
    throw new RunStatusReadError("UNVERIFIED", context.runId, `Persisted run status is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Persisted run status is corrupted JSON.");
  }
  try {
    return validateRunStatus(parsed, context);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const diagnostic = /controller source identity is stale or mismatched/i.test(reason)
      ? "HISTORICAL_SOURCE_MISMATCH"
      : /JSON|corrupted/i.test(reason) ? "CORRUPTED" : "UNVERIFIED";
    throw new RunStatusReadError(diagnostic, context.runId, `Persisted run status is invalid: ${reason}`);
  }
}

export async function persistRunStatus(
  statusPath: string,
  rawStatus: unknown,
  context: StatusContractContext
): Promise<"WRITTEN" | "UNCHANGED"> {
  const next = validateRunStatus(rawStatus, context);
  await mkdir(path.dirname(statusPath), { recursive: true });

  const sqlitePath = path.join(path.dirname(statusPath), SQLITE_FILENAME);
  if (await pathIsPresent(statusPath) && !await pathIsPresent(sqlitePath)) {
    throw new Error("Legacy JSON status exists; refusing silent migration or overwrite. SQLite migration is not authorized.");
  }
  let db: DatabaseSync | null = null;
  try {
    db = openWriterDatabase(sqlitePath);
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT payload FROM run_status WHERE run_id = ?").get(next.runId) as { payload?: string } | undefined;
    let previous: PersistedRunStatus | null = null;
    if (row?.payload) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.payload); } catch { throw new Error("SQLite status payload is corrupted JSON."); }
      previous = validateRunStatus(parsed, { ...context, activeProcess: true });
      validateTransition(previous, next);
      if (stableJson(previous) === stableJson(next)) { db.exec("ROLLBACK"); return "UNCHANGED"; }
    } else if (row) {
      throw new Error("SQLite status row is missing its payload.");
    }
    db.prepare("INSERT INTO run_status(run_id, payload) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload").run(next.runId, JSON.stringify(next, null, 2) + "\n");
    db.exec("COMMIT");
    return "WRITTEN";
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch {}
    throw new Error(`SQLite status persistence failed; no JSON fallback is permitted: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { db?.close(); } catch {}
  }
}

function verifyDatabaseConfiguration(db: DatabaseSync, requireWalJournalMode = true): void {
  const journalMode = String((db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode || "").toLowerCase();
  const synchronous = Number((db.prepare("PRAGMA synchronous").get() as { synchronous?: number }).synchronous);
  const integrity = String((db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check || "").toLowerCase();
  if ((requireWalJournalMode && journalMode !== "wal") || synchronous !== 2 || integrity !== "ok") {
    throw new Error(`SQLite settings/integrity mismatch: journal_mode=${journalMode}, synchronous=${synchronous}, integrity=${integrity}`);
  }
}

function verifyDatabaseSchema(db: DatabaseSync): void {
  const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_status'").get() as { sql?: string } | undefined;
  const normalizedSql = String(schemaRow?.sql || "").toLowerCase().replace(/\s+/g, "");
  if (!normalizedSql.includes("run_status") ||
      !normalizedSql.includes("run_idtextprimarykey") ||
      !normalizedSql.includes("payloadtextnotnullcheck(length(payload)>0)")) {
    throw new Error("SQLite run_status schema is missing or incompatible.");
  }
  const columns = db.prepare("PRAGMA table_info(run_status)").all() as Array<{ name?: string; type?: string; notnull?: number; pk?: number }>;
  if (columns.length !== 2 ||
      columns[0]?.name !== "run_id" || columns[0]?.type?.toUpperCase() !== "TEXT" || columns[0]?.pk !== 1 ||
      columns[1]?.name !== "payload" || columns[1]?.type?.toUpperCase() !== "TEXT" || columns[1]?.notnull !== 1 || columns[1]?.pk !== 0) {
    throw new Error("SQLite run_status schema columns are incompatible.");
  }
}

async function sqliteSidecarState(sqlitePath: string): Promise<"ABSENT" | "PRESENT"> {
  const wal = await pathIsPresent(`${sqlitePath}-wal`);
  const shm = await pathIsPresent(`${sqlitePath}-shm`);
  if (wal !== shm) throw new Error("SQLite WAL/SHM sidecar state is incomplete.");
  return wal ? "PRESENT" : "ABSENT";
}

async function verifyWalFileHeader(sqlitePath: string): Promise<void> {
  const bytes = await readFile(sqlitePath);
  if (bytes.length < 20 || bytes[18] !== 2 || bytes[19] !== 2) {
    throw new Error("SQLite database is not in WAL file format.");
  }
}

function openReaderDatabase(sqlitePath: string, immutable: boolean): DatabaseSync {
  const readerPath = immutable ? `${pathToFileURL(sqlitePath).href}?immutable=1` : sqlitePath;
  const db = new DatabaseSync(readerPath, { readOnly: true });
  try {
    verifyDatabaseSchema(db);
    verifyDatabaseConfiguration(db, !immutable);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function openWriterDatabase(sqlitePath: string): DatabaseSync {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    db.exec("CREATE TABLE IF NOT EXISTS run_status (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(length(payload) > 0));");
    verifyDatabaseSchema(db);
    verifyDatabaseConfiguration(db);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

export function assertReadableRunStatus(status: PersistedRunStatus, activeProcess: boolean): void {
  if (status.state === "RUNNING" && !activeProcess) {
    throw new Error("Persisted RUNNING status is uncertain because no active process is present.");
  }
}
