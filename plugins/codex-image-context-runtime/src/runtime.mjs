import fs from "node:fs/promises";
import {
  JOB_SCHEMA,
  JOB_STATUSES,
  MAX_IMAGE_BYTES,
  MAX_INSPECTION_BYTES,
  MAX_PROVIDER_CONCURRENCY,
  MAX_PROMPT_BYTES,
  PUBLIC_RESULT_MAX_BYTES,
  RESULT_SCHEMA,
  TERMINAL_STATUSES
} from "./constants.mjs";
import { workspaceById } from "./config.mjs";
import { RuntimeError, closedErrorCode, fail } from "./errors.mjs";
import { buildHandoff } from "./handoff.mjs";
import { inspectImageFormat, parsePngDimensions } from "./image-format.mjs";
import { createProvider } from "./providers/index.mjs";
import {
  assertBoundedPublicJson,
  assertBoundedText,
  assertExactKeys,
  assertSafeJobId,
  assertSafePublicText,
  atomicWriteNewBytes,
  canonicalJson,
  normalizeRelativePath,
  readBoundedBytes,
  resolveExistingWorkspaceFile,
  resolveNewWorkspaceFile,
  sha256
} from "./safety.mjs";
import { JobStore } from "./store.mjs";

const SIZES = new Set(["1024x1024", "1024x1536", "1536x1024"]);
const QUALITIES = new Set(["low", "medium", "high"]);
const MODES = new Set(["inspect", "qa"]);
const DISPATCH_STATES = new Set(["not_started", "dispatch_started", "result_available", "artifact_persisted"]);

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("clock returned an invalid time");
  return date.toISOString();
}

function decodeUtf8(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("PROMPT_INVALID", `${label} is not valid UTF-8`);
  }
  assertBoundedText(text, label, { min: 1, max: MAX_PROMPT_BYTES });
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) fail("PROMPT_TOO_LARGE", `${label} exceeded its byte budget`);
  return text;
}

async function resolvePrompt(args, workspace, { defaultText = null } = {}) {
  const hasText = Object.hasOwn(args, "prompt") && args.prompt !== undefined;
  const hasRef = Object.hasOwn(args, "prompt_ref") && args.prompt_ref !== undefined;
  if (hasText && hasRef) fail("INVALID_ARGUMENTS", "provide prompt or prompt_ref, not both");
  if (!hasText && !hasRef) {
    if (defaultText === null) fail("INVALID_ARGUMENTS", "prompt or prompt_ref is required");
    return defaultText;
  }
  if (hasText) {
    assertBoundedText(args.prompt, "prompt", { min: 1, max: 16_384 });
    return args.prompt;
  }
  const input = await resolveExistingWorkspaceFile(workspace.root, args.prompt_ref, { maxBytes: MAX_PROMPT_BYTES });
  return decodeUtf8(await readBoundedBytes(input.absolutePath, input.size, MAX_PROMPT_BYTES), "prompt_ref");
}

function expectedDimensions(size) {
  const [width, height] = size.split("x").map(Number);
  return { width, height };
}

function safeModel(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function boundedInspectionText(value) {
  assertSafePublicText(value, "inspection result");
  if (Buffer.byteLength(value, "utf8") <= MAX_INSPECTION_BYTES) return value;
  const suffix = "\n[Inspection truncated to the public byte budget.]";
  const budget = MAX_INSPECTION_BYTES - Buffer.byteLength(suffix, "utf8");
  const fragments = [];
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    fragments.push(character);
    used += size;
  }
  const bounded = `${fragments.join("")}${suffix}`;
  assertSafePublicText(bounded, "inspection result");
  return bounded;
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("JOB_RECORD_INVALID", "artifact receipt is invalid");
  return {
    path: normalizeRelativePath(receipt.path, "artifact path"),
    sha256: typeof receipt.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(receipt.sha256) ? receipt.sha256 : fail("JOB_RECORD_INVALID", "artifact hash is invalid"),
    media_type: receipt.media_type === "image/png" ? receipt.media_type : fail("JOB_RECORD_INVALID", "artifact media type is invalid"),
    byte_size: Number.isSafeInteger(receipt.byte_size) && receipt.byte_size > 0 && receipt.byte_size <= MAX_IMAGE_BYTES ? receipt.byte_size : fail("JOB_RECORD_INVALID", "artifact size is invalid"),
    dimensions: receipt.dimensions && Number.isSafeInteger(receipt.dimensions.width) && Number.isSafeInteger(receipt.dimensions.height)
      ? { width: receipt.dimensions.width, height: receipt.dimensions.height }
      : fail("JOB_RECORD_INVALID", "artifact dimensions are invalid")
  };
}

