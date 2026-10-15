// Besked til vinderen af den månedlige lodtrækning (Filip, 15. okt. 2026):
// src/lib/konkurrence/vinderBesked.ts med en falsk database og en falsk
// send(), der claimer nøglen som notifikation_afsendelser.
// - præcis én samtale, én notifikation og én mail pr. trækning
// - ingen besked uden vinder eller til en erstattet vinder
// - teksterne nævner svarfristen på 14 dage og linket til samtalen
// npm run test:enhed
import { beforeEach, describe, expect, it, vi } from "vitest";

type SendKald = { brugerId: string; type: string; input: Record<string, unknown>; opts: Record<string, unknown> };
const sendKald: SendKald[] = [];
const claimede = new Set<string>();

vi.mock("@/lib/notifikationer/send", () => ({
  send: vi.fn(async (brugerId: string, type: string, input: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
    const noegle = String(input.noegle ?? "");
    if (noegle && claimede.has(noegle)) return { klokke: false, mail: false, push: false, dublet: true };
    if (noegle) claimede.add(noegle);
    sendKald.push({ brugerId, type, input, opts });
    return { klokke: true, mail: true, push: false };
  }),
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => "ny") }));

import { giVinderBesked, svarfrist, vinderMailStatus, vinderSamtale } from "@/lib/konkurrence/vinderBesked";
import { mailTidspunkt } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";

const CHEF = "00000000-0000-4000-8000-0000000000c0";
const VINDER = "00000000-0000-4000-8000-000000000a01";
const T1 = "00000000-0000-4000-8000-000000000101";
const TRUKKET = "2026-12-03T13:03:00Z";

type Traekning = { id: string; maaned: string; vinder_id: string | null; trukket_kl: string; erstattet_kl: string | null };
let traekninger: Traekning[] = [];
let samtaler: { id: string; sag_type: string; sag_id: string; bruger_id: string; besked: string }[] = [];
let aabnKald = 0;
let aabnFejler = false;
// Et samtidigt kald har vundet på det unikke indeks: staff_chat_aabn svarer 'findes'.
let andetKaldVandt = false;
let afsendelser: { noegle: string; status: string; kanaler: Record<string, string> }[] = [];

function kaede(tabel: string) {
  const filtre: [string, unknown][] = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.order = () => q;
  q.limit = () => q;
  q.eq = (k: string, v: unknown) => {
    filtre.push([k, v]);
    return q;
  };
  q.in = (k: string, v: unknown[]) => {
    const data = afsendelser.filter((a) => v.includes((a as Record<string, unknown>)[k]));
    return Promise.resolve({ data, error: null });
  };
  q.maybeSingle = async () => {
    const kilde: Record<string, unknown>[] = tabel === "konkurrence_traekninger" ? traekninger : tabel === "staff_samtaler" ? samtaler : [];
    const r = kilde.find((x) => filtre.every(([k, v]) => x[k] === v));
    return { data: r ?? null, error: null };
  };
  return q;
}

const admin = {
  from: (tabel: string) => kaede(tabel),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === "staff_chat_send") {
      const s = samtaler.find((x) => x.id === args.p_samtale);
      if (!s) return { data: { kode: "ikke_fundet" }, error: null };
      s.besked += String(args.p_tekst);
      return { data: { kode: "ok", besked_id: "b1" }, error: null };
    }
    if (fn !== "staff_chat_aabn") return { data: null, error: { message: `ukendt ${fn}` } };
    aabnKald += 1;
    // Beskeden må aldrig sendes med, når samtalen åbnes (findes-grenen ville sende igen).
    expect(args.p_besked).toBeNull();
    if (aabnFejler) return { data: { kode: "ugyldig_bruger" }, error: null };
    const id = `00000000-0000-4000-8000-00000000c${String(aabnKald).padStart(3, "0")}`;
    if (andetKaldVandt) return { data: { kode: "findes", samtale_id: id }, error: null };
    samtaler.push({
      id,
      sag_type: String(args.p_sag_type),
      sag_id: String(args.p_sag_id),
      bruger_id: String(args.p_bruger),
      besked: "",
    });
    return { data: { kode: "ok", samtale_id: id }, error: null };
  },
} as never;

beforeEach(() => {
  sendKald.length = 0;
  claimede.clear();
  traekninger = [{ id: T1, maaned: "2026-11", vinder_id: VINDER, trukket_kl: TRUKKET, erstattet_kl: null }];
  samtaler = [];
  aabnKald = 0;
  aabnFejler = false;
  andetKaldVandt = false;
  afsendelser = [];
  vi.mocked(logDriftFejl).mockClear();
});

const frist = mailTidspunkt(svarfrist(TRUKKET));

