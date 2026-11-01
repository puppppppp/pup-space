import fs from "fs";
import path from "path";
import { client, FALLBACK, knowledge, MODEL, textOf, workspacePath } from "./config.js";

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
1. คะแนนรวม เขียนในรูปแบบ "X/10" และสรุปสั้น
2. จุดแข็ง
3. จุดที่ต้องแก้ (เรียงตามความสำคัญ อ้างประโยค/ฉากที่เจาะจง)
4. ฮุก/จังหวะ/ความสม่ำเสมอของตัวละคร
5. ภาษาและคำผิด
6. สรุปเสียงคนอ่าน (ถ้ามีคอมเมนต์) - อะไรที่คนอ่านชอบ/บ่น
7. ข้อเสนอแนะสำหรับตอนต่อไป
If a trend report is provided, compare the chapter against what currently sells.`;

const FACT_CHECKER_SYSTEM = `You fact-check a chapter of a Thai BL novel before it is published.
List every real-world claim the story relies on: medical procedures and terms, university/medical-school customs, exam names and timing,
laws, real places, distances, dates, brands, cultural or religious practices.
Check each one against the reference sheet you are given and with web search. Prefer official or academic sources.
Ignore things that are clearly fictional choices (character names, invented events).
Answer in Thai as a table: ข้อความในเรื่อง | ถูก/ผิด/ไม่แน่ใจ | ข้อเท็จจริง + แหล่งที่มา | วิธีแก้ (ถ้าผิด).
Only include rows marked ผิด or ไม่แน่ใจ in detail; summarise the correct ones in one line.`;

const FINAL_EDITOR_SYSTEM = `You are the final copy editor for a Thai BL web novel, the last step before the chapter is posted on ReadAWrite.
You receive the chapter, a fact-check report, and the author's style guide. Do three things, in this order:

1. Fix facts: apply every correction marked ผิด in the fact-check report with the smallest change that keeps the scene working.
   For ไม่แน่ใจ items, soften or generalise the claim rather than invent detail.

2. Humanize the prose: remove signs of AI-generated writing so it reads like the author wrote it. Look for:
   - stock phrases and clichés repeated across the chapter (e.g. heart pounding "as if it would burst", breath "caught in the throat")
   - narration that explains feelings the scene already shows; summary or moral lines at the end of scenes
   - inflated significance ("a moment that would change everything"), promotional or flowery words with no concrete image
   - groups of three adjectives or beats used as a habit; "not X but Y" contrasts used as a habit
   - every paragraph or sentence the same length; dialogue that is too tidy, too formal, or sounds the same for every character
   - filler connectives and hedges that add nothing
   Keep the genre conventions the style guide asks for: epithets in place of names (ร่างโปร่ง, คนตัวสูง...), inner-voice one-liners,
   long flowing narration with short dialogue, em dashes for interrupted speech. These are the author's voice, not AI tells.
   Do not change the plot, the order of events, the rating, or what characters say they feel.

3. Proofread Thai: spelling and typos, ค่ะ/คะ and นะคะ, การันต์, ไม้ยมก, spacing, consistent names/nicknames/pronouns,
   consistent speech register per relationship, punctuation for dialogue.

Output exactly two parts:
<chapter>
the full corrected chapter in Markdown
</chapter>
<changes>
a short Thai changelog grouped as: แก้ข้อเท็จจริง / ปรับสำนวน (what AI-like patterns you removed) / พิสูจน์อักษร.
List anything you were unsure about and left for the author.
</changes>`;

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
  const context = [knowledge("style-guide.md"), readContext(contextFiles)].join("\n\n");
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    ...FALLBACK,
    output_config: { effort: "high" },
    system: WRITER_SYSTEM,
    messages: [{ role: "user", content: `${context}\n\n<brief>\n${brief}\n</brief>` }],
  });
  const chapter = textOf(await stream.finalMessage());
  saveFile(outputFile, chapter);
  return chapter;
}

function saveFile(file: string, content: string): void {
  const full = workspacePath(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function between(text: string, tag: string): string | undefined {
  return text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`))?.[1];
}

// Last step before publishing: fact check with web search, then a humanizer + proofreading pass.
export async function finalEditor(chapterFile: string, outputFile: string, contextFiles?: string[]): Promise<string> {
  const chapter = fs.readFileSync(workspacePath(chapterFile), "utf8");
  const chapterBlock = `<chapter file="${chapterFile}">\n${chapter}\n</chapter>`;

  const factReport = await runWebAgent(
    FACT_CHECKER_SYSTEM,
    [knowledge("med-school-th.md"), readContext(contextFiles), chapterBlock].filter(Boolean).join("\n\n"),
  );

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    ...FALLBACK,
    output_config: { effort: "high" },
    system: FINAL_EDITOR_SYSTEM,
    messages: [
      {
        role: "user",
        content: [knowledge("style-guide.md"), `<fact_check>\n${factReport}\n</fact_check>`, chapterBlock]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  const result = textOf(await stream.finalMessage());
  const edited = between(result, "chapter");
  if (!edited) return `Final edit failed, chapter not saved.\n\nFact check:\n${factReport}\n\nEditor output:\n${result.slice(0, 2000)}`;

  const changes = between(result, "changes") ?? "(no changelog)";
  const reportFile = outputFile.replace(/\.md$/, "") + ".report.md";
  saveFile(outputFile, edited);
  saveFile(reportFile, `# รายงานตรวจขั้นสุดท้าย: ${chapterFile}\n\n## Fact check\n\n${factReport}\n\n## การแก้ไข\n\n${changes}\n`);
  return `Saved ${outputFile} and ${reportFile}.\n\nFact check:\n${factReport}\n\nChanges:\n${changes}`;
}

export async function critic(chapterFile: string, readerFeedback?: string, contextFiles?: string[]): Promise<string> {
  const chapter = fs.readFileSync(workspacePath(chapterFile), "utf8");
  const parts = [
    knowledge("style-guide.md"),
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