export function publicJobResult(job, { deduped } = {}) {
  if (!job || job.schema !== JOB_SCHEMA || !JOB_STATUSES.includes(job.status)) fail("JOB_RECORD_INVALID", "job cannot be projected");
  const result = {
    schema: RESULT_SCHEMA,
    job_id: assertSafeJobId(job.job_id),
    status: job.status,
    task_type: job.kind,
    workspace_id: job.workspace_id,
    artifacts: (job.artifact_receipts ?? []).map(validateReceipt),
    provider_state: job.provider_execution?.state ?? "not_started",
    handoff_ref: job.handoff_ref ?? null,
    diagnostic: job.diagnostic ? { code: job.diagnostic.code, stage: job.diagnostic.stage } : null,
    resumable: job.status === "queued" || (job.status === "failed" && job.recovery?.retry_class === "safe_retry"),
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(deduped === undefined ? {} : { deduped: deduped === true })
  };
  return assertBoundedPublicJson(result, PUBLIC_RESULT_MAX_BYTES, "job result");
}

export class ImageContextRuntime {
  constructor(config, { provider, providerOptions, clock = () => new Date() } = {}) {
    this.config = config;
    this.store = new JobStore(config);
    this.provider = provider ?? createProvider(config, providerOptions);
    this.clock = clock;
    this.active = new Map();
    this.locks = new Map();
    this.initialized = false;
    this.initializePromise = null;
    this.runtimeLock = null;
    this.providerActive = 0;
    this.providerWaiters = [];
  }

