// Autopilot: keywords in -> plan -> one chapter at a time, waiting for the author's approval between chapters.
// Usage: npm run auto [-- project-name]
import "dotenv/config";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import fs from "fs";
import readline from "readline/promises";
import { z } from "zod";
import { client, FALLBACK, knowledge, MODEL, textOf, workspacePath } from "./config.js";
import { critic, finalEditor, researcher, trendScout, writer } from "./subagents.js";

const PlanSchema = z.object({
  title: z.string(),
  blurb: z.string().describe("One-sentence ReadAWrite blurb: setting -> painful choice -> hook"),
  tags: z.array(z.string()),
  rating: z.string().describe("e.g. ทั่วไป, 15+, 18+ (Party Room)"),
  pov: z.string(),
  setting: z.string(),
  characters: z.array(z.object({ name: z.string(), role: z.string(), description: z.string() })),
  chapters: z.array(
    z.object({ number: z.number(), title: z.string(), summary: z.string(), hook: z.string().describe("How the chapter ends") }),
  ),
});
type Plan = z.infer<typeof PlanSchema>;

type State = {
  keywords: string;
  plan?: Plan;
  planApproved: boolean;
  approved: number[];
  summaries: Record<number, string>;
};

const PLANNER_SYSTEM = `You plan original Thai BL (นิยายวาย) web novels for ReadAWrite.
From the author's keywords, the trend report and the research notes, design a story that fits what currently sells
while staying original. Write all fields in Thai. Give 20-30 chapters, each with a concrete summary and an end-of-chapter hook.
Use realistic details from the research. If the author gives feedback on a previous plan, apply it.`;

const project = process.argv[2] ?? "my-novel";
const dir = (file: string) => `${project}/${file}`;
const statePath = workspacePath(dir("project.json"));
const pad = (n: number) => String(n).padStart(2, "0");

function save(state: State) {
  fs.mkdirSync(workspacePath(project), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function write(file: string, content: string) {
  fs.writeFileSync(workspacePath(dir(file)), content);
}

function renderBible(plan: Plan): string {
  return [
    `# ${plan.title}`,
    `**คำโปรย:** ${plan.blurb}`,
    `**แท็ก:** ${plan.tags.join(", ")} · **เรต:** ${plan.rating} · **มุมมอง:** ${plan.pov}`,
    `## ฉาก\n${plan.setting}`,
    `## ตัวละคร\n${plan.characters.map((c) => `- **${c.name}** (${c.role}): ${c.description}`).join("\n")}`,
    `## โครงเรื่อง\n${plan.chapters.map((c) => `${c.number}. **${c.title}**: ${c.summary} _(ฮุก: ${c.hook})_`).join("\n")}`,
  ].join("\n\n");
}

async function makePlan(state: State, feedback?: string): Promise<Plan> {
  const trends = fs.readFileSync(workspacePath(dir("trends.md")), "utf8");
  const research = fs.readFileSync(workspacePath(dir("research.md")), "utf8");
  const previous = state.plan && feedback ? `<previous_plan>\n${renderBible(state.plan)}\n</previous_plan>\n<feedback>\n${feedback}\n</feedback>` : "";
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 32000,
    ...FALLBACK,
    output_config: { effort: "high", format: betaZodOutputFormat(PlanSchema) },
    system: PLANNER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          knowledge("style-guide.md"),
          `<trends>\n${trends}\n</trends>`,
          `<research>\n${research}\n</research>`,
          previous,
          `<keywords>\n${state.keywords}\n</keywords>`,
        ].join("\n\n"),
      },
    ],
  });
  if (!response.parsed_output) throw new Error(`Planner returned no plan: ${textOf(response)}`);
  return response.parsed_output;
}

