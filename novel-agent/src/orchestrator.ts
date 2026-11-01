import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { client, FALLBACK, MODEL, WORKSPACE, textOf, workspacePath } from "./config.js";
import { critic, finalEditor, researcher, trendScout, writer } from "./subagents.js";

const SYSTEM = `You are the lead agent (บรรณาธิการบริหาร) of a small team that creates Thai BL novels (นิยายวาย) for ReadAWrite.
You talk with the author in Thai and delegate work to your subagents:
- trend_scout: studies what currently sells on ReadAWrite (tropes, tags, titles, pricing, hooks).
- researcher: looks up background facts for the story.
- writer: drafts a chapter from a detailed brief and saves it to a file.
- critic: reviews a saved chapter, optionally against real reader comments, and returns feedback.
- final_editor: the last step before publishing. Fact-checks the chapter with web search, removes AI-sounding wording
  (humanizer pass) and proofreads the Thai, then saves the final chapter plus a report.

How to work:
- Subagents see nothing of this conversation. Give each one a complete, self-contained brief.
- Save important results (trend reports, research notes, story bible, outlines, feedback) with save_file so later steps can pass them as context_files.
- A typical cycle is: trends -> concept & story bible -> research -> outline -> write chapter -> critique -> revise -> final_editor.
  Run final_editor once per chapter, after revisions are done, and save its output to a separate final/ file
  (e.g. chapters/ch01.md -> final/ch01.md). Tell the author about any fact marked ผิด or ไม่แน่ใจ.
- The writer, critic and final_editor already receive the style guide; the final_editor also receives the medical-school fact sheet.
  Skip steps the author doesn't need; do only what the author asked for in this turn.
- Independent subagent calls (e.g. trend_scout and researcher) can be made in parallel.
- When the critic finds major problems, you may ask the writer for one revision; tell the author what changed.
- Keep your replies short: what was done, the key findings, file names, and what you suggest next.
- Never ask the writer to copy existing novels.`;

const contextFiles = z
  .array(z.string())
  .optional()
  .describe("Workspace files to give the subagent as context, e.g. story bible, outline, trend report");

type ToolDef<S extends z.ZodObject> = {
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<string>;
};

function tool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<z.ZodObject> {
  return def as unknown as ToolDef<z.ZodObject>;
}

const TOOLS: Record<string, ToolDef<z.ZodObject>> = {
  trend_scout: tool({
    description: "Ask the trend-scout subagent to research bestselling BL on ReadAWrite. Returns a Thai report with sources.",
    schema: z.object({ question: z.string().describe("What to study, with any focus (trope, tag, price range...)") }),
    run: ({ question }) => trendScout(question),
  }),
  researcher: tool({
    description: "Ask the researcher subagent to look up background facts for the story. Returns Thai notes with sources.",
    schema: z.object({ question: z.string() }),
    run: ({ question }) => researcher(question),
  }),
  writer: tool({
    description: "Ask the writer subagent to draft or revise a chapter. The chapter is saved to output_file; returns its opening.",
    schema: z.object({
      brief: z.string().describe("Full brief: chapter goal, beats, POV, characters, tone, target length, rating, revision notes"),
      output_file: z.string().describe("Workspace path, e.g. chapters/ch01.md"),
      context_files: contextFiles,
    }),
    run: async ({ brief, output_file, context_files }) => {
      const chapter = await writer(brief, output_file, context_files);
      return `Saved ${output_file} (${chapter.length} characters). Opening:\n${chapter.slice(0, 1500)}`;
    },
  }),
  critic: tool({
    description: "Ask the critic subagent to review a saved chapter, optionally with reader comments pasted by the author.",
    schema: z.object({
      chapter_file: z.string(),
      reader_feedback: z.string().optional().describe("Real reader comments, if the author provided any"),
      context_files: contextFiles,
    }),
    run: ({ chapter_file, reader_feedback, context_files }) => critic(chapter_file, reader_feedback, context_files),
  }),
  final_editor: tool({
    description:
      "Final pass before publishing: fact check (web search), humanizer rewrite of AI-sounding wording, Thai proofreading. " +
      "Saves the final chapter to output_file and a report next to it; returns the fact check and changelog.",
    schema: z.object({
      chapter_file: z.string(),
      output_file: z.string().describe("Where to save the final chapter, e.g. final/ch01.md"),
      context_files: contextFiles,
    }),
    run: ({ chapter_file, output_file, context_files }) => finalEditor(chapter_file, output_file, context_files),
  }),
  save_file: tool({
    description: "Save text to a file in the workspace (creates folders).",
    schema: z.object({ path: z.string(), content: z.string() }),
    run: async ({ path: file, content }) => {
      const full = workspacePath(file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return `Saved ${file}`;
    },
  }),
  read_file: tool({
    description: "Read a file from the workspace.",
    schema: z.object({ path: z.string() }),
    run: async ({ path: file }) => fs.readFileSync(workspacePath(file), "utf8"),
  }),
  list_files: tool({
    description: "List all files in the workspace.",
    schema: z.object({}),
    run: async () => (fs.readdirSync(WORKSPACE, { recursive: true }) as string[]).join("\n") || "(empty)",
  }),
};

const TOOL_PARAMS: Anthropic.Beta.BetaTool[] = Object.entries(TOOLS).map(([name, def]) => {
  const { $schema, ...input_schema } = z.toJSONSchema(def.schema);
  return { name, description: def.description, input_schema: input_schema as Anthropic.Beta.BetaTool.InputSchema };
});

async function runTool(block: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const def = TOOLS[block.name];
  try {
    if (!def) throw new Error(`Unknown tool: ${block.name}`);
    const content = await def.run(def.schema.parse(block.input));
    return { type: "tool_result", tool_use_id: block.id, content };
  } catch (error) {
    return { type: "tool_result", tool_use_id: block.id, content: String(error), is_error: true };
  }
}

export class Orchestrator {
  private messages: Anthropic.Beta.BetaMessageParam[] = [];

  async send(userText: string, onTool?: (name: string, input: unknown) => void): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    for (let i = 0; i < 30; i++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        ...FALLBACK,
        output_config: { effort: "high" },
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools: TOOL_PARAMS,
        messages: this.messages,
      });
      this.messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") return textOf(response);

      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      calls.forEach((c) => onTool?.(c.name, c.input));
      // Subagents run in parallel; all results go back in one user message.
      const results = await Promise.all(calls.map(runTool));
      this.messages.push({ role: "user", content: results });
    }
    return "[stopped after 30 steps]";
  }
}