  async initialize() {
    if (this.initialized) return this;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      this.runtimeLock = await this.store.acquireRuntimeLock();
      try {
        await this.store.initialize();
        await this.reconcileInterruptedJobs();
        this.initialized = true;
        return this;
      } catch (error) {
        await this.store.releaseRuntimeLock(this.runtimeLock);
        this.runtimeLock = null;
        throw error;
      }
    })();
    try {
      return await this.initializePromise;
    } finally {
      if (!this.initialized) this.initializePromise = null;
    }
  }

  async close() {
    if (this.initializePromise && !this.initialized) await this.initializePromise.catch(() => {});
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.promise).filter(Boolean));
    await this.store.releaseRuntimeLock(this.runtimeLock);
    this.runtimeLock = null;
    this.initialized = false;
    this.initializePromise = null;
  }

  async withJobLock(jobId, operation) {
    const previous = this.locks.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(jobId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(jobId) === current) this.locks.delete(jobId);
    }
  }

  async acquireProviderPermit(signal) {
    if (signal?.aborted) throw new RuntimeError("PROVIDER_ABORTED", "job was cancelled before Provider dispatch");
    if (this.providerActive < MAX_PROVIDER_CONCURRENCY) {
      this.providerActive += 1;
      return this.providerReleaseHandle();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.providerWaiters.indexOf(waiter);
        if (index >= 0) this.providerWaiters.splice(index, 1);
        reject(new RuntimeError("PROVIDER_ABORTED", "job was cancelled before Provider dispatch"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.providerWaiters.push(waiter);
    });
  }

  providerReleaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const waiter = this.providerWaiters.shift();
        if (!waiter) {
          this.providerActive -= 1;
          return;
        }
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.reject(new RuntimeError("PROVIDER_ABORTED", "job was cancelled before Provider dispatch"));
          continue;
        }
        waiter.resolve(this.providerReleaseHandle());
        return;
      }
    };
  }

  async withProviderPermit(signal, operation) {
    const release = await this.acquireProviderPermit(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async submitGeneration(args = {}) {
    await this.initialize();
    assertExactKeys(args, {
      required: ["output_path", "size", "quality", "idempotency_key"],
      optional: ["workspace_id", "prompt", "prompt_ref"]
    }, "generation arguments");
    const workspace = workspaceById(this.config, args.workspace_id);
    const prompt = await resolvePrompt(args, workspace);
    const outputPath = normalizeRelativePath(args.output_path, "output_path");
    if (!outputPath.toLowerCase().endsWith(".png")) fail("INVALID_ARGUMENTS", "output_path must end in .png");
    if (!SIZES.has(args.size) || !QUALITIES.has(args.quality)) fail("INVALID_ARGUMENTS", "image specification is unsupported");
    const intentHash = sha256(canonicalJson({
      kind: "generation",
      workspace_id: workspace.id,
      prompt_hash: sha256(prompt),
      output_path: outputPath,
      size: args.size,
      quality: args.quality,
      provider: this.config.provider.mode,
      model: this.config.provider.generation_model,
      config_hash: this.config.config_hash
    }));
    const jobId = this.store.createJobId();
    const createdAt = nowIso(this.clock);
    let job = {
      schema: JOB_SCHEMA,
      job_id: jobId,
      config_hash: this.config.config_hash,
      kind: "generation",
      workspace_id: workspace.id,
      status: "queued",
      created_at: createdAt,
      updated_at: createdAt,
      intent_hash: intentHash,
      idempotency: { key_hash: sha256(args.idempotency_key), state: "pending" },
      private_input: { prompt, output_path: outputPath, size: args.size, quality: args.quality },
      provider_execution: { name: this.provider.name, model: null, state: "not_started", dispatch_state: "not_started", started_at: null, updated_at: createdAt },
      attempts: 0,
      artifact_receipts: [],
      inspection_text: null,
      handoff_ref: null,
      diagnostic: null,
      recovery: null
    };
    await this.store.saveJob(job);
    let claim;
    try {
      claim = await this.store.claimIdempotency({ key: args.idempotency_key, intentHash, jobId, now: createdAt });
    } catch (error) {
      await this.store.deleteJobRecord(jobId).catch(() => {});
      throw error;
    }
    if (!claim.claimed) {
      await this.store.deleteJobRecord(jobId).catch(() => {});
      const existing = await this.store.loadJob(claim.job_id);
      if (!existing) fail("IDEMPOTENCY_RESERVATION_INCOMPLETE", "idempotency claim has no durable job");
      return publicJobResult(existing, { deduped: true });
    }
    job = { ...job, idempotency: { ...job.idempotency, state: "claimed" } };
    await this.store.saveJob(job);
    try {
      // Do filesystem preflight and claim the durable output only after the
      // idempotency claim. A replay therefore never revalidates an output that
      // the original job already created.
      await resolveNewWorkspaceFile(workspace.root, outputPath);
      await this.store.reserveOutput({
        workspaceId: workspace.id,
        relativePath: outputPath,
        jobId,
        intentHash,
        now: createdAt
      });
    } catch (error) {
      const failedAt = nowIso(this.clock);
      const failed = {
        ...job,
        status: "failed",
        updated_at: failedAt,
        diagnostic: { code: closedErrorCode(error), stage: "pre_dispatch" },
        recovery: { retry_class: "new_job_required", reconciled_at: failedAt },
        provider_execution: { ...job.provider_execution, state: "failed", updated_at: failedAt }
      };
      await this.store.saveJob(failed);
      await this.ensureHandoff(jobId).catch(() => {});
      return publicJobResult(await this.store.requireJob(jobId), { deduped: false });
    }
    this.schedule(jobId);
    return publicJobResult(job, { deduped: false });
  }

  async submitInspection(args = {}) {
    await this.initialize();
    assertExactKeys(args, {
      required: ["image_path", "idempotency_key"],
      optional: ["workspace_id", "prompt", "prompt_ref", "mode"]
    }, "inspection arguments");
    const workspace = workspaceById(this.config, args.workspace_id);
    const imagePath = normalizeRelativePath(args.image_path, "image_path");
    const input = await resolveExistingWorkspaceFile(workspace.root, imagePath, { maxBytes: MAX_IMAGE_BYTES });
    const bytes = await readBoundedBytes(input.absolutePath, input.size, MAX_IMAGE_BYTES);
    const format = inspectImageFormat(bytes, imagePath);
    const prompt = await resolvePrompt(args, workspace, { defaultText: "Describe visible composition, text, obvious defects, and uncertainty concisely." });
    const mode = args.mode ?? "inspect";
    if (!MODES.has(mode)) fail("INVALID_ARGUMENTS", "inspection mode is unsupported");
    const inputHash = sha256(bytes);
    const intentHash = sha256(canonicalJson({
      kind: "inspection",
      workspace_id: workspace.id,
      image_path: imagePath,
      input_hash: inputHash,
      prompt_hash: sha256(prompt),
      mode,
      provider: this.config.provider.mode,
      model: this.config.provider.vision_model,
      config_hash: this.config.config_hash
    }));
    const jobId = this.store.createJobId();
    const createdAt = nowIso(this.clock);
    let job = {
      schema: JOB_SCHEMA,
      job_id: jobId,
      config_hash: this.config.config_hash,
      kind: "inspection",
      workspace_id: workspace.id,
      status: "queued",
      created_at: createdAt,
      updated_at: createdAt,
      intent_hash: intentHash,
      idempotency: { key_hash: sha256(args.idempotency_key), state: "pending" },
      private_input: { prompt, image_path: imagePath, input_hash: inputHash, media_type: format.media_type, byte_size: bytes.length, mode },
      provider_execution: { name: this.provider.name, model: null, state: "not_started", dispatch_state: "not_started", started_at: null, updated_at: createdAt },
      attempts: 0,
      artifact_receipts: [],
      inspection_text: null,
      handoff_ref: null,
      diagnostic: null,
      recovery: null
    };
    await this.store.saveJob(job);
    let claim;
    try {
      claim = await this.store.claimIdempotency({ key: args.idempotency_key, intentHash, jobId, now: createdAt });
    } catch (error) {
      await this.store.deleteJobRecord(jobId).catch(() => {});
      throw error;
    }
    if (!claim.claimed) {
      await this.store.deleteJobRecord(jobId).catch(() => {});
      const existing = await this.store.loadJob(claim.job_id);
      if (!existing) fail("IDEMPOTENCY_RESERVATION_INCOMPLETE", "idempotency claim has no durable job");
      return publicJobResult(existing, { deduped: true });
    }
    job = { ...job, idempotency: { ...job.idempotency, state: "claimed" } };
    await this.store.saveJob(job);
    this.schedule(jobId);
    return publicJobResult(job, { deduped: false });
  }

  schedule(jobId) {
    if (this.active.has(jobId)) return;
    const controller = new AbortController();
    const active = { controller, promise: null };
    this.active.set(jobId, active);
    active.promise = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.executeJob(jobId, controller.signal))
      .catch(() => {})
      .finally(() => this.active.delete(jobId));
  }

  async providerCheckpoint(jobId, patch) {
    if (!DISPATCH_STATES.has(patch?.dispatch_state)) fail("PROVIDER_CHECKPOINT_INVALID", "provider checkpoint is invalid");
    return this.withJobLock(jobId, async () => {
      const current = await this.store.requireJob(jobId);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      const timestamp = nowIso(this.clock);
      const dispatchState = patch.dispatch_state;
      const state = dispatchState === "result_available" ? "result_available" : "in_flight";
      const updated = {
        ...current,
        updated_at: timestamp,
        provider_execution: {
          ...current.provider_execution,
          model: safeModel(patch.model) ?? current.provider_execution.model,
          state,
          dispatch_state: dispatchState,
          started_at: current.provider_execution.started_at ?? timestamp,
          updated_at: timestamp
        }
      };
      await this.store.saveJob(updated);
      return updated;
    });
  }

  async executeJob(jobId, signal) {
    const started = await this.withJobLock(jobId, async () => {
      const current = await this.store.requireJob(jobId);
      if (current.status !== "queued") return null;
      const timestamp = nowIso(this.clock);
      const updated = {
        ...current,
        status: "running",
        attempts: current.attempts + 1,
        updated_at: timestamp,
        diagnostic: null,
        recovery: null,
        provider_execution: { ...current.provider_execution, state: "not_started", dispatch_state: "not_started", started_at: null, updated_at: timestamp }
      };
      await this.store.saveJob(updated);
      return updated;
    });
    if (!started) return;
    try {
      if (started.kind === "generation") await this.withProviderPermit(signal, () => this.executeGeneration(started, signal));
      else if (started.kind === "inspection") await this.withProviderPermit(signal, () => this.executeInspection(started, signal));
      else fail("JOB_RECORD_INVALID", "job task type is unsupported");
    } catch (error) {
      await this.settleFailure(jobId, error);
    }
  }

  async executeGeneration(job, signal) {
    const workspace = workspaceById(this.config, job.workspace_id);
    // Reassert the durable claim at the last pre-dispatch boundary. This also
    // closes the crash window between persisting a job and its first claim.
    await this.store.reserveOutput({
      workspaceId: job.workspace_id,
      relativePath: job.private_input.output_path,
      jobId: job.job_id,
      intentHash: job.intent_hash,
      now: job.created_at
    });
    const output = await resolveNewWorkspaceFile(workspace.root, job.private_input.output_path);
    const generated = await this.provider.generate({
      prompt: job.private_input.prompt,
      size: job.private_input.size,
      quality: job.private_input.quality,
      signal,
      onCheckpoint: (patch) => this.providerCheckpoint(job.job_id, patch)
    });
    if (signal.aborted) throw new RuntimeError("PROVIDER_OUTCOME_UNKNOWN", "generation was interrupted", { dispatchStarted: true });
    const bytes = Buffer.isBuffer(generated?.bytes) ? generated.bytes : Buffer.from(generated?.bytes ?? []);
    if (bytes.length <= 0 || bytes.length > MAX_IMAGE_BYTES) throw new RuntimeError("INVALID_IMAGE_PAYLOAD", "generated image violates its byte budget", { dispatchStarted: true });
    const dimensions = parsePngDimensions(bytes);
    const expected = expectedDimensions(job.private_input.size);
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) throw new RuntimeError("INVALID_IMAGE_PAYLOAD", "generated dimensions do not match intent", { dispatchStarted: true });
    await atomicWriteNewBytes(output.absolutePath, bytes, job.job_id);
    const receipt = { path: output.relativePath, sha256: sha256(bytes), media_type: "image/png", byte_size: bytes.length, dimensions };
    await this.withJobLock(job.job_id, async () => {
      const current = await this.store.requireJob(job.job_id);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      const timestamp = nowIso(this.clock);
      const updated = {
        ...current,
        updated_at: timestamp,
        artifact_receipts: [receipt],
        provider_execution: {
          ...current.provider_execution,
          model: safeModel(generated.model) ?? current.provider_execution.model,
          state: "artifact_persisted",
          dispatch_state: "artifact_persisted",
          updated_at: timestamp
        }
      };
      await this.store.saveJob(updated);
      return updated;
    });
    await this.completeJob(job.job_id);
  }

  async executeInspection(job, signal) {
    const workspace = workspaceById(this.config, job.workspace_id);
    const input = await resolveExistingWorkspaceFile(workspace.root, job.private_input.image_path, { maxBytes: MAX_IMAGE_BYTES });
    const bytes = await readBoundedBytes(input.absolutePath, input.size, MAX_IMAGE_BYTES);
    if (sha256(bytes) !== job.private_input.input_hash) fail("INPUT_FILE_CHANGED", "inspection input changed after submission");
    const inspected = await this.provider.inspect({
      bytes,
      relativePath: input.relativePath,
      mediaType: job.private_input.media_type,
      prompt: job.private_input.prompt,
      mode: job.private_input.mode,
      signal,
      onCheckpoint: (patch) => this.providerCheckpoint(job.job_id, patch)
    });
    if (signal.aborted) throw new RuntimeError("PROVIDER_OUTCOME_UNKNOWN", "inspection was interrupted", { dispatchStarted: true });
    const inspectionText = boundedInspectionText(inspected?.text);
    await this.withJobLock(job.job_id, async () => {
      const current = await this.store.requireJob(job.job_id);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      const timestamp = nowIso(this.clock);
      const updated = {
        ...current,
        status: "completed",
        updated_at: timestamp,
        inspection_text: inspectionText,
        provider_execution: { ...current.provider_execution, model: safeModel(inspected.model) ?? current.provider_execution.model, state: "completed", dispatch_state: "result_available", updated_at: timestamp }
      };
      await this.store.saveJob(updated);
      return updated;
    });
    await this.ensureHandoff(job.job_id);
  }

  async completeJob(jobId) {
    await this.withJobLock(jobId, async () => {
      const current = await this.store.requireJob(jobId);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      const timestamp = nowIso(this.clock);
      const updated = { ...current, status: "completed", updated_at: timestamp, provider_execution: { ...current.provider_execution, state: "completed", updated_at: timestamp } };
      await this.store.saveJob(updated);
      return updated;
    });
    await this.ensureHandoff(jobId);
  }

  async settleFailure(jobId, error) {
    let shouldWrite = false;
    let releaseOutputFor = null;
    await this.withJobLock(jobId, async () => {
      const current = await this.store.requireJob(jobId);
      if (TERMINAL_STATUSES.has(current.status)) {
        shouldWrite = current.handoff_ref === null;
        return current;
      }
      const dispatchState = current.provider_execution?.dispatch_state ?? "not_started";
      const dispatchStarted = dispatchState !== "not_started" || error?.dispatchStarted === true;
      const definitive = error?.definitive === true;
      const status = dispatchStarted && !definitive ? "needs_review" : "failed";
      const timestamp = nowIso(this.clock);
      const updated = {
        ...current,
        status,
        updated_at: timestamp,
        diagnostic: { code: closedErrorCode(error), stage: dispatchStarted ? "provider_execution" : "pre_dispatch" },
        recovery: { retry_class: !dispatchStarted ? "safe_retry" : "new_job_required", reconciled_at: timestamp },
        provider_execution: {
          ...current.provider_execution,
          state: dispatchStarted && !definitive ? "unknown_after_dispatch" : "failed",
          updated_at: timestamp
        }
      };
      await this.store.saveJob(updated);
      shouldWrite = true;
      if (updated.kind === "generation" && status === "failed" && definitive && updated.artifact_receipts.length === 0) releaseOutputFor = updated;
      return updated;
    });
    if (shouldWrite) await this.ensureHandoff(jobId).catch(() => {});
    if (releaseOutputFor) await this.releaseGenerationOutput(releaseOutputFor);
  }

  async releaseGenerationOutput(job) {
    if (job?.kind !== "generation" || job.artifact_receipts?.length !== 0) return;
    await this.store.releaseOutput({
      workspaceId: job.workspace_id,
      relativePath: job.private_input.output_path,
      jobId: job.job_id
    });
  }

  async ensureHandoff(jobId) {
    const job = await this.store.requireJob(jobId);
    if (!TERMINAL_STATUSES.has(job.status)) return job;
    const handoffRef = await this.store.writeHandoff(jobId, buildHandoff(job));
    return this.withJobLock(jobId, async () => {
      const current = await this.store.requireJob(jobId);
      const updated = { ...current, handoff_ref: handoffRef, updated_at: current.updated_at };
      await this.store.saveJob(updated);
      return updated;
    });
  }

  async getJob(jobId) {
    await this.initialize();
    return publicJobResult(await this.store.requireJob(assertSafeJobId(jobId)));
  }

  async getHandoff(jobId) {
    await this.initialize();
    const job = await this.store.requireJob(assertSafeJobId(jobId));
    if (TERMINAL_STATUSES.has(job.status) && !job.handoff_ref) await this.ensureHandoff(jobId);
    const handoff = await this.store.readHandoff(jobId);
    return assertBoundedPublicJson({ job: publicJobResult(await this.store.requireJob(jobId)), ...handoff }, 24 * 1024, "handoff result");
  }

  async resumeJob(jobId) {
    await this.initialize();
    const id = assertSafeJobId(jobId);
    let schedule = false;
    let ensure = false;
    const job = await this.withJobLock(id, async () => {
      const current = await this.store.requireJob(id);
      if (current.status === "completed") {
        ensure = !current.handoff_ref;
        return current;
      }
      if (current.config_hash !== this.config.config_hash) fail("CONFIG_CHANGED", "job cannot be resumed under a different provider configuration");
      if (current.status === "queued") {
        schedule = true;
        return current;
      }
      if (current.status === "failed" && current.recovery?.retry_class === "safe_retry") {
        const timestamp = nowIso(this.clock);
        const updated = { ...current, status: "queued", updated_at: timestamp, diagnostic: null, recovery: null, provider_execution: { ...current.provider_execution, state: "not_started", dispatch_state: "not_started", started_at: null, updated_at: timestamp } };
        await this.store.saveJob(updated);
        schedule = true;
        return updated;
      }
      if (current.status === "needs_review") fail("AMBIGUOUS_DISPATCH", "ambiguous provider dispatch cannot be resumed automatically");
      if (current.status === "cancelled") fail("JOB_NOT_RESUMABLE", "cancelled job cannot be resumed");
      fail("JOB_NOT_RESUMABLE", "job cannot be resumed");
    });
    if (ensure) await this.ensureHandoff(id);
    if (schedule) this.schedule(id);
    return publicJobResult(await this.store.requireJob(id));
  }

  async cancelJob(jobId) {
    await this.initialize();
    const id = assertSafeJobId(jobId);
    const active = this.active.get(id);
    if (active) active.controller.abort();
    let writeHandoff = false;
    let releaseOutputFor = null;
    const result = await this.withJobLock(id, async () => {
      const current = await this.store.requireJob(id);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      const dispatched = current.provider_execution?.dispatch_state !== "not_started";
      const timestamp = nowIso(this.clock);
      const updated = dispatched
        ? { ...current, status: "needs_review", updated_at: timestamp, diagnostic: { code: "CANCELLED_AFTER_DISPATCH", stage: "provider_execution" }, recovery: { retry_class: "new_job_required", reconciled_at: timestamp }, provider_execution: { ...current.provider_execution, state: "unknown_after_dispatch", updated_at: timestamp } }
        : { ...current, status: "cancelled", updated_at: timestamp, diagnostic: null, recovery: null };
      await this.store.saveJob(updated);
      writeHandoff = true;
      if (!dispatched && updated.kind === "generation" && updated.artifact_receipts.length === 0) releaseOutputFor = updated;
      return updated;
    });
    if (writeHandoff) await this.ensureHandoff(id).catch(() => {});
    if (releaseOutputFor) {
      if (active?.promise) await active.promise.catch(() => {});
      await this.releaseGenerationOutput(releaseOutputFor);
    }
    return publicJobResult(await this.store.requireJob(id));
  }

  async listJobs({ limit = 20, status, workspace_id } = {}) {
    await this.initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) fail("INVALID_ARGUMENTS", "limit must be between 1 and 25");
    if (status !== undefined && !JOB_STATUSES.includes(status)) fail("INVALID_ARGUMENTS", "status filter is invalid");
    if (workspace_id !== undefined) workspaceById(this.config, workspace_id);
    const jobs = (await this.store.listJobs())
      .filter((job) => status === undefined || job.status === status)
      .filter((job) => workspace_id === undefined || job.workspace_id === workspace_id)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)) || right.job_id.localeCompare(left.job_id))
      .slice(0, limit)
      .map((job) => publicJobResult(job));
    return assertBoundedPublicJson({ count: jobs.length, jobs }, 28 * 1024, "job list");
  }

  async reconcileInterruptedJobs() {
    const jobs = await this.store.listJobs();
    for (const record of jobs) {
      let original = record;
      if (original.idempotency?.state === "pending") {
        let ownsClaim = false;
        let ownershipUnknown = false;
        try {
          ownsClaim = await this.store.isIdempotencyOwner({
            keyHash: original.idempotency.key_hash,
            intentHash: original.intent_hash,
            jobId: original.job_id
          });
        } catch {
          ownershipUnknown = true;
        }
        const timestamp = nowIso(this.clock);
        if (ownsClaim) {
          original = { ...original, idempotency: { ...original.idempotency, state: "claimed" }, updated_at: timestamp };
          await this.store.saveJob(original);
        } else {
          const dispatchStarted = original.provider_execution?.dispatch_state !== "not_started";
          original = {
            ...original,
            status: dispatchStarted || ownershipUnknown ? "needs_review" : "cancelled",
            updated_at: timestamp,
            diagnostic: { code: ownershipUnknown ? "IDEMPOTENCY_OWNERSHIP_UNKNOWN" : "IDEMPOTENCY_NOT_COMMITTED", stage: "recovery" },
            recovery: { retry_class: "new_job_required", reconciled_at: timestamp },
            provider_execution: { ...original.provider_execution, state: dispatchStarted ? "unknown_after_dispatch" : "failed", updated_at: timestamp }
          };
          await this.store.saveJob(original);
          await this.ensureHandoff(original.job_id).catch(() => {});
          continue;
        }
      }
      if (original.config_hash !== this.config.config_hash && (original.status === "running" || original.status === "queued")) {
        const timestamp = nowIso(this.clock);
        const changed = {
          ...original,
          status: "needs_review",
          updated_at: timestamp,
          diagnostic: { code: "CONFIG_CHANGED_DURING_JOB", stage: "recovery" },
          recovery: { retry_class: "new_job_required", reconciled_at: timestamp },
          provider_execution: { ...original.provider_execution, state: original.provider_execution?.dispatch_state === "not_started" ? "failed" : "unknown_after_dispatch", updated_at: timestamp }
        };
        await this.store.saveJob(changed);
        await this.ensureHandoff(changed.job_id).catch(() => {});
        continue;
      }
      let job = original;
      if (job.status === "running" || job.status === "queued") {
        const dispatch = job.provider_execution?.dispatch_state ?? "not_started";
        const timestamp = nowIso(this.clock);
        if (dispatch === "artifact_persisted" && job.artifact_receipts?.length === 1) {
          try {
            const workspace = workspaceById(this.config, job.workspace_id);
            const receipt = validateReceipt(job.artifact_receipts[0]);
            const file = await resolveExistingWorkspaceFile(workspace.root, receipt.path, { maxBytes: MAX_IMAGE_BYTES });
            const bytes = await readBoundedBytes(file.absolutePath, file.size, MAX_IMAGE_BYTES);
            if (sha256(bytes) !== receipt.sha256) throw new Error("artifact hash mismatch");
            job = { ...job, status: "completed", updated_at: timestamp, provider_execution: { ...job.provider_execution, state: "completed", updated_at: timestamp }, diagnostic: null, recovery: null };
          } catch {
            job = { ...job, status: "needs_review", updated_at: timestamp, diagnostic: { code: "ARTIFACT_RECOVERY_FAILED", stage: "artifact_persistence" }, recovery: { retry_class: "new_job_required", reconciled_at: timestamp }, provider_execution: { ...job.provider_execution, state: "unknown_after_dispatch", updated_at: timestamp } };
          }
        } else if (dispatch === "not_started") {
          job = { ...job, status: "failed", updated_at: timestamp, diagnostic: { code: "INTERRUPTED_BEFORE_DISPATCH", stage: "recovery" }, recovery: { retry_class: "safe_retry", reconciled_at: timestamp }, provider_execution: { ...job.provider_execution, state: "failed", updated_at: timestamp } };
        } else {
          job = { ...job, status: "needs_review", updated_at: timestamp, diagnostic: { code: "INTERRUPTED_AFTER_DISPATCH", stage: "recovery" }, recovery: { retry_class: "new_job_required", reconciled_at: timestamp }, provider_execution: { ...job.provider_execution, state: "unknown_after_dispatch", updated_at: timestamp } };
        }
        await this.store.saveJob(job);
      }
      if (TERMINAL_STATUSES.has(job.status) && !job.handoff_ref) await this.ensureHandoff(job.job_id).catch(() => {});
    }
  }

  async waitForIdle(jobId, { timeoutMs = 5_000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.store.requireJob(assertSafeJobId(jobId));
      if (TERMINAL_STATUSES.has(job.status)) return publicJobResult(job);
      if (Date.now() >= deadline) fail("WAIT_TIMEOUT", "job did not settle before timeout");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
