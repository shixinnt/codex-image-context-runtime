import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HANDOFF_MAX_BYTES, JOB_SCHEMA } from "./constants.mjs";
import { assertSafeJobId, assertSafePublicText, atomicWriteJson, readBoundedBytes, readJsonFileBounded, sha256 } from "./safety.mjs";
import { fail } from "./errors.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/;

export class JobStore {
  constructor(config, { processKill = process.kill } = {}) {
    this.config = config;
    this.processKill = processKill;
    this.jobsDir = path.join(config.runtime_dir, "jobs");
    this.idempotencyDir = path.join(config.runtime_dir, "idempotency");
    this.outputReservationsDir = path.join(config.runtime_dir, "output-reservations");
  }

  async initialize() {
    await fs.mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.idempotencyDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.outputReservationsDir, { recursive: true, mode: 0o700 });
    const statePath = path.join(this.config.runtime_dir, "runtime.json");
    const expected = {
      schema: "codex-image-context-runtime-state-v1",
      active_config_hash: this.config.config_hash,
      protocol_version: "1.0"
    };
    const exists = await fs.stat(statePath).then((entry) => entry.isFile()).catch(() => false);
    if (exists) {
      const current = await readJsonFileBounded(statePath, 16 * 1024).catch(() => fail("RUNTIME_STATE_INVALID", "runtime state is unreadable"));
      if (current.schema !== expected.schema || current.protocol_version !== expected.protocol_version) fail("RUNTIME_STATE_INVALID", "runtime state contract is invalid");
      await atomicWriteJson(statePath, expected);
    } else {
      await atomicWriteJson(statePath, expected);
    }
  }

  createJobId() {
    return `img_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
  }

  jobPath(jobId) {
    return path.join(this.jobsDir, `${assertSafeJobId(jobId)}.json`);
  }

  async saveJob(job) {
    if (!job || typeof job !== "object" || Array.isArray(job) || job.schema !== JOB_SCHEMA) fail("JOB_RECORD_INVALID", "job record is invalid");
    assertSafeJobId(job.job_id);
    await atomicWriteJson(this.jobPath(job.job_id), job);
    return job;
  }

  async loadJob(jobId) {
    const filePath = this.jobPath(jobId);
    try {
      const value = await readJsonFileBounded(filePath, 256 * 1024);
      if (!value || value.schema !== JOB_SCHEMA || value.job_id !== jobId) fail("JOB_RECORD_INVALID", "job record identity is invalid");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error.code === "CONFIG_INVALID") fail("JOB_RECORD_INVALID", "job record is unreadable");
      throw error;
    }
  }

  async requireJob(jobId) {
    const job = await this.loadJob(jobId);
    if (!job) fail("JOB_NOT_FOUND", "job does not exist");
    return job;
  }

  async deleteJobRecord(jobId) {
    await fs.rm(this.jobPath(jobId), { force: true });
  }

  async listJobs() {
    let names;
    try {
      names = await fs.readdir(this.jobsDir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const jobs = [];
    for (const name of names.filter((candidate) => /^img_[A-Za-z0-9_-]+\.json$/.test(candidate)).sort()) {
      try {
        const job = await this.loadJob(name.slice(0, -5));
        if (job) jobs.push(job);
      } catch {
        // Malformed records remain on disk and are omitted from public listing.
      }
    }
    return jobs;
  }

  async claimIdempotency({ key, intentHash, jobId, now }) {
    if (typeof key !== "string" || key.length < 8 || key.length > 256 || /[\u0000-\u001f]/.test(key)) fail("INVALID_IDEMPOTENCY_KEY", "idempotency key is invalid");
    if (!HASH.test(intentHash)) fail("INVALID_INTENT_HASH", "intent hash is invalid");
    assertSafeJobId(jobId);
    const keyHash = sha256(key);
    const filePath = path.join(this.idempotencyDir, `${keyHash.slice("sha256:".length)}.json`);
    const reservation = {
      schema: "codex-image-context-idempotency-v1",
      key_hash: keyHash,
      intent_hash: intentHash,
      job_id: jobId,
      created_at: now
    };
    try {
      const handle = await fs.open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { claimed: true, job_id: jobId };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let existing;
    try {
      existing = await readJsonFileBounded(filePath, 16 * 1024);
    } catch {
      fail("IDEMPOTENCY_RESERVATION_INVALID", "idempotency reservation is unreadable");
    }
    if (existing.key_hash !== keyHash || existing.intent_hash !== intentHash || typeof existing.job_id !== "string") fail("IDEMPOTENCY_CONFLICT", "idempotency key is bound to different intent");
    assertSafeJobId(existing.job_id);
    return { claimed: false, job_id: existing.job_id };
  }

  async isIdempotencyOwner({ keyHash, intentHash, jobId }) {
    if (!HASH.test(keyHash) || !HASH.test(intentHash)) fail("IDEMPOTENCY_RESERVATION_INVALID", "idempotency ownership metadata is invalid");
    assertSafeJobId(jobId);
    const filePath = path.join(this.idempotencyDir, `${keyHash.slice("sha256:".length)}.json`);
    let existing;
    try {
      existing = await readJsonFileBounded(filePath, 16 * 1024);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      fail("IDEMPOTENCY_RESERVATION_INVALID", "idempotency reservation is unreadable");
    }
    if (existing?.schema !== "codex-image-context-idempotency-v1" || existing.key_hash !== keyHash) {
      fail("IDEMPOTENCY_RESERVATION_INVALID", "idempotency reservation is invalid");
    }
    return existing.intent_hash === intentHash && existing.job_id === jobId;
  }

  async reserveOutput({ workspaceId, relativePath, jobId, intentHash, now }) {
    if (typeof workspaceId !== "string" || workspaceId.length < 1 || workspaceId.length > 96) fail("INVALID_ARGUMENTS", "workspace id is invalid");
    if (typeof relativePath !== "string" || relativePath.length < 1 || relativePath.length > 512) fail("INVALID_ARGUMENTS", "output path is invalid");
    if (!HASH.test(intentHash)) fail("INVALID_INTENT_HASH", "intent hash is invalid");
    assertSafeJobId(jobId);
    const pathKey = relativePath.normalize("NFKC").toLowerCase();
    const outputHash = sha256(`${workspaceId}\u0000${pathKey}`);
    const filePath = path.join(this.outputReservationsDir, `${outputHash.slice("sha256:".length)}.json`);
    const reservation = {
      schema: "codex-image-context-output-reservation-v1",
      output_hash: outputHash,
      workspace_id: workspaceId,
      path_key: pathKey,
      relative_path: relativePath,
      intent_hash: intentHash,
      job_id: jobId,
      created_at: now
    };
    try {
      const handle = await fs.open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { reserved: true, job_id: jobId };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let existing;
    try {
      existing = await readJsonFileBounded(filePath, 16 * 1024);
    } catch {
      fail("OUTPUT_RESERVATION_INVALID", "output reservation is unreadable");
    }
    if (existing.schema !== reservation.schema || existing.output_hash !== outputHash || existing.workspace_id !== workspaceId || existing.path_key !== pathKey) {
      fail("OUTPUT_RESERVATION_INVALID", "output reservation is invalid");
    }
    if (existing.job_id === jobId && existing.intent_hash === intentHash) return { reserved: false, job_id: jobId };
    fail("OUTPUT_RESERVED", "output path is already reserved by another job");
  }

  async releaseOutput({ workspaceId, relativePath, jobId }) {
    const pathKey = relativePath.normalize("NFKC").toLowerCase();
    const outputHash = sha256(`${workspaceId}\u0000${pathKey}`);
    const filePath = path.join(this.outputReservationsDir, `${outputHash.slice("sha256:".length)}.json`);
    try {
      const current = await readJsonFileBounded(filePath, 16 * 1024);
      if (current.output_hash === outputHash && current.workspace_id === workspaceId && current.path_key === pathKey && current.job_id === jobId) {
        await fs.rm(filePath, { force: true });
      }
    } catch {
      // A missing, malformed, or replaced reservation is never removed blindly.
    }
  }

  handoffRef(jobId) {
    return `jobs/${assertSafeJobId(jobId)}/handoff.md`;
  }

  handoffPath(jobId) {
    return path.join(this.jobsDir, assertSafeJobId(jobId), "handoff.md");
  }

  async writeHandoff(jobId, text) {
    assertSafePublicText(text, "handoff");
    const encoded = Buffer.from(text, "utf8");
    if (encoded.length > HANDOFF_MAX_BYTES) fail("HANDOFF_TOO_LARGE", "handoff exceeded its byte budget");
    const target = this.handoffPath(jobId);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(target), `.handoff.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(temp, encoded, { flag: "wx", mode: 0o600 });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    return this.handoffRef(jobId);
  }

  async readHandoff(jobId) {
    const target = this.handoffPath(jobId);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      fail("HANDOFF_NOT_READY", "handoff is unavailable");
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > HANDOFF_MAX_BYTES) fail("HANDOFF_NOT_READY", "handoff violates its byte budget");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(target, stat.size, HANDOFF_MAX_BYTES));
    } catch {
      fail("HANDOFF_NOT_READY", "handoff is unreadable");
    }
    assertSafePublicText(text, "handoff");
    return { handoff_ref: this.handoffRef(jobId), handoff_text: text };
  }

  async acquireRuntimeLock({ pid = process.pid } = {}) {
    return this.withRuntimeLockGuard(async () => {
      const filePath = path.join(this.config.runtime_dir, "runtime.lock");
      const token = crypto.randomBytes(24).toString("hex");
      const attempt = async () => {
        const tempPath = path.join(this.config.runtime_dir, `.runtime.lock.${pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
        const handle = await fs.open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid, token, acquired_at: new Date().toISOString() })}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          // A hard link publishes the already-synced record atomically and never
          // overwrites another owner. A crash can leave only an ignorable temp.
          await fs.link(tempPath, filePath);
          return { filePath, token, pid };
        } finally {
          await fs.rm(tempPath, { force: true }).catch(() => {});
        }
      };
      try {
        return await attempt();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let existing;
      try {
        existing = await readJsonFileBounded(filePath, 16 * 1024);
      } catch {
        fail("RUNTIME_ALREADY_RUNNING", "runtime lock is unreadable");
      }
      if (!Number.isInteger(existing?.pid) || existing.pid <= 0 || typeof existing?.token !== "string" || existing.token.length < 8 || existing.token.length > 128) {
        fail("RUNTIME_ALREADY_RUNNING", "runtime lock is invalid");
      }
      let alive = false;
      try {
        this.processKill(existing.pid, 0);
        alive = true;
      } catch (error) {
        // Only a definitive "no such process" permits stale-lock recovery.
        // Permission failures and unknown platform errors fail closed.
        alive = error?.code !== "ESRCH";
      }
      if (alive) fail("RUNTIME_ALREADY_RUNNING", "another process owns this runtime directory");
      await fs.rm(filePath, { force: true });
      try {
        return await attempt();
      } catch {
        fail("RUNTIME_ALREADY_RUNNING", "runtime lock could not be acquired");
      }
    });
  }

  async releaseRuntimeLock(lock) {
    if (!lock) return;
    await this.withRuntimeLockGuard(async () => {
      try {
        const current = await readJsonFileBounded(lock.filePath, 16 * 1024);
        if (current.pid === lock.pid && current.token === lock.token) await fs.rm(lock.filePath, { force: true });
      } catch {
        // A missing or replaced lock is never removed blindly.
      }
    });
  }

  async withRuntimeLockGuard(operation) {
    const guardPath = path.join(this.config.runtime_dir, "runtime.lock.guard");
    try {
      await fs.mkdir(guardPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail("RUNTIME_ALREADY_RUNNING", "runtime lock acquisition is already in progress");
      throw error;
    }
    try {
      return await operation();
    } finally {
      // Never remove recursively: unexpected guard contents must fail closed.
      await fs.rmdir(guardPath).catch(() => {});
    }
  }
}
