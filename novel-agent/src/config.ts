import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const client = new Anthropic();

export const MODEL = process.env.NOVEL_AGENT_MODEL ?? "claude-opus-5-5";

// Refusal fallback: if a request is declined by a safety classifier, the API
// re-runs it on a fallback model chosen by refusal category.
export const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

// Every file the agents read or write lives under this folder.
export const WORKSPACE = path.resolve(process.env.NOVEL_WORKSPACE ?? "workspace");
fs.mkdirSync(WORKSPACE, { recursive: true });

export function workspacePath(relative: string): string {
  const full = path.resolve(WORKSPACE, relative);
  if (full !== WORKSPACE && !full.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Path escapes workspace: ${relative}`);
  }
  return full;
}

// Reference notes checked into the repo (style guide, research sheets).
const KNOWLEDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../knowledge");

export function knowledge(file: string): string {
  const full = path.join(KNOWLEDGE, file);
  if (!fs.existsSync(full)) return "";
  return `<reference name="${file}">\n${fs.readFileSync(full, "utf8")}\n</reference>`;
}

export function textOf(message: Anthropic.Beta.BetaMessage): string {
  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation ?? "no explanation";
    return `[refused: ${why}]`;
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (message.stop_reason === "max_tokens") return `${text}\n\n[cut off at max_tokens]`;
  return text;
}
