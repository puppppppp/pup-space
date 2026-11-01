// Run the LINE bot on your own computer for free: opens a Cloudflare quick tunnel, then points LINE's webhook at it.
// Usage: npm run local   (needs `cloudflared` installed, e.g. `brew install cloudflared`, plus the LINE/Anthropic keys in .env)
import "dotenv/config";
import { messagingApi } from "@line/bot-sdk";
import { spawn } from "child_process";

const port = process.env.PORT ?? "3000";

// A quick tunnel needs no Cloudflare account, but its URL changes every time it starts.
function openTunnel(): Promise<string> {
  return new Promise((resolve, reject) => {
    const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("cloudflared did not print a tunnel URL within 60 seconds")), 60_000);
    const onData = (data: Buffer) => {
      const url = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    };
    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);
    tunnel.on("error", (error) =>
      reject(new Error(`Could not start cloudflared (${error.message}). Install it first: brew install cloudflared`)),
    );
    tunnel.on("exit", (code) => {
      console.error(`cloudflared exited (code ${code}); the bot is no longer reachable from LINE.`);
      process.exit(1);
    });
    process.on("exit", () => tunnel.kill());
    process.on("SIGINT", () => process.exit(0));
  });
}

const url = await openTunnel();
process.env.PUBLIC_URL = url;
await import("./line.js");

const line = new messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN! });
const endpoint = `${url}/webhook`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The tunnel's DNS name takes a few seconds to resolve, and LINE rejects (400) a webhook URL it cannot reach yet,
// so wait until LINE's test call succeeds before setting it.
let reachable = false;
for (let attempt = 1; attempt <= 12 && !reachable; attempt++) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const result = await line.testWebhookEndpoint({ endpoint });
    reachable = Boolean(result.success);
    if (!reachable && attempt === 12) console.log(`⚠️ LINE ยังเข้าไม่ถึง: ${result.reason || result.detail || "unknown"}`);
  } catch (error) {
    if (attempt === 12) console.log(`⚠️ ทดสอบ webhook ไม่ผ่าน: ${message(error)}`);
  }
}

let isSet = false;
for (let attempt = 1; attempt <= 3 && !isSet; attempt++) {
  try {
    await line.setWebhookEndpoint({ endpoint });
    isSet = true;
  } catch (error) {
    if (attempt === 3) console.log(`⚠️ ตั้ง Webhook อัตโนมัติไม่สำเร็จ (${message(error)})`);
    else await new Promise((r) => setTimeout(r, 5000));
  }
}
if (!isSet) {
  console.log(`   ไปตั้งเองใน LINE Developers Console → Messaging API → Webhook URL: ${endpoint}`);
} else {
  console.log(`✅ ตั้ง Webhook URL ใน LINE เป็น ${endpoint} ให้แล้ว (เปลี่ยนใหม่อัตโนมัติทุกครั้งที่รัน)`);
  const info = await line.getWebhookEndpoint().catch(() => undefined);
  if (info && !info.active) {
    console.log("⚠️ สวิตช์ Use webhook ยังปิดอยู่: เปิดใน LINE Developers Console → Messaging API → Use webhook");
  } else if (reachable) {
    console.log("✅ LINE ส่ง webhook มาถึงเครื่องนี้ได้แล้ว ทักบอทใน LINE ได้เลย");
  }
}
console.log("ปล่อยหน้าต่างนี้เปิดไว้ ปิดเมื่อไหร่บอทหยุดทำงาน (กด Ctrl+C เพื่อปิด)");
