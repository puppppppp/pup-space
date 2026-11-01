// Autopilot in the terminal: keywords in -> plan -> one chapter at a time, waiting for approval between chapters.
// Usage: npm run auto [-- project-name]
import "dotenv/config";
import readline from "readline/promises";
import { NovelProject, renderBible } from "./pipeline.js";

const project = new NovelProject(process.argv[2] ?? "my-novel");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();
const log = (message: string) => console.log(`  ${message}`);

console.log(`📚 โปรเจกต์ "${project.name}" · ไฟล์อยู่ที่ workspace/${project.name}/`);
if (project.state.stage === "new") {
  await project.start(await ask("คีย์เวิร์ดพล็อต (เช่น วาย มหาลัย นศ.แพทย์ คู่แข่ง ฟีลกู๊ด): "), log);
}

while (project.state.stage !== "done") {
  if (project.state.stage === "plan_review") {
    console.log(`\n${renderBible(project.state.plan!)}\n`);
    const answer = await ask("อนุมัติโครงเรื่องไหม? (a = อนุมัติ / พิมพ์สิ่งที่อยากแก้ / q = ออก): ");
    if (answer === "q") break;
    if (answer === "a") await project.approvePlan(log);
    else await project.revisePlan(answer, log);
  } else {
    const n = project.state.current!;
    console.log(`\n✅ ตอนที่ ${n} พร้อมให้ตรวจ: workspace/${project.rel(project.finalFile(n))}`);
    console.log(`   รายงาน: workspace/${project.rel(project.reportFile(n))}`);
    const answer = await ask("อนุมัติตอนนี้ไหม? (a = อนุมัติแล้วเขียนตอนต่อไป / พิมพ์สิ่งที่อยากแก้ / q = พักไว้ก่อน): ");
    if (answer === "q") break;
    if (answer === "a") await project.approveChapter(log);
    else await project.reviseChapter(answer, log);
  }
}
if (project.state.stage === "done") console.log("🎉 เขียนครบทุกตอนแล้ว");
rl.close();
