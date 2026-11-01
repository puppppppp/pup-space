import "dotenv/config";
import readline from "readline/promises";
import { WORKSPACE } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lead = new Orchestrator();

console.log(`📚 Novel Agent พร้อมแล้ว (ไฟล์งานอยู่ที่ ${WORKSPACE})`);
console.log('พิมพ์คำสั่งได้เลย เช่น "ศึกษานิยายวายขายดีใน ReadAWrite เดือนนี้" - พิมพ์ exit เพื่อออก\n');

while (true) {
  const input = (await rl.question("คุณ > ")).trim();
  if (!input) continue;
  if (input === "exit" || input === "quit") break;
  try {
    const reply = await lead.send(input, (name, args) => {
      const summary = JSON.stringify(args).slice(0, 120);
      console.log(`  ↳ ${name} ${summary}`);
    });
    console.log(`\nบอท > ${reply}\n`);
  } catch (error) {
    console.error("เกิดข้อผิดพลาด:", error instanceof Error ? error.message : error);
  }
}
rl.close();
