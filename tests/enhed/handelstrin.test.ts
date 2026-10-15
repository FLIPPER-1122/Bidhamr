// De fælles handelstrin (src/lib/handel/handelstrin.ts), som både
// hjemmesidens server actions og appens /api/handel/app bruger: RPC'en kaldes
// som brugeren, og bagefter sendes de samme beskeder, og udbetalingen
// startes - præcis som før flytningen fra src/app/actions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { falskKlient } from "./hjaelpere/falskSupabase";

const SAELGER = "11111111-1111-4111-8111-111111111111";
const KOEBER = "22222222-2222-4222-8222-222222222222";
const HANDEL = "44444444-4444-4444-8444-444444444444";
const AUKTION = "55555555-5555-4555-8555-555555555555";

const m = vi.hoisted(() => ({
  send: vi.fn(async () => {}),
  sendSaelgerAfregning: vi.fn(async () => {}),
  sendKoeberAfsluttet: vi.fn(async () => {}),
  hentBetalingForHandel: vi.fn(),
  indsigelseBlokerer: vi.fn(() => false),
  pengeTilSaelger: vi.fn(async () => ({ status: "sendt" })),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/notifikationer/send", () => ({ send: m.send }));
vi.mock("@/lib/mails/handel", () => ({ pakkeSendtMail: () => ({ subject: "s", html: "h", text: "t" }) }));
vi.mock("@/lib/betaling/handelsbeskeder", () => ({
  sendSaelgerAfregning: m.sendSaelgerAfregning,
  sendKoeberAfsluttet: m.sendKoeberAfsluttet,
}));
vi.mock("@/lib/betaling/stripeBetaling", () => ({
  hentBetalingForHandel: m.hentBetalingForHandel,
  indsigelseBlokerer: m.indsigelseBlokerer,
}));
vi.mock("@/lib/betaling/udbetaling", () => ({
  pengeTilSaelger: m.pengeTilSaelger,
  erSendtTilSaelger: () => true,
}));

const { sendPakkeFor, markerModtagetFor, godkendPakkeFor, bekraeftAfhentningFor } = await import("@/lib/handel/handelstrin");

let handel: Record<string, unknown> | null;
function klient(rpcSvar: Record<string, { data: unknown; error: { message: string } | null }>) {
  return falskKlient(
    (q) => {
      if (q.tabel === "trades") return { data: handel, error: null };
      if (q.tabel === "auctions") return { data: { titel: "Cykel" }, error: null };
      return undefined;
    },
    (navn) => rpcSvar[navn] ?? { data: null, error: null },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  handel = { id: HANDEL, auction_id: AUKTION, seller_id: SAELGER, buyer_id: KOEBER, status: "betaling_modtaget", afhentning: false };
  m.hentBetalingForHandel.mockResolvedValue({ id: "betaling-1" });
});

const billeder = [
  { sti: `${SAELGER}/${HANDEL}/a.jpg`, kategori: "aaben_kasse" },
  { sti: `${SAELGER}/${HANDEL}/b.jpg`, kategori: "lukket_kasse" },
];

describe("sendPakkeFor", () => {
  it("kalder trade_marker_sendt som sælgeren og sender 'Din pakke er på vej' til køberen", async () => {
    const k = klient({ trade_marker_sendt: { data: { kode: "ok" }, error: null } });
    const r = await sendPakkeFor(k.klient as never, SAELGER, HANDEL, " 123-456 ", billeder);
    expect(r).toEqual({ ok: true });
    expect(k.rpcLog).toEqual([{ navn: "trade_marker_sendt", args: { p_trade: HANDEL, p_tracking: "123-456", p_billeder: billeder } }]);
    expect(m.send).toHaveBeenCalledWith(KOEBER, "pakke_sendt", expect.objectContaining({ titel: "Din pakke er på vej", noegle: `pakke_sendt:${HANDEL}` }));
    // Handlen hentes med partsfilter.
    const t = k.log.find((q) => q.tabel === "trades")!;
    expect(t.filtre).toContainEqual(["or", `buyer_id.eq.${SAELGER},seller_id.eq.${SAELGER}`]);
  });

  it("databasens kode sendes videre; ingen besked", async () => {
    const k = klient({ trade_marker_sendt: { data: { kode: "billede_mangler" }, error: null } });
    const r = await sendPakkeFor(k.klient as never, SAELGER, HANDEL, "1", billeder);
    expect(r).toEqual({ fejl: "Et billede blev ikke uploadet korrekt. Prøv igen.", kode: "billede_mangler" });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("kun sælgeren, kun betalt, begge billedkategorier", async () => {
    const k = klient({});
    expect(await sendPakkeFor(k.klient as never, KOEBER, HANDEL, "1", billeder)).toMatchObject({ kode: "ikke_saelger" });
    expect(await sendPakkeFor(k.klient as never, SAELGER, HANDEL, "1", [billeder[0]])).toMatchObject({ kode: "billeder_kraeves" });
    handel!.status = "pakke_sendt";
    expect(await sendPakkeFor(k.klient as never, SAELGER, HANDEL, "1", billeder)).toMatchObject({ kode: "allerede_sendt" });
    handel = null;
    expect(await sendPakkeFor(k.klient as never, SAELGER, HANDEL, "1", billeder)).toMatchObject({ kode: "ikke_fundet" });
    expect(k.rpcLog).toHaveLength(0);
  });
});

describe("markerModtagetFor", () => {
  it("køberen kvitterer: sælgeren får 'Pakken er kommet frem'", async () => {
    handel!.status = "pakke_sendt";
    const k = klient({ trade_marker_modtaget: { data: true, error: null } });
    expect(await markerModtagetFor(k.klient as never, KOEBER, HANDEL)).toEqual({ ok: true });
    expect(m.send).toHaveBeenCalledWith(SAELGER, "pakke_leveret", expect.objectContaining({ titel: "Pakken er kommet frem" }));
  });

  it("dobbeltklik: 'allerede' og ingen ny besked", async () => {
    handel!.status = "pakke_sendt";
    const k = klient({ trade_marker_modtaget: { data: false, error: null } });
    expect(await markerModtagetFor(k.klient as never, KOEBER, HANDEL)).toMatchObject({ kode: "allerede" });
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("godkendPakkeFor", () => {
  it("godkendelse: afregning, 'Tak for handlen' og udbetaling - som hjemmesiden", async () => {
    handel!.status = "modtaget";
    const k = klient({ handel_godkend_med_bedoemmelse: { data: "ok", error: null } });
    expect(await godkendPakkeFor(k.klient as never, KOEBER, HANDEL, 5, "  Fin handel ")).toEqual({ ok: true });
    expect(k.rpcLog[0]).toEqual({
      navn: "handel_godkend_med_bedoemmelse",
      args: { p_trade: HANDEL, p_stjerner: 5, p_kommentar: "Fin handel" },
    });
    expect(m.sendSaelgerAfregning).toHaveBeenCalledWith(HANDEL, "godkendt");
    expect(m.sendKoeberAfsluttet).toHaveBeenCalledWith(HANDEL, "godkendt");
    expect(m.pengeTilSaelger).toHaveBeenCalledWith("betaling-1");
  });

  it("åben indsigelse blokerer - intet kaldes", async () => {
    handel!.status = "modtaget";
    m.indsigelseBlokerer.mockReturnValueOnce(true);
    const k = klient({});
    expect(await godkendPakkeFor(k.klient as never, KOEBER, HANDEL, 5, null)).toMatchObject({ kode: "indsigelse" });
    expect(k.rpcLog).toHaveLength(0);
    expect(m.pengeTilSaelger).not.toHaveBeenCalled();
  });

  it("stjerner kræves; kun køberen", async () => {
    handel!.status = "modtaget";
    const k = klient({});
    expect(await godkendPakkeFor(k.klient as never, KOEBER, HANDEL, 0, null)).toMatchObject({ kode: "ugyldige_stjerner" });
    expect(await godkendPakkeFor(k.klient as never, KOEBER, HANDEL, "5", null)).toMatchObject({ kode: "ugyldige_stjerner" });
    expect(await godkendPakkeFor(k.klient as never, SAELGER, HANDEL, 5, null)).toMatchObject({ kode: "ikke_koeber" });
    expect(await godkendPakkeFor(k.klient as never, KOEBER, HANDEL, 5, "x".repeat(1001))).toMatchObject({ kode: "kommentar_for_lang" });
  });
});

describe("bekraeftAfhentningFor", () => {
  it("rigtig kode: afregning (afhentet) og udbetaling", async () => {
    const k = klient({ afhentning_bekraeft: { data: { kode: "ok" }, error: null } });
    expect(await bekraeftAfhentningFor(k.klient as never, SAELGER, HANDEL, "123 456")).toEqual({ ok: true });
    expect(k.rpcLog[0]).toEqual({ navn: "afhentning_bekraeft", args: { p_trade: HANDEL, p_kode: "123456" } });
    expect(m.sendSaelgerAfregning).toHaveBeenCalledWith(HANDEL, "afhentet");
    expect(m.pengeTilSaelger).toHaveBeenCalled();
  });

  it("samme fejltekster som før", async () => {
    const k = klient({ afhentning_bekraeft: { data: { kode: "forkert", tilbage: 2 }, error: null } });
    expect(await bekraeftAfhentningFor(k.klient as never, SAELGER, HANDEL, "123456")).toEqual({
      fejl: "Koden er forkert. Du har 2 forsøg tilbage i denne time.",
      kode: "forkert",
    });
    expect(await bekraeftAfhentningFor(k.klient as never, SAELGER, HANDEL, "12345")).toEqual({
      fejl: "Koden består af 6 cifre.",
      kode: "ugyldig_kode",
    });
    expect(m.pengeTilSaelger).not.toHaveBeenCalled();
  });
});
