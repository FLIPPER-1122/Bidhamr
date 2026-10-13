// Læser DAO-fixtures (egne eksempelsvar - se src/lib/fragt/__fixtures__/dao/README.md).
import { readFileSync } from "node:fs";
import path from "node:path";

const MAPPE = path.resolve(import.meta.dirname, "../../src/lib/fragt/__fixtures__/dao");

export function fixtureTekst(navn: string): string {
  return readFileSync(path.join(MAPPE, navn), "utf8");
}

export function fixture(navn: string): unknown {
  return JSON.parse(fixtureTekst(navn));
}

// Et fetch-svar som DAO's: HTTP 200 og JSON (også ved fejl).
export function jsonSvar(body: string | unknown, status = 200): Response {
  const tekst = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(tekst, { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function pdfSvar(): Response {
  const bytes = new TextEncoder().encode("%PDF-1.4\n% test-label\n%%EOF\n");
  return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
}
