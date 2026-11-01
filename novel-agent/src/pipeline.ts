// Novel production pipeline shared by the terminal autopilot (auto.ts) and the LINE bot (line.ts).
// keywords -> research -> plan (author approves) -> chapter by chapter (author approves each one).
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import crypto from "crypto";
import fs from "fs";
import path from "path";
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
export type Plan = z.infer<typeof PlanSchema>;

export type Stage = "new" | "plan_review" | "chapter_review" | "done";

type State = {
  keywords: string;
  stage: Stage;
  plan?: Plan;
  current?: number;
  lastScore?: number;
  approved: number[];
  summaries: Record<number, string>;
  shareToken: string;
};

export type Log = (message: string) => void | Promise<void>;

const PLANNER_SYSTEM = `You plan original Thai BL (นิยายวาย) web novels for ReadAWrite.
From the author's keywords, the trend report and the research notes, design a story that fits what currently sells
while staying original. Write all fields in Thai. Give 20-30 chapters, each with a concrete summary and an end-of-chapter hook.
Use realistic details from the research. If the author gives feedback on a previous plan, apply it.`;

const pad = (n: number) => String(n).padStart(2, "0");

export function renderBible(plan: Plan): string {
  return [
    `# ${plan.title}`,
    `**คำโปรย:** ${plan.blurb}`,
    `**แท็ก:** ${plan.tags.join(", ")} · **เรต:** ${plan.rating} · **มุมมอง:** ${plan.pov}`,
    `## ฉาก\n${plan.setting}`,
    `## ตัวละคร\n${plan.characters.map((c) => `- **${c.name}** (${c.role}): ${c.description}`).join("\n")}`,
    `## โครงเรื่อง\n${plan.chapters.map((c) => `${c.number}. **${c.title}**: ${c.summary} _(ฮุก: ${c.hook})_`).join("\n")}`,
  ].join("\n\n");
}

export class NovelProject {
  state: State;

  constructor(readonly name: string) {
    this.state = fs.existsSync(this.abs("project.json"))
      ? JSON.parse(fs.readFileSync(this.abs("project.json"), "utf8"))
      : { keywords: "", stage: "new", approved: [], summaries: {}, shareToken: crypto.randomBytes(12).toString("hex") };
  }

  static exists(name: string): boolean {
    return fs.existsSync(workspacePath(`${name}/project.json`));
  }

  /** Workspace-relative path of a project file. */
  rel(file: string): string {
    return `${this.name}/${file}`;
  }

  abs(file: string): string {
    return workspacePath(this.rel(file));
  }

  read(file: string): string {
    return fs.readFileSync(this.abs(file), "utf8");
  }

  private write(file: string, content: string) {
    fs.mkdirSync(path.dirname(this.abs(file)), { recursive: true });
    fs.writeFileSync(this.abs(file), content);
  }

  private save() {
    this.write("project.json", JSON.stringify(this.state, null, 2));
  }

  finalFile(n: number) {
    return `final/ch${pad(n)}.md`;
  }

  reportFile(n: number) {
    return `final/ch${pad(n)}.report.md`;
  }

  get currentChapter() {
    return this.state.plan?.chapters.find((c) => c.number === this.state.current);
  }

  async start(keywords: string, log: Log) {
    this.state.keywords = keywords;
    this.save();
    await log("🔎 กำลังค้นเทรนด์ ReadAWrite และข้อมูลพื้นหลัง...");
    const [trends, research] = await Promise.all([
      trendScout(`ศึกษานิยายวายขายดีใน ReadAWrite ช่วงนี้ที่เกี่ยวกับ: ${keywords}`),
      researcher(`หาข้อมูลพื้นหลังที่ต้องใช้เขียนนิยายเรื่องนี้ให้สมจริง: ${keywords}`),
    ]);
    this.write("trends.md", trends);
    this.write("research.md", [research, knowledge("med-school-th.md")].filter(Boolean).join("\n\n"));
    await this.makePlan(log);
  }

  async revisePlan(feedback: string, log: Log) {
    await this.makePlan(log, feedback);
  }

  private async makePlan(log: Log, feedback?: string) {
    await log("🗺️ กำลังวางโครงเรื่อง...");
    const previous =
      this.state.plan && feedback
        ? `<previous_plan>\n${renderBible(this.state.plan)}\n</previous_plan>\n<feedback>\n${feedback}\n</feedback>`
        : "";
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
            `<trends>\n${this.read("trends.md")}\n</trends>`,
            `<research>\n${this.read("research.md")}\n</research>`,
            previous,
            `<keywords>\n${this.state.keywords}\n</keywords>`,
          ].join("\n\n"),
        },
      ],
    });
    if (!response.parsed_output) throw new Error(`Planner returned no plan: ${textOf(response)}`);
    this.state.plan = response.parsed_output;
    this.state.stage = "plan_review";
    this.write("story-bible.md", renderBible(this.state.plan));
    this.save();
  }

  async approvePlan(log: Log) {
    await this.nextChapter(log);
  }

  async approveChapter(log: Log) {
    const n = this.state.current!;
    await log(`📝 สรุปตอน ${n} ไว้ส่งต่อให้ตอนถัดไป...`);
    this.state.summaries[n] = await summarize(this.read(this.finalFile(n)));
    this.state.approved.push(n);
    this.save();
    await this.nextChapter(log);
  }

  async reviseChapter(feedback: string, log: Log) {
    await this.produceChapter(this.state.current!, log, feedback);
  }

  private async nextChapter(log: Log) {
    const next = this.state.plan!.chapters.find((c) => !this.state.approved.includes(c.number));
    if (!next) {
      this.state.stage = "done";
      this.save();
      return;
    }
    await this.produceChapter(next.number, log);
  }

  // Draft -> critique -> one revision if the score is low -> final edit.
  private async produceChapter(n: number, log: Log, authorNotes?: string) {
    this.state.current = n;
    this.save();
    const draft = this.rel(`drafts/ch${pad(n)}.md`);
    const final = this.rel(this.finalFile(n));
    const bible = this.rel("story-bible.md");
    const context = [bible, this.rel("research.md")];

    await log(`✍️ กำลังเขียนตอนที่ ${n}...`);
    const previousFinal = authorNotes ? [final] : [];
    await writer(this.brief(n, authorNotes), draft, [...context, ...previousFinal]);

    await log("🔍 critic กำลังตรวจ...");
    const review = await critic(draft, undefined, [bible]);
    this.write(`drafts/ch${pad(n)}.critique.md`, review);
    const score = Number(review.match(/(\d+(?:\.\d+)?)\s*\/\s*10/)?.[1] ?? 10);
    if (score < 8) {
      await log(`✍️ ได้ ${score}/10 กำลังแก้ตามคำวิจารณ์...`);
      await writer(this.brief(n, `${authorNotes ?? ""}\n\nคำวิจารณ์จากบรรณาธิการ:\n${review}`), draft, [...context, draft]);
    }

    await log("🧹 final_editor: fact check + humanizer + พิสูจน์อักษร...");
    await finalEditor(draft, final, [bible]);
    this.state.lastScore = score;
    this.state.stage = "chapter_review";
    this.save();
  }

  private brief(n: number, notes?: string): string {
    const plan = this.state.plan!;
    const ch = plan.chapters.find((c) => c.number === n)!;
    const storySoFar = Object.entries(this.state.summaries)
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
