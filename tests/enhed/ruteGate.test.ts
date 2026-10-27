// Gatelisten (src/lib/supabase/middleware.ts) skal kende ALLE ruter.
//
// Efter lancering sender gaten kun besøgende uden login til /login, hvis
// stien står i LOGIN_PAAKRAEVET_EFTER_LANCERING (kraeverLoginEfterLancering).
// Ukendte stier går videre (rigtig 404). Glemmer man at sætte en ny side, der
// kræver login, på listen, viser den sig selv for alle - og så er det kun
// sidens eget brugertjek, der står imellem. Denne test gennemgår alle
// page.tsx og route.ts under src/app og fejler, hvis en rute hverken er
// offentlig, åben efter lancering eller kræver login.
//
// OFFENTLIGE_RUTER herunder er den samlede, tydelige liste over ruter, der
// kan nås UDEN login. Den skal passe præcis til gaten: tilføjer nogen en
// offentlig rute i middleware.ts (eller en ny side, som et åbent mønster
// rammer), fejler testen, til den også står her - så det er et bevidst valg.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  erAabenEfterLancering,
  erOffentligLaeseside,
  erOffentligRute,
  kraeverLoginEfterLancering,
} from "@/lib/supabase/middleware";
import { erAdgangSti } from "@/lib/adminGateRegler";

const APP = path.resolve(import.meta.dirname, "../../src/app");
const EKSEMPEL_ID = "33333333-3333-4333-8333-333333333333";

type Klasse = "offentlig" | "laeseside" | "aaben" | "login" | "admin-vaert" | "ukendt";

// Ruter, der kan nås uden login (offentlige før og efter lancering, rene
// læsesider og de åbne sider efter lancering). Skabelonerne er stierne i
// src/app uden route-grupper, fx /auktion/[id].
const OFFENTLIGE_RUTER: Record<string, Exclude<Klasse, "login" | "admin-vaert" | "ukendt">> = {
  // Åbne efter lancering (forside, søgning, auktion, profiler, faste sider).
  "/": "aaben",
  "/auktioner": "aaben",
  "/auktion/[id]": "aaben",
  "/profil/[id]": "aaben",
  "/erhvervssaelger/[id]": "aaben",
  "/bidhamr-beskyttelse": "aaben",
  "/cookies": "aaben",
  "/saadan-virker-det": "aaben",
  "/faq": "aaben",
  "/pakkeguide": "aaben",
  "/forbudte-varer": "aaben",
  "/om": "aaben",
  "/kontakt": "aaben",
  "/tilgaengelighed": "aaben",
  // Rene læsesider (GET/HEAD) for alle, også før lancering.
  "/betingelser": "laeseside",
  "/privatliv": "laeseside",
  "/bekraeft": "laeseside",
  // Offentlige ruter (alle metoder; server actions tjekkes særskilt).
  "/coming-soon": "offentlig",
  "/login": "offentlig",
  "/signup": "offentlig",
  "/tjek-indbakke": "offentlig",
  "/konto-slettet": "offentlig",
  "/glemt-adgangskode": "offentlig",
  "/nulstil-adgangskode": "offentlig",
  "/reset-password": "offentlig",
  "/auth/callback": "offentlig",
  "/auth/velkomst": "offentlig",
  "/erhverv": "offentlig",
  "/erhverv/formular": "offentlig",
  "/dsa": "offentlig",
  "/dsa/anmeld": "offentlig",
  "/dsa/anmeldelse/[id]": "offentlig",
  "/dsa/afgoerelse/[id]": "offentlig",
  "/robots.txt": "offentlig",
  "/sitemap.xml": "offentlig",
  // API-ruter med egen adgangskontrol (token, signatur, cron-hemmelighed ...).
  "/api/waitlist": "offentlig",
  "/api/webhooks/stripe": "offentlig",
  "/api/fragt/webhook/[firma]": "offentlig",
  "/api/cron/afslut-auktioner": "offentlig",
  "/api/cron/afstemning": "offentlig",
  "/api/cron/drift-alarm": "offentlig",
  "/api/statistik": "offentlig",
  "/api/konto/slet": "offentlig",
  "/api/konto/opret": "offentlig",
  "/api/konto/bekraeft": "offentlig",
  "/api/konto/adgangskode": "offentlig",
  "/api/konto/glemt": "offentlig",
  "/api/konto/data": "offentlig",
  "/api/konto/email": "offentlig",
  "/api/konto/email/bekraeft": "offentlig",
  "/api/firma/skift-pakke": "offentlig",
  "/api/betaling/kort": "offentlig",
  "/api/betaling/app/[handling]": "offentlig",
  "/api/betaling/app/retur": "offentlig",
  "/api/faktura/[id]": "offentlig",
  "/api/ekstra-fragt/[id]/dokumentation": "offentlig",
  "/api/fragt/app/[handling]": "offentlig",
  "/api/helbred": "offentlig",
  "/api/mitid/app": "offentlig",
  "/api/mitid/app/afslut": "offentlig",
  "/api/mitid/callback": "offentlig",
  "/api/mitid/start": "offentlig",
  "/api/dac7/oplysninger": "offentlig",
  "/api/handel/app/[handling]": "offentlig",
  "/api/bud/app": "offentlig",
  "/api/auktion/app/[handling]": "offentlig",
  "/api/dsa/anmeld": "offentlig",
  "/api/offentlig/[handling]": "offentlig",
  // BidHamr-bot: tjekker selv lancering, adgang og loft (src/lib/bot/synlig.ts).
  "/api/bot": "offentlig",
  "/api/bot/medarbejder": "offentlig",
  "/api/app/bot": "offentlig",
  "/api/app/bot/medarbejder": "offentlig",
};

