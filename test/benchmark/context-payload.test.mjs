import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BENCHMARK_OPTIONS,
  PAYLOAD_CLAIM_THRESHOLDS,
  buildSyntheticWorkflow,
  createDeterministicImageBytes,
  runPayloadBenchmark,
  serializedUtf8Bytes,
  verifyPayloadBenchmark
} from "../../benchmark/context-payload.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const benchmarkEntry = path.join(repositoryRoot, "benchmark", "context-payload.mjs");
const referenceReport = path.join(repositoryRoot, "benchmark", "results", "v0.1.0-payload-proxy.json");

test("default benchmark is deterministic and passes conservative claim gates", () => {
  const first = runPayloadBenchmark();
  const second = runPayloadBenchmark();

  assert.deepEqual(second, first);
  assert.equal(first.schema, "codex-image-context-payload-proxy-v1");
  assert.equal(first.options.jobs, 20);
  assert.equal(first.options.image_bytes_each, 1024 * 1024);
  assert.equal(first.artifact.raw_bytes_total, 20 * 1024 * 1024);
  assert.equal(first.baseline.inline_image_blocks, 20);
  assert.equal(first.candidate.inline_image_blocks, 0);
  assert.equal(first.candidate.inline_image_base64_chars, 0);
  assert.ok(first.comparison.reduction_percent >= PAYLOAD_CLAIM_THRESHOLDS.minimumReductionPercent);
  assert.ok(first.candidate.total_result_bytes <= first.baseline.total_result_bytes * 0.01);
  assert.ok(first.candidate.maximum_single_result_bytes <= PAYLOAD_CLAIM_THRESHOLDS.maximumCandidateResultBytes);
  assert.ok(first.scaling.candidate_payload_delta_bytes <= PAYLOAD_CLAIM_THRESHOLDS.maximumCandidateScalingDeltaBytes);
  assert.equal(first.execution.network_calls, 0);
  assert.equal(first.execution.provider_calls, 0);
  assert.equal(first.verification.passed, true);
});

test("checked-in v0.1 report matches a fresh default run", () => {
  const checkedIn = JSON.parse(fs.readFileSync(referenceReport, "utf8"));
  assert.deepEqual(checkedIn, runPayloadBenchmark());
});

test("candidate and baseline differ only by the naive inline image content block", () => {
  const image = createDeterministicImageBytes(4096, 7);
  const imageBase64 = image.toString("base64");
  const imageSha256 = "a".repeat(64);
  const { candidateResults, baselineResults } = buildSyntheticWorkflow({
    imageBytes: image.length,
    imageBase64,
    imageSha256,
    handoffBytes: 128
  });

  assert.equal(candidateResults.length, 3);
  assert.equal(baselineResults.length, 3);
  assert.deepEqual(candidateResults[0], baselineResults[0]);
  assert.deepEqual(candidateResults[2], baselineResults[2]);
  assert.deepEqual(baselineResults[1].structuredContent, candidateResults[1].structuredContent);
  assert.deepEqual(baselineResults[1].content[0], candidateResults[1].content[0]);
  assert.deepEqual(baselineResults[1].content[1], {
    type: "image",
    mimeType: "image/png",
    data: imageBase64
  });
  assert.ok(candidateResults.flatMap((result) => result.content).every((block) => block.type === "text"));
  assert.doesNotMatch(JSON.stringify(candidateResults), /data:image|;base64,|"type":"image"/i);
  assert.ok(serializedUtf8Bytes(baselineResults[1]) > serializedUtf8Bytes(candidateResults[1]) + imageBase64.length);
});

test("reference-only result size does not scale with synthetic image bytes", () => {
  const small = runPayloadBenchmark({ jobs: 1, imageBytes: 64 * 1024 });
  const large = runPayloadBenchmark({ jobs: 1, imageBytes: 4 * 1024 * 1024 });
  const candidateDelta = Math.abs(large.candidate.total_result_bytes - small.candidate.total_result_bytes);
  const baselineDelta = large.baseline.total_result_bytes - small.baseline.total_result_bytes;

  assert.ok(candidateDelta <= PAYLOAD_CLAIM_THRESHOLDS.maximumCandidateScalingDeltaBytes);
  assert.ok(baselineDelta > 5 * 1024 * 1024);
});

test("serialized metric counts UTF-8 bytes rather than JavaScript string length", () => {
  const value = { content: [{ type: "text", text: "图片🙂" }] };
  assert.ok(serializedUtf8Bytes(value) > JSON.stringify(value).length);
  assert.equal(serializedUtf8Bytes(value), Buffer.byteLength(JSON.stringify(value), "utf8"));
});

test("verifier rejects a result-size or reduction regression", () => {
  const report = runPayloadBenchmark({ jobs: 2, imageBytes: 64 * 1024 });
  const oversized = structuredClone(report);
  oversized.candidate.maximum_single_result_bytes = PAYLOAD_CLAIM_THRESHOLDS.maximumCandidateResultBytes + 1;
  assert.equal(verifyPayloadBenchmark(oversized).passed, false);

  const weakReduction = structuredClone(report);
  weakReduction.comparison.reduction_percent = PAYLOAD_CLAIM_THRESHOLDS.minimumReductionPercent - 0.01;
  assert.equal(verifyPayloadBenchmark(weakReduction).passed, false);
});

test("CLI emits a parseable self-contained JSON report", () => {
  const result = spawnSync(process.execPath, [
    benchmarkEntry,
    "--jobs", "2",
    "--image-bytes", "1048576",
    "--handoff-bytes", "128",
    "--seed", "9",
    "--verify",
    "--json"
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.options.jobs, 2);
  assert.equal(report.options.image_bytes_each, 1048576);
  assert.equal(report.options.handoff_utf8_bytes, 128);
  assert.equal(report.options.seed, 9);
  assert.equal(report.verification.passed, true);
  assert.deepEqual(report.execution, {
    synthetic_bytes_generated_in_memory: true,
    network_calls: 0,
    provider_calls: 0
  });
});

test("invalid CLI bounds fail before running the benchmark", () => {
  const result = spawnSync(process.execPath, [benchmarkEntry, "--jobs", "0"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /jobs must be an integer from 1 to 1000/);
});

test("documented defaults stay aligned with exported defaults", () => {
  assert.deepEqual(DEFAULT_BENCHMARK_OPTIONS, {
    jobs: 20,
    imageBytes: 1024 * 1024,
    handoffBytes: 512,
    seed: 20260811
  });
});
