import fs from "fs";
import { client, FALLBACK, MODEL, textOf, workspacePath } from "./config.js";

const WEB_TOOLS = [
  { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 8 },
  { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 8 },
];

const TREND_SCOUT_SYSTEM = `You are a market analyst for Thai web novels, specialising in BL (นิยายวาย) on ReadAWrite (readawrite.com).
Use web search and fetch to study what is selling right now: ranking/bestseller pages, popular tags, recurring tropes and pairings,
title and blurb patterns, cover style, chapter length, update frequency, price per chapter/e-book, and how hooks are placed at chapter ends.
Also look at reader discussion (e.g. Pantip, X/Twitter, reviews) when it helps explain why a title sells.
Summarise patterns in your own words. Never copy passages of anyone's novel; quote at most a title or a short tag.
Cite the URLs you used. Answer in Thai, structured with headings and bullet points, and end with concrete recommendations for a new title.`;

const RESEARCHER_SYSTEM = `You are a research assistant for a Thai novelist.
Look up accurate background for the story: settings, professions, university life, medical/legal details, places, culture, slang, timelines.
Use web search and fetch, prefer reliable sources, and cite URLs. Flag anything uncertain.
Answer in Thai with short, practical notes the writer can use directly in scenes.`;

const WRITER_SYSTEM = `You are a professional Thai BL (นิยายวาย) novelist writing original fiction for ReadAWrite.
Write natural, vivid Thai prose with strong dialogue, emotional beats, and a hook at the end of every chapter.
Follow the brief exactly (characters, POV, tone, length, rating). Keep content within the rating given in the brief;
if no rating is given, keep romance non-explicit (fade to black).
Write only original material - never reproduce text from existing novels.
Output only the chapter itself in Markdown, starting with the chapter title as a heading.`;

const CRITIC_SYSTEM = `You are a sharp but constructive editor for Thai BL web novels on ReadAWrite.
Review the chapter you are given and, if provided, real reader comments.
Report in Thai with these sections:
1. คะแนนรวม (1-10) และสรุปสั้น
2. จุดแข็ง
3. จุดที่ต้องแก้ (เรียงตามความสำคัญ อ้างประโยค/ฉากที่เจาะจง)
4. ฮุก/จังหวะ/ความสม่ำเสมอของตัวละคร
5. ภาษาและคำผิด
6. สรุปเสียงคนอ่าน (ถ้ามีคอมเมนต์) - อะไรที่คนอ่านชอบ/บ่น
7. ข้อเสนอแนะสำหรับตอนต่อไป
If a trend report is provided, compare the chapter against what currently sells.`;

async function runWebAgent(system: string, task: string): Promise<string> {
  const message = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "medium" },
    system,
    tools: WEB_TOOLS,
    messages: [{ role: "user", content: task }],
    max_iterations: 20,
  });
  return textOf(message);
}

export function trendScout(question: string): Promise<string> {
  return runWebAgent(TREND_SCOUT_SYSTEM, question);
}

export function researcher(question: string): Promise<string> {
  return runWebAgent(RESEARCHER_SYSTEM, question);
}

function readContext(files: string[] | undefined): string {
  if (!files?.length) return "";
  return files
    .map((f) => `<file name="${f}">\n${fs.readFileSync(workspacePath(f), "utf8")}\n</file>`)
    .join("\n\n");
}

export async function writer(brief: string, outputFile: string, contextFiles?: string[]): Promise<string> {
  const context = readContext(contextFiles);
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    ...FALLBACK,
    output_config: { effort: "high" },
    system: WRITER_SYSTEM,
    messages: [{ role: "user", content: `${context}\n\n<brief>\n${brief}\n</brief>` }],
  });
  const chapter = textOf(await stream.finalMessage());
  fs.writeFileSync(workspacePath(outputFile), chapter);
  return chapter;
}

export async function critic(chapterFile: string, readerFeedback?: string, contextFiles?: string[]): Promise<string> {
  const chapter = fs.readFileSync(workspacePath(chapterFile), "utf8");
  const parts = [
    readContext(contextFiles),
    `<chapter file="${chapterFile}">\n${chapter}\n</chapter>`,
    readerFeedback ? `<reader_comments>\n${readerFeedback}\n</reader_comments>` : "",
  ];
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "high" },
    system: CRITIC_SYSTEM,
    messages: [{ role: "user", content: parts.filter(Boolean).join("\n\n") }],
  });
  return textOf(message);
}
