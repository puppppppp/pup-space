// LINE bot: send plot keywords in LINE, get the plan and each chapter back, approve or request changes from the chat.
// Usage: npm run line   (needs LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_ALLOWED_USER_IDS, PUBLIC_URL)
import "dotenv/config";
import { messagingApi, middleware, webhook } from "@line/bot-sdk";
import express from "express";
import fs from "fs";
import { workspacePath } from "./config.js";
import { NovelProject } from "./pipeline.js";

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, PUBLIC_URL } = process.env;
if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !PUBLIC_URL) {
  throw new Error("Set LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN and PUBLIC_URL in .env");
}
// Only these LINE users can spend API credits. Unknown senders get their user ID back so the owner can add it.
const ALLOWED = new Set((process.env.LINE_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const line = new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN });
const busy = new Set<string>();

const APPROVE = ["อนุมัติ", "a", "ok", "โอเค"];
const READ_IN_CHAT = "อ่านในแชท";
const PAUSE = "พักไว้ก่อน";

const quickReply = (labels: string[]): messagingApi.QuickReply => ({
  items: labels.map((label) => ({ type: "action", action: { type: "message", label, text: label } })),
});

function textMessages(text: string, labels?: string[]): messagingApi.Message[] {
  // LINE allows 5,000 characters per text message.
  const chunks: string[] = [];
  for (let rest = text; rest.length; ) {
    const cut = rest.length <= 4800 ? rest.length : Math.max(rest.lastIndexOf("\n", 4800), 2000);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return chunks.map((chunk, i) => ({
    type: "text",
    text: chunk,
    ...(labels && i === chunks.length - 1 ? { quickReply: quickReply(labels) } : {}),
  }));
}

async function push(to: string, text: string, labels?: string[]) {
  const messages = textMessages(text, labels);
  for (let i = 0; i < messages.length; i += 5) {
    await line.pushMessage({ to, messages: messages.slice(i, i + 5) });
  }
}

function projectFor(userId: string) {
  return new NovelProject(`line-${userId}`);
}

function readUrl(project: NovelProject, file: string) {
  return `${PUBLIC_URL}/read/${project.state.shareToken}/${project.name}/${file}`;
}

async function sendPlan(userId: string, project: NovelProject) {
  const plan = project.state.plan!;
  await push(
    userId,
    [
      `📖 ${plan.title}`,
      `คำโปรย: ${plan.blurb}`,
      `แท็ก: ${plan.tags.join(", ")} · เรต: ${plan.rating}`,
      `ตัวละคร:\n${plan.characters.map((c) => `• ${c.name} (${c.role})`).join("\n")}`,
      `โครงเรื่อง ${plan.chapters.length} ตอน อ่านเต็ม ๆ ที่:\n${readUrl(project, "story-bible.md")}`,
      `กด "อนุมัติ" หรือพิมพ์สิ่งที่อยากแก้ได้เลย`,
    ].join("\n\n"),
    ["อนุมัติ"],
  );
}

function changesSummary(report: string): string {
  const changes = report.split("## การแก้ไข")[1]?.trim() ?? "";
  return changes.length > 1200 ? `${changes.slice(0, 1200)}…` : changes;
}

async function sendChapter(userId: string, project: NovelProject) {
  const n = project.state.current!;
  const ch = project.currentChapter!;
  const report = project.read(project.reportFile(n));
  await push(
    userId,
    [
      `✅ ตอนที่ ${n}: ${ch.title} พร้อมให้ตรวจ`,
      `คะแนนจาก critic: ${project.state.lastScore ?? "-"}/10`,
      `📄 อ่านตอนนี้: ${readUrl(project, project.finalFile(n))}`,
      `🧾 รายงาน fact check: ${readUrl(project, project.reportFile(n))}`,
      `สิ่งที่แก้ในรอบสุดท้าย:\n${changesSummary(report)}`,
      `กด "อนุมัติ" เพื่อเขียนตอนต่อไป หรือพิมพ์สิ่งที่อยากแก้`,
    ].join("\n\n"),
    ["อนุมัติ", READ_IN_CHAT, PAUSE],
  );
}

async function sendState(userId: string, project: NovelProject) {
  if (project.state.stage === "plan_review") return sendPlan(userId, project);
  if (project.state.stage === "chapter_review") return sendChapter(userId, project);
  if (project.state.stage === "done") return push(userId, `🎉 เขียนครบ ${project.state.approved.length} ตอนแล้ว\nเริ่มเรื่องใหม่: พิมพ์ "ใหม่ <คีย์เวิร์ด>"`);
}

// Long-running work runs in the background; progress and results are pushed when ready.
async function run(userId: string, project: NovelProject, job: (log: (m: string) => Promise<void>) => Promise<void>) {
  busy.add(userId);
  try {
    await job((message) => push(userId, message));
    await sendState(userId, project);
  } catch (error) {
    console.error(error);
    await push(userId, `❌ เกิดข้อผิดพลาด: ${error instanceof Error ? error.message : error}\nส่งข้อความเดิมอีกครั้งเพื่อลองใหม่`);
  } finally {
    busy.delete(userId);
  }
}

async function handleText(userId: string, replyToken: string, text: string) {
  const reply = (message: string, labels?: string[]) =>
    line.replyMessage({ replyToken, messages: textMessages(message, labels).slice(0, 5) });

  if (!ALLOWED.has(userId)) {
    console.log(`Message from unknown LINE user ${userId}`);
    return reply(`บอทนี้ยังไม่เปิดให้คุณใช้\nUser ID ของคุณคือ: ${userId}\nให้เจ้าของบอทเพิ่มไว้ใน LINE_ALLOWED_USER_IDS`);
  }
  if (busy.has(userId)) return reply("⏳ กำลังทำงานอยู่ เสร็จแล้วจะส่งให้ทันทีครับ");

  let project = projectFor(userId);
  const answer = text.trim();

  if (answer.startsWith("ใหม่ ") || answer.startsWith("new ")) {
    if (NovelProject.exists(project.name)) {
      fs.renameSync(workspacePath(project.name), workspacePath(`${project.name}-${Date.now()}`));
    }
    project = projectFor(userId);
    await reply("🚀 เริ่มเรื่องใหม่ เดี๋ยวส่งโครงเรื่องให้ดูครับ (ใช้เวลาหลายนาที)");
    return run(userId, project, (log) => project.start(answer.replace(/^(ใหม่|new)\s+/, ""), log));
  }

  switch (project.state.stage) {
    case "new":
      await reply(`🚀 รับคีย์เวิร์ด "${answer}" แล้ว เดี๋ยวส่งโครงเรื่องให้ดูครับ (ใช้เวลาหลายนาที)`);
      return run(userId, project, (log) => project.start(answer, log));

    case "plan_review":
      if (APPROVE.includes(answer.toLowerCase())) {
        await reply("👍 อนุมัติโครงเรื่องแล้ว กำลังเขียนตอนที่ 1");
        return run(userId, project, (log) => project.approvePlan(log));
      }
      if (answer === "สถานะ") return sendPlan(userId, project);
      await reply("✏️ รับคำแก้แล้ว กำลังวางโครงเรื่องใหม่");
      return run(userId, project, (log) => project.revisePlan(answer, log));

    case "chapter_review": {
      const n = project.state.current!;
      if (APPROVE.includes(answer.toLowerCase())) {
        await reply(`👍 อนุมัติตอนที่ ${n} แล้ว กำลังเขียนตอนต่อไป`);
        return run(userId, project, (log) => project.approveChapter(log));
      }
      if (answer === READ_IN_CHAT) {
        await reply(`📖 ตอนที่ ${n}`);
        return push(userId, project.read(project.finalFile(n)), ["อนุมัติ", PAUSE]);
      }
      if (answer === PAUSE) return reply(`⏸️ พักไว้ที่ตอนที่ ${n} ส่ง "อนุมัติ" หรือคำแก้มาเมื่อไหร่ก็ทำต่อได้เลย`);
      if (answer === "สถานะ") return sendChapter(userId, project);
      await reply(`✏️ รับคำแก้แล้ว กำลังเขียนตอนที่ ${n} ใหม่`);
      return run(userId, project, (log) => project.reviseChapter(answer, log));
    }

    case "done":
      return reply(`🎉 เรื่องนี้เขียนครบแล้ว\nเริ่มเรื่องใหม่: พิมพ์ "ใหม่ <คีย์เวิร์ด>"`);
  }
}

const app = express();

app.post("/webhook", middleware({ channelSecret: LINE_CHANNEL_SECRET }), (req, res) => {
  res.sendStatus(200);
  const body = req.body as webhook.CallbackRequest;
  for (const event of body.events) {
    if (event.type !== "message" || event.message.type !== "text" || !event.replyToken) continue;
    const userId = event.source?.userId;
    if (!userId) continue;
    handleText(userId, event.replyToken, (event.message as webhook.TextMessageContent).text).catch(console.error);
  }
});

// Mobile-friendly reader for chapters, reports and the story bible. The share token keeps it private.
app.get("/read/:token/:project/*file", (req, res) => {
  const { token, project } = req.params as { token: string; project: string };
  const file = ([] as string[]).concat((req.params as { file: string | string[] }).file).join("/");
  if (!NovelProject.exists(project)) return res.sendStatus(404);
  const novel = new NovelProject(project);
  if (token !== novel.state.shareToken || !file.endsWith(".md") || file.includes("..")) return res.sendStatus(404);
  let text: string;
  try {
    text = novel.read(file);
  } catch {
    return res.sendStatus(404);
  }
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.type("html").send(`<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${file}</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#222}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8}}
body{background:var(--bg);color:var(--fg);margin:0 auto;max-width:42rem;padding:24px 16px;
font:18px/1.9 "Sarabun","Noto Sans Thai",system-ui,sans-serif;white-space:pre-wrap;word-break:break-word}
</style></head><body>${escaped}</body></html>`);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`LINE bot listening on :${port} · webhook URL: ${PUBLIC_URL}/webhook`));
