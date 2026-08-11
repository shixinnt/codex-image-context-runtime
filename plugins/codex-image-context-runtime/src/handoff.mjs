import { MAX_INSPECTION_CHARS } from "./constants.mjs";
import { assertSafePublicText } from "./safety.mjs";

function artifactLines(job) {
  const receipt = job.artifact_receipts?.[0];
  if (!receipt) return ["- Artifact: none confirmed"];
  return [
    `- Artifact: ${receipt.path}`,
    `- SHA-256: ${receipt.sha256}`,
    `- Media type: ${receipt.media_type}`,
    `- Bytes: ${receipt.byte_size}`,
    `- Dimensions: ${receipt.dimensions.width} x ${receipt.dimensions.height}`
  ];
}

export function buildHandoff(job) {
  const lines = [
    `# Image Runtime Handoff — ${job.job_id}`,
    "",
    "This is a bounded text-only handoff. Media bytes remain in the local runtime or workspace.",
    "",
    "## Job",
    `- Status: ${job.status}`,
    `- Task: ${job.kind}`,
    `- Workspace ID: ${job.workspace_id}`,
    `- Provider state: ${job.provider_execution?.state ?? "not_started"}`,
    `- Updated: ${job.updated_at}`,
    "",
    "## Artifact receipt",
    ...artifactLines(job)
  ];
  if (job.kind === "inspection" && typeof job.inspection_text === "string") {
    const inspection = job.inspection_text.slice(0, MAX_INSPECTION_CHARS);
    assertSafePublicText(inspection, "inspection result");
    lines.push("", "## Inspection", inspection);
  }
  if (job.diagnostic) {
    lines.push("", "## Diagnostic", `- Code: ${job.diagnostic.code}`, `- Stage: ${job.diagnostic.stage}`);
  }
  if (job.status === "needs_review") {
    lines.push("", "## Recovery", "Provider dispatch may have occurred. Do not automatically repeat this request; inspect local evidence and create a new job only after deciding that duplicate cost or output is acceptable.");
  } else if (job.recovery?.retry_class === "safe_retry") {
    lines.push("", "## Recovery", "No Provider dispatch was recorded. This job may be resumed safely after correcting its local configuration.");
  }
  const text = `${lines.join("\n")}\n`;
  assertSafePublicText(text, "handoff");
  return text;
}
