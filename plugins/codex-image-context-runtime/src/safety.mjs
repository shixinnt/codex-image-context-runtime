import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeError, fail } from "./errors.mjs";

const SAFE_ID = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const SAFE_JOB_ID = /^img_[A-Za-z0-9_-]{8,96}$/;
const INLINE_MEDIA = /(?:data:(?:image|video|audio)\/|;base64,|\bbase64,|\biVBORw0KGgo[A-Za-z0-9+/=]{8,}|(?:^|\s)\/9j\/[A-Za-z0-9+/=]{8,}|\bUklGR[A-Za-z0-9+/=]{12,}|\bR0lGOD[A-Za-z0-9+/=]{12,})/im;
const SECRET_MATERIAL = /(?:\bAuthorization\s*:\s*[^\r\n]+|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,})/i;
const ABSOLUTE_TEXT_PATH = /(?:^|[\s("'`=:\[])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)[^\/\s"'`<>|]+(?:\/[^\/\s"'`<>|]+)*)/m;
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const DEFAULT_TRANSIENT_FS_DELAYS_MS = Object.freeze([15, 30, 60, 120, 240, 480, 600]);

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertExactKeys(value, { required = [], optional = [] } = {}, label = "object") {
  if (!isPlainObject(value)) fail("INVALID_ARGUMENTS", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALID_ARGUMENTS", `${label} has an unknown field`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("INVALID_ARGUMENTS", `${label} is missing a field`);
  return value;
}

export function assertSafeId(value, label = "id") {
  if (typeof value !== "string" || value.length > 96 || !SAFE_ID.test(value)) fail("INVALID_ARGUMENTS", `${label} is invalid`);
  return value;
}

export function assertSafeJobId(value) {
  if (typeof value !== "string" || !SAFE_JOB_ID.test(value)) fail("INVALID_JOB_ID", "job_id is invalid");
  return value;
}

export function assertBoundedText(value, label, { min = 1, max = 16_384 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    fail("INVALID_ARGUMENTS", `${label} must be bounded text`);
  }
  if (INLINE_MEDIA.test(value)) fail("INLINE_MEDIA_FORBIDDEN", `${label} cannot contain inline media`);
  if (SECRET_MATERIAL.test(value)) fail("SECRET_MATERIAL_FORBIDDEN", `${label} cannot contain credentials`);
  return value;
}

export function normalizeRelativePath(value, label = "path") {
  assertBoundedText(value, label, { min: 1, max: 512 });
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    fail("PATH_OUTSIDE_WORKSPACE", `${label} must be relative`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.includes(":")) fail("PATH_OUTSIDE_WORKSPACE", `${label} cannot contain a colon`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail("PATH_OUTSIDE_WORKSPACE", `${label} has an unsafe segment`);
  if (parts.some((part) => part.length > 240 || /[<>"|?*]/.test(part) || /[. ]$/.test(part))) fail("PATH_OUTSIDE_WORKSPACE", `${label} is not a portable file path`);
  if (parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("PATH_OUTSIDE_WORKSPACE", `${label} contains a reserved device name`);
  return normalized;
}

export function isInsideOrEqual(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveExistingWorkspaceFile(workspaceRoot, relativeRef, { maxBytes } = {}) {
  const relative = normalizeRelativePath(relativeRef, "workspace file reference");
  const realRoot = await fs.realpath(workspaceRoot);
  const lexical = path.resolve(realRoot, relative);
  if (!isInsideOrEqual(realRoot, lexical)) fail("PATH_OUTSIDE_WORKSPACE", "workspace file escaped its root");
  let realFile;
  try {
    realFile = await fs.realpath(lexical);
  } catch {
    fail("INPUT_FILE_UNAVAILABLE", "workspace file is unavailable");
  }
  if (!isInsideOrEqual(realRoot, realFile)) fail("PATH_OUTSIDE_WORKSPACE", "workspace file escaped through a link");
  const stat = await fs.stat(realFile);
  if (!stat.isFile() || stat.size <= 0 || (maxBytes !== undefined && stat.size > maxBytes)) fail("INPUT_FILE_INVALID", "workspace file violates its size contract");
  return { absolutePath: realFile, relativePath: relative, size: stat.size };
}

async function nearestExistingAncestor(candidate, stopAt) {
  let current = candidate;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.resolve(current) === path.resolve(stopAt)) return stopAt;
    const parent = path.dirname(current);
    if (parent === current) fail("PATH_OUTSIDE_WORKSPACE", "output parent is invalid");
    current = parent;
  }
}

export async function resolveNewWorkspaceFile(workspaceRoot, relativeRef) {
  const relative = normalizeRelativePath(relativeRef, "output path");
  const realRoot = await fs.realpath(workspaceRoot);
  const candidate = path.resolve(realRoot, relative);
  if (!isInsideOrEqual(realRoot, candidate) || candidate === realRoot) fail("PATH_OUTSIDE_WORKSPACE", "output path escaped its root");
  const parent = path.dirname(candidate);
  const existingAncestor = await nearestExistingAncestor(parent, realRoot);
  const realAncestor = await fs.realpath(existingAncestor);
  if (!isInsideOrEqual(realRoot, realAncestor)) fail("PATH_OUTSIDE_WORKSPACE", "output parent escaped through a link");
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!isInsideOrEqual(realRoot, realParent)) fail("PATH_OUTSIDE_WORKSPACE", "output parent escaped through a link");
  if (path.resolve(realParent) !== path.resolve(parent)) {
    fail("OUTPUT_PATH_ALIAS_FORBIDDEN", "output parent cannot traverse a filesystem alias");
  }
  try {
    await fs.lstat(candidate);
    fail("OUTPUT_ALREADY_EXISTS", "output path already exists");
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  return { absolutePath: candidate, relativePath: relative };
}

export async function readBoundedBytes(filePath, expectedSize, maxBytes) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maxBytes) fail("INPUT_FILE_INVALID", "file size is invalid");
  const bytes = await readFileAtMost(filePath, expectedSize);
  if (bytes.length !== expectedSize || bytes.length > maxBytes) fail("INPUT_FILE_CHANGED", "file changed while being read");
  return bytes;
}

async function readFileAtMost(filePath, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("INPUT_FILE_INVALID", "file byte budget is invalid");
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("INPUT_FILE_INVALID", "input is not a file");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) fail("INPUT_FILE_CHANGED", "file exceeded its byte budget while being read");
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export function sha256(bytesOrText, { prefixed = true } = {}) {
  const digest = crypto.createHash("sha256").update(bytesOrText).digest("hex");
  return prefixed ? `sha256:${digest}` : digest;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_JSON", "non-finite numbers are forbidden");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) fail("INVALID_JSON", "value is not canonical JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function assertTextOnly(value, label = "value") {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) fail("BINARY_OUTPUT_FORBIDDEN", `${label} cannot contain binary media`);
  if (typeof value === "string") {
    if (INLINE_MEDIA.test(value)) fail("INLINE_MEDIA_FORBIDDEN", `${label} cannot contain inline media`);
    if (SECRET_MATERIAL.test(value)) fail("SECRET_MATERIAL_FORBIDDEN", `${label} cannot contain credentials`);
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertTextOnly(item, label));
    return value;
  }
  if (isPlainObject(value)) {
    Object.values(value).forEach((item) => assertTextOnly(item, label));
    return value;
  }
  if (value === null || ["number", "boolean", "undefined"].includes(typeof value)) return value;
  fail("UNSAFE_PUBLIC_OUTPUT", `${label} has an unsupported value`);
}

export function assertSafePublicText(value, label = "public text") {
  assertBoundedText(value, label, { min: 0, max: 16_384 });
  if (ABSOLUTE_TEXT_PATH.test(value)) fail("ABSOLUTE_PATH_FORBIDDEN", `${label} cannot contain absolute paths`);
  return value;
}

export function assertPublicValue(value, label = "public value") {
  assertTextOnly(value, label);
  if (typeof value === "string" && ABSOLUTE_TEXT_PATH.test(value)) fail("ABSOLUTE_PATH_FORBIDDEN", `${label} cannot contain absolute paths`);
  if (Array.isArray(value)) value.forEach((item) => assertPublicValue(item, label));
  else if (isPlainObject(value)) Object.values(value).forEach((item) => assertPublicValue(item, label));
  return value;
}

export function byteLengthJson(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function retryTransientFs(operation, {
  delaysMs = DEFAULT_TRANSIENT_FS_DELAYS_MS,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
} = {}) {
  if (typeof operation !== "function" || !Array.isArray(delaysMs) || typeof sleep !== "function") {
    throw new TypeError("invalid transient filesystem retry configuration");
  }
  let retryIndex = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_FS_CODES.has(error?.code) || retryIndex >= delaysMs.length) throw error;
      const delayMs = delaysMs[retryIndex];
      retryIndex += 1;
      if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2_000) {
        throw new TypeError("invalid transient filesystem retry delay");
      }
      await sleep(delayMs);
    }
  }
}

export function assertBoundedPublicJson(value, maxBytes, label = "public result") {
  assertPublicValue(value, label);
  if (byteLengthJson(value) > maxBytes) fail("PUBLIC_RESULT_TOO_LARGE", `${label} exceeded its byte budget`);
  return value;
}

export async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    const handle = await retryTransientFs(() => fs.open(tempPath, "wx", 0o600));
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await retryTransientFs(() => fs.rename(tempPath, filePath));
  } finally {
    await retryTransientFs(() => fs.rm(tempPath, { force: true })).catch(() => {});
  }
}

export async function atomicWriteNewBytes(filePath, bytes, token) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail("INVALID_MEDIA_BYTES", "artifact bytes are invalid");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const safeToken = String(token).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "artifact";
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${safeToken}.${process.pid}.tmp`);
  try {
    const handle = await retryTransientFs(() => fs.open(tempPath, "wx", 0o600));
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(tempPath, filePath);
    } catch (error) {
      if (error.code === "EEXIST") throw error;
      if (!new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"]).has(error.code)) throw error;
      // Some valid Windows/SMB workspaces do not support hard links. Preserve
      // no-overwrite semantics with an exclusive destination handle.
      const output = await retryTransientFs(() => fs.open(filePath, "wx", 0o600));
      try {
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await output.close();
      }
    }
  } catch (error) {
    if (error.code === "EEXIST") fail("OUTPUT_ALREADY_EXISTS", "output path already exists");
    throw error;
  } finally {
    await retryTransientFs(() => fs.rm(tempPath, { force: true })).catch(() => {});
  }
}

export async function readJsonFileBounded(filePath, maxBytes = 1024 * 1024) {
  let bytes;
  try {
    bytes = await readFileAtMost(filePath, maxBytes);
    if (bytes.length < 2) fail("CONFIG_INVALID", "JSON file violates its size contract");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    fail("CONFIG_INVALID", "JSON file is invalid");
  }
}
