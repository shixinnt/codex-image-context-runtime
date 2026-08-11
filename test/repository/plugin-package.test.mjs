import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKETPLACE_PATH = path.join(ROOT, ".agents", "plugins", "marketplace.json");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("marketplace points to the public plugin", async () => {
  const marketplace = await readJson(MARKETPLACE_PATH);
  assert.equal(marketplace.name, "codex-image-context-runtime");
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, "codex-image-context-runtime");
  assert.equal(entry.source.source, "local");
  assert.match(entry.source.path, /^\.\/plugins\//);
  const pluginRoot = path.resolve(ROOT, entry.source.path);
  assert.equal((await fs.stat(pluginRoot)).isDirectory(), true);
  assert.equal(path.relative(ROOT, pluginRoot).startsWith(".."), false);
});

test("plugin manifest, MCP config, and skill agree", async () => {
  const pluginRoot = path.join(ROOT, "plugins", "codex-image-context-runtime");
  const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "codex-image-context-runtime");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(manifest.interface.capabilities, [
    "Generate images",
    "Inspect images",
    "Resume image jobs"
  ]);
  assert.deepEqual(manifest.author, { name: "Image Context Runtime contributors" });

  const mcp = await readJson(path.join(pluginRoot, ".mcp.json"));
  const server = mcp.mcpServers.image_context_runtime;
  assert.equal(server.command, "node");
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.args, ["./mcp/server.mjs"]);
  assert.equal((await fs.stat(path.join(pluginRoot, "mcp", "server.mjs"))).isFile(), true);

  const skill = await fs.readFile(path.join(pluginRoot, "skills", "image-context-runtime", "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: image-context-runtime\r?\n/);
  assert.match(skill, /bounded MCP boundary/i);
  assert.doesNotMatch(skill, /\[TODO:/i);
});

test("repository metadata is non-personal and Apache-2.0", async () => {
  const rootPackage = await readJson(path.join(ROOT, "package.json"));
  assert.equal(rootPackage.license, "Apache-2.0");
  const notice = await fs.readFile(path.join(ROOT, "NOTICE"), "utf8");
  assert.match(notice, /codex-image-context-runtime/i);
  assert.doesNotMatch(notice, /@/);
});
