// Admin → Konkurrence: beskeden til vinderen sendes, så snart databasen har
// trukket en vinder (også en ny vinder) - og kun da. Ingen vinder, en
// trækning, der allerede findes (dobbeltklik), eller en fejl: ingen besked.
// npm run test:enhed
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHEF = "00000000-0000-4000-8000-0000000000c0";
const T1 = "00000000-0000-4000-8000-000000000101";
let rpcSvar: { data: unknown; error: { message: string; code?: string } | null } = { data: null, error: null };

const admin = { rpc: vi.fn(async () => rpcSvar) };

vi.mock("@/lib/adminAuth", () => ({ assertRole: vi.fn(async () => ({ userId: CHEF, admin })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => "ny") }));
vi.mock("@/lib/konkurrence/vinderBesked", () => ({
  giVinderBesked: vi.fn(async () => ({ status: "sendt", samtaleId: "s", mail: true, klokke: true })),
}));

import { sendVinderBesked, traekNyVinder, traekVinder } from "@/app/actions/adminKonkurrence";
import { giVinderBesked } from "@/lib/konkurrence/vinderBesked";

function form(felter: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(felter)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.mocked(giVinderBesked).mockClear();
});

describe("træk vinder", () => {
  it("vinder trukket: vinderen får besked én gang", async () => {
    rpcSvar = { data: { kode: "ok", traekning_id: T1, vinder_id: "00000000-0000-4000-8000-000000000a01" }, error: null };
    expect(await traekVinder(form({ maaned: "2026-11" }))).toEqual({ ok: true });
    expect(giVinderBesked).toHaveBeenCalledTimes(1);
    expect(giVinderBesked).toHaveBeenCalledWith(admin, CHEF, T1);
  });

  it("ingen deltagere: ingen besked", async () => {
    rpcSvar = { data: { kode: "ingen_deltagere" }, error: null };
    expect(await traekVinder(form({ maaned: "2026-11" }))).toHaveProperty("fejl");
    expect(giVinderBesked).not.toHaveBeenCalled();
  });

  it("trækningen findes allerede (dobbeltklik): ingen ny besked", async () => {
    rpcSvar = { data: { kode: "findes", traekning_id: T1 }, error: null };
    await traekVinder(form({ maaned: "2026-11" }));
    expect(giVinderBesked).not.toHaveBeenCalled();
  });

  it("databasefejl: ingen besked", async () => {
    rpcSvar = { data: null, error: { message: "nede" } };
    expect(await traekVinder(form({ maaned: "2026-11" }))).toHaveProperty("fejl");
    expect(giVinderBesked).not.toHaveBeenCalled();
  });

  it("ny vinder: den nye vinder får besked", async () => {
    const T2 = "00000000-0000-4000-8000-000000000102";
    rpcSvar = { data: { kode: "ok", traekning_id: T2, vinder_id: "00000000-0000-4000-8000-000000000a02" }, error: null };
    expect(await traekNyVinder(form({ traekning: T1, grund: "opfylder_ikke" }))).toEqual({ ok: true });
    expect(giVinderBesked).toHaveBeenCalledWith(admin, CHEF, T2);
  });

  it("ny vinder findes allerede: ingen besked", async () => {
    rpcSvar = { data: { kode: "allerede_erstattet", traekning_id: T1 }, error: null };
    await traekNyVinder(form({ traekning: T1, grund: "opfylder_ikke" }));
    expect(giVinderBesked).not.toHaveBeenCalled();
  });

  it("send igen: dansk fejl, når vinderen allerede har fået besked", async () => {
    vi.mocked(giVinderBesked).mockResolvedValueOnce({ status: "allerede", samtaleId: "s" });
    expect(await sendVinderBesked(form({ traekning: T1 }))).toEqual({
      fejl: "Vinderen har allerede fået mailen og notifikationen.",
    });
  });
});