describe("besked til vinderen", () => {
  it("svarfristen er 14 dage efter trækningen", () => {
    expect(svarfrist(TRUKKET).toISOString()).toBe("2026-12-17T13:03:00.000Z");
    expect(frist).toContain("17. december 2026");
  });

  it("vinderen får én samtale, én notifikation og én mail med frist og link", async () => {
    const r = await giVinderBesked(admin, CHEF, T1);
    expect(r).toMatchObject({ status: "sendt", mail: true });
    expect(samtaler).toHaveLength(1);
    const s = samtaler[0];
    expect(s).toMatchObject({ sag_type: "konkurrence", sag_id: T1, bruger_id: VINDER });
    expect(s.besked).toContain(frist);
    expect(s.besked).toContain("14 dage");
    expect(s.besked).toContain("november 2026");
    // Konkurrencebetingelserne 8.1 og 7.1.
    expect(s.besked).toContain("fornavn og din by");
    expect(s.besked).toContain("adgangskode");

    expect(sendKald).toHaveLength(1);
    const k = sendKald[0];
    expect(k.brugerId).toBe(VINDER);
    expect(k.type).toBe("sag");
    expect(k.opts).toEqual({ altidMail: true });
    expect(k.input.noegle).toBe(`konkurrence_vinder:${T1}`);
    expect(k.input.link).toBe(`/beskeder/bidhamr/${s.id}`);
    expect(String(k.input.tekst)).toContain(frist);
    // Notifikationens data må kun have id'er, vinderen selv har adgang til.
    expect(k.input.data).toEqual({ staff_samtale_id: s.id });

    const mail = k.input.mail as { subject: string; html: string; text: string };
    expect(mail.subject).toBe("Du har vundet månedens gavekort på BidHamr");
    expect(mail.html).toContain(`/beskeder/bidhamr/${s.id}`);
    expect(mail.html).toContain("14 dage");
    expect(mail.text).toContain(frist);
    expect(mail.text).toContain("Svar på beskeden");
    for (const tekst of [mail.html, mail.text, s.besked, String(k.input.tekst)]) {
      expect(tekst.toLowerCase()).not.toContain("forsikring");
    }
  });

  it("idempotent: kaldt igen sendes intet nyt (samme samtale, ingen ny mail)", async () => {
    await giVinderBesked(admin, CHEF, T1);
    const igen = await giVinderBesked(admin, CHEF, T1);
    expect(igen).toEqual({ status: "allerede", samtaleId: samtaler[0].id });
    expect(aabnKald).toBe(1);
    expect(samtaler).toHaveLength(1);
    expect(sendKald).toHaveLength(1);
  });

  it("ingen vinder (ingen trækning) eller en erstattet vinder: intet sendes", async () => {
    expect(await giVinderBesked(admin, CHEF, "00000000-0000-4000-8000-000000000999")).toEqual({ status: "ingen_vinder" });
    traekninger[0].erstattet_kl = "2026-12-20T10:00:00Z";
    expect(await giVinderBesked(admin, CHEF, T1)).toEqual({ status: "ingen_vinder" });
    expect(aabnKald).toBe(0);
    expect(sendKald).toHaveLength(0);
  });

  it("kan samtalen ikke åbnes, får vinderen stadig mail og notifikation (svar via support)", async () => {
    aabnFejler = true;
    const r = await giVinderBesked(admin, CHEF, T1);
    expect(r).toMatchObject({ status: "sendt", samtaleId: null });
    expect(logDriftFejl).toHaveBeenCalled();
    const k = sendKald[0];
    expect(k.input.link).toBe("/kontakt");
    expect(String(k.input.tekst)).toContain("support@bidhamr.dk");
    const mail = k.input.mail as { html: string; text: string };
    expect(mail.text).toContain("support@bidhamr.dk");
    expect(mail.text).toContain("Kontakt BidHamr");
  });

  it("vinderSamtale finder samtalen om trækningen", async () => {
    expect(await vinderSamtale(admin, T1)).toBeNull();
    await giVinderBesked(admin, CHEF, T1);
    expect(await vinderSamtale(admin, T1)).toBe(samtaler[0].id);
  });

  it("samtidigt kald: den, der taber på det unikke indeks ('findes'), skriver ikke beskeden", async () => {
    andetKaldVandt = true;
    claimede.add(`konkurrence_vinder:${T1}`); // det andet kald har sendt notifikationen
    const r = await giVinderBesked(admin, CHEF, T1);
    expect(r.status).toBe("allerede");
    expect(samtaler).toHaveLength(0); // ingen staff_chat_send
    expect(sendKald).toHaveLength(0);
  });

  it("send igen efter fejl: samtalen åbnes nu, svaret er sendt, og vinderen får besked om samtalen med egen nøgle", async () => {
    aabnFejler = true;
    await giVinderBesked(admin, CHEF, T1);
    expect(sendKald).toHaveLength(1);
    aabnFejler = false;
    const r = await giVinderBesked(admin, CHEF, T1);
    expect(r).toMatchObject({ status: "sendt" });
    expect(samtaler).toHaveLength(1);
    expect(samtaler[0].besked).toContain(frist);
    expect(sendKald).toHaveLength(2);
    expect(sendKald[1].input.noegle).toBe(`konkurrence_vinder_chat:${samtaler[0].id}`);
    expect(sendKald[1].input.link).toBe(`/beskeder/bidhamr/${samtaler[0].id}`);
    // Tredje gang: intet nyt.
    expect((await giVinderBesked(admin, CHEF, T1)).status).toBe("allerede");
    expect(sendKald).toHaveLength(2);
  });

  it("mailens status læses fra notifikation_afsendelser", async () => {
    expect(await vinderMailStatus(admin, T1, null)).toBe("ikke_sendt");
    afsendelser = [{ noegle: `konkurrence_vinder:${T1}`, status: "claimet", kanaler: {} }];
    expect(await vinderMailStatus(admin, T1, null)).toBe("i_gang");
    afsendelser = [{ noegle: `konkurrence_vinder:${T1}`, status: "delvis", kanaler: { klokke: "sendt", mail: "fejl" } }];
    expect(await vinderMailStatus(admin, T1, null)).toBe("fejl");
    afsendelser.push({ noegle: "konkurrence_vinder_chat:S1", status: "sendt", kanaler: { mail: "sendt" } });
    expect(await vinderMailStatus(admin, T1, null)).toBe("fejl");
    expect(await vinderMailStatus(admin, T1, "S1")).toBe("sendt");
  });
});
