import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanPublicTree, scanRepository } from "../../scripts/check-public-tree.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function temporaryTree(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `public-tree-${label}-`));
}

test("ordinary Apache licensing language is accepted", async (t) => {
  const root = await temporaryTree("license");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "LICENSE"),
    "License patent claims contributor NOTICE copyright warranty redistribution derivative work\n",
    "utf8"
  );
  assert.deepEqual(await scanPublicTree(root), []);
});

test("personal paths, email addresses, and secret shapes are rejected without echoing values", async (t) => {
  const root = await temporaryTree("negative");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const email = ["person", "sample.invalid"].join("@");
  const windowsPath = ["C:", "Users", "real-user", "image.png"].join("\\");
  const unixPath = ["", "home", "real-user", "image.png"].join("/");
  const secretShape = ["sk", "live", "x".repeat(24)].join("-");

  await fs.writeFile(path.join(root, "email.txt"), `${email}\n`, "utf8");
  await fs.writeFile(path.join(root, "paths.txt"), `${windowsPath}\n${unixPath}\n`, "utf8");
  await fs.writeFile(path.join(root, "secret.txt"), `${secretShape}\n`, "utf8");

  const findings = await scanPublicTree(root);
  const kinds = new Set(findings.map((finding) => finding.kind));
  assert.ok(kinds.has("email-address"));
  assert.ok(kinds.has("windows-user-directory"));
  assert.ok(kinds.has("unix-user-directory"));
  assert.ok(kinds.has("provider-secret"));
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes(email)));
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes(secretShape)));
});

test("the repository passes its own public-tree and Git metadata audit", async () => {
  assert.deepEqual(await scanRepository(REPOSITORY_ROOT), []);
});