function chapterBrief(plan: Plan, state: State, n: number, notes?: string): string {
  const ch = plan.chapters.find((c) => c.number === n)!;
  const storySoFar = Object.entries(state.summaries)
    .map(([k, v]) => `ตอน ${k}: ${v}`)
    .join("\n");
  return [
    `เขียนตอนที่ ${n}: ${ch.title}`,
    `เรื่องย่อตอนนี้: ${ch.summary}`,
    `ปิดตอนด้วยฮุก: ${ch.hook}`,
    `เรต: ${plan.rating} · มุมมอง: ${plan.pov} · ความยาวประมาณ 2,500-3,500 คำ`,
    storySoFar ? `เรื่องที่เกิดขึ้นแล้ว:\n${storySoFar}` : "นี่คือตอนแรกของเรื่อง",
    notes ? `สิ่งที่ต้องแก้/ทำเพิ่ม:\n${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function summarize(chapter: string): Promise<string> {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    output_config: { effort: "low" },
    system: "Summarise this Thai novel chapter in Thai in 3-5 sentences for continuity: key events, relationship changes, open threads.",
    messages: [{ role: "user", content: chapter }],
  });
  return textOf(response);
}

// Draft -> critique -> one revision if the score is low -> final edit.
async function produceChapter(plan: Plan, state: State, n: number, authorNotes?: string): Promise<string> {
  const draft = dir(`drafts/ch${pad(n)}.md`);
  const final = dir(`final/ch${pad(n)}.md`);
  const context = [dir("story-bible.md"), dir("research.md")];

  console.log(`  ✍️  writer: ตอน ${n}`);
  const previousFinal = authorNotes ? [final] : [];
  await writer(chapterBrief(plan, state, n, authorNotes), draft, [...context, ...previousFinal]);

  console.log("  🔍 critic");
  const review = await critic(draft, undefined, [dir("story-bible.md")]);
  write(`drafts/ch${pad(n)}.critique.md`, review);
  const score = Number(review.match(/(\d+(?:\.\d+)?)\s*\/\s*10/)?.[1] ?? 10);
  if (score < 8) {
    console.log(`  ✍️  writer: แก้ตามคำวิจารณ์ (คะแนน ${score}/10)`);
    await writer(chapterBrief(plan, state, n, `${authorNotes ?? ""}\n\nคำวิจารณ์จากบรรณาธิการ:\n${review}`), draft, [...context, draft]);
  }

  console.log("  🧹 final_editor: fact check + humanizer + พิสูจน์อักษร");
  await finalEditor(draft, final, [dir("story-bible.md")]);
  return final;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();

let state: State = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { keywords: "", planApproved: false, approved: [], summaries: {} };

if (!state.keywords) {
  state.keywords = await ask("คีย์เวิร์ดพล็อต (เช่น วาย มหาลัย นศ.แพทย์ คู่แข่ง ฟีลกู๊ด): ");
  save(state);
}
console.log(`📚 โปรเจกต์ "${project}" · ไฟล์อยู่ที่ workspace/${project}/`);

if (!fs.existsSync(workspacePath(dir("trends.md")))) {
  console.log("🔎 trend_scout + researcher กำลังค้นข้อมูล...");
  const [trends, research] = await Promise.all([
    trendScout(`ศึกษานิยายวายขายดีใน ReadAWrite ช่วงนี้ที่เกี่ยวกับ: ${state.keywords}`),
    researcher(`หาข้อมูลพื้นหลังที่ต้องใช้เขียนนิยายเรื่องนี้ให้สมจริง: ${state.keywords}`),
  ]);
  write("trends.md", trends);
  write("research.md", [research, knowledge("med-school-th.md")].join("\n\n"));
}

while (!state.planApproved) {
  if (!state.plan) {
    console.log("🗺️  กำลังวางโครงเรื่อง...");
    state.plan = await makePlan(state);
  }
  write("story-bible.md", renderBible(state.plan));
  save(state);
  console.log(`\n${renderBible(state.plan)}\n`);
  const answer = await ask("อนุมัติโครงเรื่องไหม? (a = อนุมัติ / พิมพ์สิ่งที่อยากแก้ / q = ออก): ");
  if (answer === "q") process.exit(0);
  if (answer === "a") state.planApproved = true;
  else state.plan = await makePlan(state, answer);
  save(state);
}

const plan = state.plan!;
for (const ch of plan.chapters) {
  if (state.approved.includes(ch.number)) continue;
  console.log(`\n📖 ตอนที่ ${ch.number}: ${ch.title}`);
  let notes: string | undefined;
  while (true) {
    const final = await produceChapter(plan, state, ch.number, notes);
    console.log(`\n✅ พร้อมให้ตรวจ: workspace/${final}`);
    console.log(`   รายงาน: workspace/${final.replace(/\.md$/, ".report.md")}`);
    const answer = await ask("อนุมัติตอนนี้ไหม? (a = อนุมัติแล้วเขียนตอนต่อไป / พิมพ์สิ่งที่อยากแก้ / q = พักไว้ก่อน): ");
    if (answer === "q") process.exit(0);
    if (answer === "a") {
      state.summaries[ch.number] = await summarize(fs.readFileSync(workspacePath(final), "utf8"));
      state.approved.push(ch.number);
      save(state);
      break;
    }
    notes = answer;
  }
}
console.log("🎉 เขียนครบทุกตอนแล้ว");
rl.close();
