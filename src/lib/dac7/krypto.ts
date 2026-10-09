import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Kryptering af skatte-id (CPR/TIN) til DAC7. AES-256-GCM med nøglen
// DAC7_KRYPTERINGSNOEGLE (32 bytes, base64url), som KUN findes på serveren
// (.env.local / Vercel) - aldrig i databasen. Databasen gemmer kun
// "v1.<iv>.<tag>.<data>" og kan ikke dekryptere.
//
// Hver værdi er bundet til brugeren og feltet (AAD = "<bruger_id>:<felt>"),
// så en krypteret værdi ikke kan flyttes til en anden bruger eller et andet
// felt i databasen og stadig dekrypteres.
//
// Fail closed: mangler nøglen, kan der hverken gemmes eller læses skatte-id.
// Nøglen må ALDRIG skiftes eller mistes, så længe der er krypterede værdier
// (de kan så ikke læses igen) - se docs/DAC7.md.

export type Felt = "cpr" | "andet_tin";

function noegle(): Buffer | null {
  const raa = process.env.DAC7_KRYPTERINGSNOEGLE ?? "";
  if (!raa) return null;
  try {
    const b = Buffer.from(raa, "base64url");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export function krypteringKlar(): boolean {
  return noegle() !== null;
}

function aad(brugerId: string, felt: Felt): Buffer {
  return Buffer.from(`${brugerId.toLowerCase()}:${felt}`, "utf8");
}

export function krypter(tekst: string, brugerId: string, felt: Felt): string {
  const k = noegle();
  if (!k) throw new Error("DAC7_KRYPTERINGSNOEGLE mangler eller er ugyldig");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(aad(brugerId, felt));
  const data = Buffer.concat([c.update(tekst, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
}

// null, hvis værdien mangler, nøglen mangler, eller værdien ikke kan
// dekrypteres (forkert nøgle, ændret værdi eller anden bruger). Kaster aldrig,
// og fejlen logges uden indhold.
export function dekrypter(vaerdi: string | null | undefined, brugerId: string, felt: Felt): string | null {
  if (!vaerdi) return null;
  const k = noegle();
  if (!k) return null;
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(vaerdi);
  if (!m) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(m[1], "base64url"));
    d.setAAD(aad(brugerId, felt));
    d.setAuthTag(Buffer.from(m[2], "base64url"));
    return Buffer.concat([d.update(Buffer.from(m[3], "base64url")), d.final()]).toString("utf8");
  } catch {
    console.error("DAC7: en krypteret værdi kunne ikke dekrypteres (forkert nøgle eller ændret værdi).");
    return null;
  }
}