// Alle ruter under src/app som skabeloner (/auktion/[id]).
function alleRuter(): string[] {
  const ud: string[] = [];
  const gaa = (mappe: string, dele: string[]) => {
    for (const e of fs.readdirSync(mappe, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // Private mapper (_x) er ikke ruter; route-grupper ((x)) og
        // parallelle ruter (@x) giver ingen del af stien.
        if (e.name.startsWith("_")) continue;
        const del = e.name.startsWith("(") || e.name.startsWith("@") ? [] : [e.name];
        gaa(path.join(mappe, e.name), [...dele, ...del]);
      } else if (/^(page|route)\.(tsx?|jsx?)$/.test(e.name)) {
        ud.push("/" + dele.join("/"));
      } else if (dele.length === 0 && /^robots\.(ts|js)$/.test(e.name)) {
        ud.push("/robots.txt");
      } else if (dele.length === 0 && /^sitemap\.(ts|js)$/.test(e.name)) {
        ud.push("/sitemap.xml");
      }
    }
  };
  gaa(APP, []);
  return [...new Set(ud)].sort();
}

// Skabelon -> en rigtig sti ([id] -> et uuid, så /profil/<uuid> rammes).
function eksempelSti(skabelon: string): string {
  return skabelon.replace(/\[\[?(?:\.\.\.)?[^\]]+\]\]?/g, EKSEMPEL_ID);
}

function klasse(skabelon: string): Klasse {
  const sti = eksempelSti(skabelon);
  // /adgang findes kun på admin-hosten (hovedAdminBeslutning giver 404 på
  // hovedsitet, src/lib/adminGateRegler.ts).
  if (erAdgangSti(sti)) return "admin-vaert";
  if (erOffentligLaeseside(sti, "GET")) return "laeseside";
  if (erOffentligRute(sti)) return "offentlig";
  if (erAabenEfterLancering(sti)) return "aaben";
  if (kraeverLoginEfterLancering(sti)) return "login";
  return "ukendt";
}

describe("gatelisten kender alle ruter", () => {
  const ruter = alleRuter();

  it("finder ruterne i src/app", () => {
    expect(ruter.length).toBeGreaterThan(100);
    expect(ruter).toContain("/");
    expect(ruter).toContain("/auktion/[id]");
    expect(ruter).toContain("/api/webhooks/stripe");
  });

  it("hver rute er offentlig, åben efter lancering eller kræver login", () => {
    const ukendte = ruter.filter((r) => klasse(r) === "ukendt");
    expect(
      ukendte,
      "Disse ruter står hverken i LOGIN_PAAKRAEVET_EFTER_LANCERING, OFFENTLIGE_RUTER, OFFENTLIGE_LAESESIDER eller AABNE_SIDER_EFTER_LANCERING i src/lib/supabase/middleware.ts",
    ).toEqual([]);
  });

  it("ruterne uden login er præcis listen i testen", () => {
    const faktiske = Object.fromEntries(
      ruter
        .map((r) => [r, klasse(r)] as const)
        .filter(([, k]) => k === "offentlig" || k === "laeseside" || k === "aaben"),
    );
    expect(faktiske).toEqual(OFFENTLIGE_RUTER);
  });

  it("en ny side uden for listerne fanges", () => {
    expect(klasse("/mine-noter")).toBe("ukendt");
    expect(klasse("/udbetalinger/[id]")).toBe("ukendt");
  });

  it("admin, konto og handler kræver login", () => {
    for (const r of ["/admin", "/admin/dsa", "/konto", "/mine-handler/[trade_id]", "/opret-auktion", "/firma", "/profil/mig", "/auktion/[id]/rediger", "/dev/mails"]) {
      expect(klasse(r), r).toBe("login");
    }
  });
});
