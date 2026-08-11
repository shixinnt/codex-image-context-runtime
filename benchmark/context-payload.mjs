#!/usr/bin/env node

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEFAULT_BENCHMARK_OPTIONS = Object.freeze({
  jobs: 20,
  imageBytes: 1024 * 1024,
  handoffBytes: 512,
  seed: 20260811
});

export const PAYLOAD_CLAIM_THRESHOLDS = Object.freeze({
  minimumReductionPercent: 99,
  maximumCandidateResultBytes: 32 * 1024,
  maximumCandidateScalingDeltaBytes: 128
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SCALING_IMAGE_BYTES = Object.freeze([64 * 1024, 1024 * 1024, 4 * 1024 * 1024]);
const MAX_JOBS = 1000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_HANDOFF_BYTES = 16 * 1024;

function assertInteger(name, value, { minimum, maximum }) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeOptions(options = {}) {
  const merged = { ...DEFAULT_BENCHMARK_OPTIONS, ...options };
  return Object.freeze({
    jobs: assertInteger("jobs", merged.jobs, { minimum: 1, maximum: MAX_JOBS }),
    imageBytes: assertInteger("imageBytes", merged.imageBytes, { minimum: PNG_SIGNATURE.length, maximum: MAX_IMAGE_BYTES }),
    handoffBytes: assertInteger("handoffBytes", merged.handoffBytes, { minimum: 0, maximum: MAX_HANDOFF_BYTES }),
    seed: assertInteger("seed", merged.seed, { minimum: 0, maximum: 0xffffffff })
  });
}

function xorshift32(state) {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

export function createDeterministicImageBytes(byteLength, seed = DEFAULT_BENCHMARK_OPTIONS.seed) {
  assertInteger("byteLength", byteLength, { minimum: PNG_SIGNATURE.length, maximum: MAX_IMAGE_BYTES });
  assertInteger("seed", seed, { minimum: 0, maximum: 0xffffffff });

  const bytes = Buffer.allocUnsafe(byteLength);
  let state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    state = xorshift32(state);
    const remaining = Math.min(4, bytes.length - offset);
    for (let index = 0; index < remaining; index += 1) {
      bytes[offset + index] = (state >>> (index * 8)) & 0xff;
    }
  }
  PNG_SIGNATURE.copy(bytes, 0);
  return bytes;
}

function fixedUtf8Text(byteLength) {
  assertInteger("handoffBytes", byteLength, { minimum: 0, maximum: MAX_HANDOFF_BYTES });
  if (byteLength === 0) return "";
  const prefix = "Synthetic bounded handoff. ";
  if (byteLength <= prefix.length) return "x".repeat(byteLength);
  return prefix + "x".repeat(byteLength - prefix.length);
}

function paddedIndex(index, total) {
  const width = Math.max(4, String(total).length);
  return String(index + 1).padStart(width, "0");
}

function textResult(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

/**
 * Build a three-result synthetic MCP control loop for one image job.
 *
 * Both variants contain identical text and JSON metadata. The deliberately
 * naive baseline adds one MCP ImageContent block to the completed status
 * result. The reference-only candidate does not transport the image bytes.
 */
export function buildSyntheticWorkflow({
  index = 0,
  total = 1,
  imageBytes,
  imageBase64,
  imageSha256,
  handoffBytes = DEFAULT_BENCHMARK_OPTIONS.handoffBytes
} = {}) {
  assertInteger("index", index, { minimum: 0, maximum: Math.max(0, total - 1) });
  assertInteger("total", total, { minimum: 1, maximum: MAX_JOBS });
  assertInteger("imageBytes", imageBytes, { minimum: PNG_SIGNATURE.length, maximum: MAX_IMAGE_BYTES });
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) throw new TypeError("imageBase64 is required");
  if (typeof imageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(imageSha256)) throw new TypeError("imageSha256 is invalid");

  const suffix = paddedIndex(index, total);
  const jobId = `synthetic_job_${suffix}`;
  const artifactRef = `artifacts/frame-${suffix}.png`;
  const handoffRef = `handoffs/${jobId}.md`;
  const handoffText = fixedUtf8Text(handoffBytes);

  const submitted = textResult(`Image job ${jobId} was accepted.`, {
    job_id: jobId,
    status: "queued"
  });

  const completedStructuredContent = {
    schema: "image-context-public-result-v1",
    job_id: jobId,
    status: "completed",
    artifact_refs: [artifactRef],
    evidence_refs: [handoffRef],
    artifact: {
      ref: artifactRef,
      sha256: `sha256:${imageSha256}`,
      media_type: "image/png",
      byte_size: imageBytes
    }
  };

  const candidateCompleted = textResult(`Image job ${jobId} completed.`, completedStructuredContent);
  const baselineCompleted = {
    content: [
      { type: "text", text: `Image job ${jobId} completed.` },
      { type: "image", mimeType: "image/png", data: imageBase64 }
    ],
    structuredContent: completedStructuredContent
  };

  const handoff = textResult(`Loaded the bounded handoff for ${jobId}.`, {
    job_id: jobId,
    status: "completed",
    handoff_ref: handoffRef,
    handoff_text: handoffText
  });

  return {
    candidateResults: [submitted, candidateCompleted, handoff],
    baselineResults: [submitted, baselineCompleted, handoff]
  };
}

export function serializedUtf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function measureResults(results) {
  const resultBytes = results.map(serializedUtf8Bytes);
  return {
    result_count: results.length,
    total_result_bytes: resultBytes.reduce((sum, value) => sum + value, 0),
    maximum_single_result_bytes: Math.max(...resultBytes)
  };
}

function runScenario(options) {
  const image = createDeterministicImageBytes(options.imageBytes, options.seed);
  const imageBase64 = image.toString("base64");
  const imageSha256 = crypto.createHash("sha256").update(image).digest("hex");
  const baseline = { result_count: 0, total_result_bytes: 0, maximum_single_result_bytes: 0 };
  const candidate = { result_count: 0, total_result_bytes: 0, maximum_single_result_bytes: 0 };

  for (let index = 0; index < options.jobs; index += 1) {
    const workflow = buildSyntheticWorkflow({
      index,
      total: options.jobs,
      imageBytes: options.imageBytes,
      imageBase64,
      imageSha256,
      handoffBytes: options.handoffBytes
    });
    const baselineMeasurement = measureResults(workflow.baselineResults);
    const candidateMeasurement = measureResults(workflow.candidateResults);
    baseline.result_count += baselineMeasurement.result_count;
    baseline.total_result_bytes += baselineMeasurement.total_result_bytes;
    baseline.maximum_single_result_bytes = Math.max(baseline.maximum_single_result_bytes, baselineMeasurement.maximum_single_result_bytes);
    candidate.result_count += candidateMeasurement.result_count;
    candidate.total_result_bytes += candidateMeasurement.total_result_bytes;
    candidate.maximum_single_result_bytes = Math.max(candidate.maximum_single_result_bytes, candidateMeasurement.maximum_single_result_bytes);
  }

  return {
    artifact: {
      count: options.jobs,
      bytes_each: options.imageBytes,
      raw_bytes_total: options.jobs * options.imageBytes,
      base64_chars_each: imageBase64.length,
      sha256: `sha256:${imageSha256}`
    },
    baseline: {
      id: "naive-inline-image-result",
      ...baseline,
      inline_image_blocks: options.jobs,
      inline_image_base64_chars: imageBase64.length * options.jobs
    },
    candidate: {
      id: "reference-only-result",
      ...candidate,
      inline_image_blocks: 0,
      inline_image_base64_chars: 0
    }
  };
}

function runScalingSweep(options) {
  const entries = SCALING_IMAGE_BYTES.map((imageBytes) => {
    const scenario = runScenario({ ...options, jobs: 1, imageBytes });
    return {
      image_bytes: imageBytes,
      baseline_total_result_bytes: scenario.baseline.total_result_bytes,
      candidate_total_result_bytes: scenario.candidate.total_result_bytes
    };
  });
  const candidateSizes = entries.map((entry) => entry.candidate_total_result_bytes);
  const baselineSizes = entries.map((entry) => entry.baseline_total_result_bytes);
  return {
    entries,
    candidate_payload_delta_bytes: Math.max(...candidateSizes) - Math.min(...candidateSizes),
    baseline_payload_delta_bytes: Math.max(...baselineSizes) - Math.min(...baselineSizes)
  };
}

function reductionPercent(baselineBytes, candidateBytes) {
  return Number(((1 - candidateBytes / baselineBytes) * 100).toFixed(6));
}

export function verifyPayloadBenchmark(report, thresholds = PAYLOAD_CLAIM_THRESHOLDS) {
  const checks = [
    {
      id: "minimum_reduction_percent",
      passed: report.comparison.reduction_percent >= thresholds.minimumReductionPercent,
      actual: report.comparison.reduction_percent,
      expected: `>= ${thresholds.minimumReductionPercent}`
    },
    {
      id: "maximum_candidate_result_bytes",
      passed: report.candidate.maximum_single_result_bytes <= thresholds.maximumCandidateResultBytes,
      actual: report.candidate.maximum_single_result_bytes,
      expected: `<= ${thresholds.maximumCandidateResultBytes}`
    },
    {
      id: "maximum_candidate_scaling_delta_bytes",
      passed: report.scaling.candidate_payload_delta_bytes <= thresholds.maximumCandidateScalingDeltaBytes,
      actual: report.scaling.candidate_payload_delta_bytes,
      expected: `<= ${thresholds.maximumCandidateScalingDeltaBytes}`
    },
    {
      id: "candidate_has_no_inline_image_blocks",
      passed: report.candidate.inline_image_blocks === 0 && report.candidate.inline_image_base64_chars === 0,
      actual: report.candidate.inline_image_blocks,
      expected: "0"
    },
    {
      id: "no_external_calls",
      passed: report.execution.network_calls === 0 && report.execution.provider_calls === 0,
      actual: report.execution.network_calls + report.execution.provider_calls,
      expected: "0"
    }
  ];
  return {
    passed: checks.every((check) => check.passed),
    thresholds: {
      minimum_reduction_percent: thresholds.minimumReductionPercent,
      maximum_candidate_result_bytes: thresholds.maximumCandidateResultBytes,
      maximum_candidate_scaling_delta_bytes: thresholds.maximumCandidateScalingDeltaBytes
    },
    checks
  };
}

export function runPayloadBenchmark(options = {}) {
  const normalized = normalizeOptions(options);
  const scenario = runScenario(normalized);
  const report = {
    schema: "codex-image-context-payload-proxy-v1",
    benchmark: "serialized-mcp-result-payload-proxy",
    metric: "utf8_bytes_of_json_serialized_mcp_tool_results",
    options: {
      jobs: normalized.jobs,
      image_bytes_each: normalized.imageBytes,
      handoff_utf8_bytes: normalized.handoffBytes,
      seed: normalized.seed
    },
    execution: {
      synthetic_bytes_generated_in_memory: true,
      network_calls: 0,
      provider_calls: 0
    },
    artifact: scenario.artifact,
    baseline: scenario.baseline,
    candidate: scenario.candidate,
    comparison: {
      reduction_percent: reductionPercent(scenario.baseline.total_result_bytes, scenario.candidate.total_result_bytes),
      candidate_to_baseline_ratio: Number((scenario.candidate.total_result_bytes / scenario.baseline.total_result_bytes).toFixed(9))
    },
    scaling: runScalingSweep(normalized),
    limitations: [
      "This measures serialized MCP tool-result bytes, not Codex tokens, latency, memory, or responsiveness.",
      "The baseline is a deliberately naive inline-image MCP result, not Codex native image handling.",
      "The candidate is a self-contained reference-only transport model, not an integration test of the plugin runtime.",
      "Explicitly opening an image in Codex can still add visual context."
    ]
  };
  report.verification = verifyPayloadBenchmark(report);
  return report;
}

function parseCliArguments(argv) {
  const options = {};
  let json = false;
  let verify = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--verify") {
      verify = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    const match = argument.match(/^--(jobs|image-bytes|handoff-bytes|seed)(?:=(.+))?$/);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    const rawValue = match[2] ?? argv[++index];
    if (rawValue === undefined || !/^\d+$/.test(rawValue)) throw new Error(`--${match[1]} requires a non-negative integer`);
    const key = {
      jobs: "jobs",
      "image-bytes": "imageBytes",
      "handoff-bytes": "handoffBytes",
      seed: "seed"
    }[match[1]];
    options[key] = Number(rawValue);
  }
  return { options, json, verify, help };
}

function usage() {
  return `Synthetic MCP result payload proxy

Usage:
  node benchmark/context-payload.mjs [options]

Options:
  --jobs <n>             Synthetic image jobs (default: 20)
  --image-bytes <n>      Bytes per synthetic image (default: 1048576)
  --handoff-bytes <n>    UTF-8 bytes in each bounded handoff (default: 512)
  --seed <n>             Unsigned 32-bit deterministic seed (default: 20260811)
  --json                 Print the complete JSON report
  --verify               Exit non-zero when a conservative claim gate fails
  --help                 Show this help
`;
}

function humanReport(report) {
  const status = report.verification.passed ? "PASS" : "FAIL";
  return [
    "Synthetic MCP result payload proxy",
    "----------------------------------",
    `Jobs:                         ${report.options.jobs}`,
    `Synthetic image bytes each:  ${report.options.image_bytes_each}`,
    `Naive inline result bytes:    ${report.baseline.total_result_bytes}`,
    `Reference-only result bytes:  ${report.candidate.total_result_bytes}`,
    `Reduction:                    ${report.comparison.reduction_percent}%`,
    `Largest candidate result:     ${report.candidate.maximum_single_result_bytes} bytes`,
    `Candidate scaling delta:      ${report.scaling.candidate_payload_delta_bytes} bytes`,
    `Claim-gate verification:      ${status}`,
    "",
    "This is a deterministic serialized-payload proxy, not a Codex token, latency, memory, or responsiveness benchmark."
  ].join("\n");
}

async function main() {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    if (cli.help) {
      process.stdout.write(usage());
      return;
    }
    const report = runPayloadBenchmark(cli.options);
    process.stdout.write(`${cli.json ? JSON.stringify(report, null, 2) : humanReport(report)}\n`);
    if (cli.verify && !report.verification.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`context-payload benchmark failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
