// Velkomstlinket til nye firmakonti (24 timer): GET /auth/velkomst og
// src/lib/erhverv/velkomstBillet.ts. Supabase (database og auth) efterlignes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

type Raekke = {
  id: string;
  bruger_id: string;
  token_hash: string;
  udloeber_kl: string;
  annulleret_kl: string | null;
  aabnet_antal: number;
};

const db: { raekker: Raekke[]; lastSignIn: string | null; links: number } = { raekker: [], lastSignIn: null, links: 0 };

function admin() {
  return {
    from() {
      const filtre: [string, unknown][] = [];
      let opd: Partial<Raekke> | null = null;
      const match = () => db.raekker.filter((r) => filtre.every(([k, v]) => (r as Record<string, unknown>)[k] === v));
      // Som supabase-js: kæden er "thenable" og udføres ved await.
      const q = {
        select: () => q,
        update: (v: Partial<Raekke>) => {
          opd = v;
          return q;
        },
        insert: async (v: Omit<Raekke, "id" | "annulleret_kl" | "aabnet_antal">) => {
          db.raekker.push({ id: `b${db.raekker.length}`, annulleret_kl: null, aabnet_antal: 0, ...v });
          return { error: null };
        },
        eq: (k: string, v: unknown) => {
          filtre.push([k, v]);
          return q;
        },
        is: (k: string, v: unknown) => {
          filtre.push([k, v]);
          return q;
        },
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        then: (ok: (v: { error: null }) => unknown) => {
          if (opd) for (const r of match()) Object.assign(r, opd);
          return Promise.resolve({ error: null }).then(ok);
        },
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: "firma@test.bidhamr.dk", last_sign_in_at: db.lastSignIn } }, error: null }),
        generateLink: async () => {
          db.links++;
          return { data: { properties: { hashed_token: `frisk${db.links}` } }, error: null };
        },
      },
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin() }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => null) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange",
  indenForGraense: vi.fn(async () => true),
  klientIp: vi.fn(async () => "1.2.3.4"),
}));

const { udstedVelkomstBillet, VELKOMST_TIMER } = await import("@/lib/erhverv/velkomstBillet");
const { GET } = await import("@/app/auth/velkomst/route");

function billetFra(url: string) {
  return new URL(url).searchParams.get("b")!;
}
async function aabn(billet: string) {
  const res = await GET(new NextRequest(`https://bidhamr.dk/auth/velkomst?b=${encodeURIComponent(billet)}`));
  return { status: res.status, til: new URL(res.headers.get("location")!) };
}

beforeEach(() => {
  db.raekker = [];
  db.lastSignIn = null;
  db.links = 0;
});

describe("velkomstbillet", () => {
  it("udstedes med 24 timer, og kun hashen gemmes", async () => {
    const url = (await udstedVelkomstBillet(admin() as never, "u1", "staff"))!;
    expect(url).toMatch(/\/auth\/velkomst\?b=[A-Za-z0-9_-]{43}$/);
    const b = billetFra(url);
    expect(db.raekker).toHaveLength(1);
    expect(db.raekker[0].token_hash).toBe(createHash("sha256").update(b).digest("hex"));
    expect(JSON.stringify(db.raekker)).not.toContain(b);
    const timer = (Date.parse(db.raekker[0].udloeber_kl) - Date.now()) / 3600_000;
    expect(VELKOMST_TIMER).toBe(24);
    expect(timer).toBeGreaterThan(23.9);
    expect(timer).toBeLessThanOrEqual(24);
  });

  it("hver åbning giver et frisk Supabase-link via /auth/callback (mellemsiden)", async () => {
    const b = billetFra((await udstedVelkomstBillet(admin() as never, "u1", "staff"))!);
    const a = await aabn(b);
    expect(a.status).toBe(303);
    expect(a.til.pathname).toBe("/auth/callback");
    expect(a.til.searchParams.get("token_hash")).toBe("frisk1");
    expect(a.til.searchParams.get("type")).toBe("recovery");
    expect(a.til.searchParams.get("next")).toBe("/reset-password?velkommen=1");
    // Mail-scanneren åbnede først - firmaet får stadig et nyt link.
    expect((await aabn(b)).til.searchParams.get("token_hash")).toBe("frisk2");
  });

  it("udløbet billet: login med 'linket er udløbet'", async () => {
    const b = billetFra((await udstedVelkomstBillet(admin() as never, "u1", "staff"))!);
    db.raekker[0].udloeber_kl = new Date(Date.now() - 1000).toISOString();
    const a = await aabn(b);
    expect(a.til.pathname).toBe("/login");
    expect(a.til.searchParams.get("fejl")).toBe("velkommen_udloebet");
    expect(db.links).toBe(0);
  });

  it("en ny billet annullerer den gamle", async () => {
    const gammel = billetFra((await udstedVelkomstBillet(admin() as never, "u1", "staff"))!);
    const ny = billetFra((await udstedVelkomstBillet(admin() as never, "u1", "staff"))!);
    expect((await aabn(gammel)).til.searchParams.get("fejl")).toBe("velkommen_udloebet");
    expect((await aabn(ny)).til.pathname).toBe("/auth/callback");
  });

  it("firmaet har logget ind: login uden nyt link", async () => {
    const b = billetFra((await udstedVelkomstBillet(admin() as never, "u1", "staff"))!);
    db.lastSignIn = new Date().toISOString();
    const a = await aabn(b);
    expect(a.til.pathname).toBe("/login");
    expect(a.til.searchParams.get("fejl")).toBeNull();
    expect(db.links).toBe(0);
  });

  it("ukendt eller forkert formateret billet", async () => {
    expect((await aabn("x".repeat(43))).til.searchParams.get("fejl")).toBe("velkommen_udloebet");
    expect((await aabn("kort")).til.searchParams.get("fejl")).toBe("velkommen_udloebet");
    expect(db.links).toBe(0);
  });
});
