import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// Adgang til /api/cron/*: "Authorization: Bearer <CRON_SECRET>".
// Sammenligningen er timing-sikker: begge sider hashes med sha256 (samme
// længde uanset input), og hashene sammenlignes med timingSafeEqual. Fail
// closed: uden en konfigureret hemmelighed afvises alt.
export function harCronAdgang(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const givet = req.headers.get("authorization") ?? "";
  const a = createHash("sha256").update(givet, "utf8").digest();
  const b = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return timingSafeEqual(a, b);
}
