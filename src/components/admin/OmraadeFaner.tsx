import AdminFaner from "@/components/admin/AdminFaner";
import { hentStaffTal } from "@/lib/admin/taellere";
import { harMindstRolle, type StaffRole } from "@/lib/adminAuth";

// Fanerne for menupunkter, der samler flere sider (docs/ADMIN-REDESIGN.md
// 2.2). Fanerne linker til de eksisterende adresser. En fane, man ikke har
// adgang til, vises ikke - siderne tjekker stadig selv adgangen.
// Tallene kommer fra menuens tællere (delt via cache(), intet ekstra kald).

export async function HenvendelserFaner({ aktiv }: { aktiv: "kontakt" | "chats" | "bot" }) {
  const t = await hentStaffTal();
  return (
    <AdminFaner
      label="Henvendelser"
      aktiv={aktiv}
      faner={[
        { id: "kontakt", label: "Kontaktformular", href: "/admin/kontakt", antal: t.kontakt, tone: "gul" },
        { id: "chats", label: "Chats", href: "/admin/chats", antal: t.chats, tone: "gul" },
        { id: "bot", label: "BidHamr-bot", href: "/admin/bot" },
      ]}
    />
  );
}

export type AnmeldelserFane = "dsa" | "aabne" | "chat" | "bedoemmelser" | "opklarede" | "arkiv";

export async function AnmeldelserFaner({ aktiv, rolle }: { aktiv: AnmeldelserFane; rolle: StaffRole }) {
  const t = await hentStaffTal();
  return (
    <AdminFaner
      label="Anmeldelser"
      aktiv={aktiv}
      faner={[
        {
          id: "dsa",
          label: "Ulovligt indhold (DSA)",
          href: "/admin/dsa",
          antal: t.dsa,
          tone: t.dsaOverskredet > 0 ? "roed" : "gul",
        },
        { id: "aabne", label: "Auktioner", href: "/admin/rapporter" },
        { id: "chat", label: "Chat og profiler", href: "/admin/bruger-rapporter" },
        { id: "bedoemmelser", label: "Bedømmelser", href: "/admin/bedommelser", antal: t.bedoemmelser, tone: "graa" },
        { id: "opklarede", label: "Opklarede (48 t)", href: "/admin/opklarede-rapporter" },
        ...(harMindstRolle(rolle, "admin") ? [{ id: "arkiv", label: "Arkiv", href: "/admin/rapport-arkiv" }] : []),
      ]}
    />
  );
}

export function BetaFaner({ aktiv }: { aktiv: "invitationer" | "fejl" }) {
  return (
    <AdminFaner
      label="Beta-test"
      aktiv={aktiv}
      faner={[
        { id: "invitationer", label: "Invitationer", href: "/admin/beta" },
        { id: "fejl", label: "Fejl meldt af testere", href: "/admin/beta-fejl" },
      ]}
    />
  );
}

export function DriftFaner({ aktiv }: { aktiv: "drift" | "rapport" }) {
  return (
    <AdminFaner
      label="Drift"
      aktiv={aktiv}
      faner={[
        { id: "drift", label: "Overvågning", href: "/admin/drift" },
        { id: "rapport", label: "Gennemsigtighedsrapport (DSA)", href: "/admin/dsa/rapport" },
      ]}
    />
  );
}

// Handler-fanerne på sider uden for /admin/handler (Ubetalte vindere).
export async function HandlerFaner({ aktiv }: { aktiv: "ubetalte" }) {
  const t = await hentStaffTal();
  return (
    <AdminFaner
      label="Handler"
      aktiv={aktiv}
      faner={[
        { id: "haenger", label: "Hænger", href: "/admin/handler?vis=haenger", antal: t.haenger, tone: "gul" },
        { id: "fragt", label: "Fragt", href: "/admin/handler?vis=fragt", antal: t.fragt, tone: "gul" },
        { id: "markeret", label: "Markeret af os", href: "/admin/handler?vis=markeret", antal: t.markeret, tone: "graa" },
        { id: "ubetalte", label: "Ubetalte vindere", href: "/admin/ubetalte", antal: t.ubetalte, tone: "graa" },
        { id: "aktive", label: "Aktive handler", href: "/admin/handler?vis=aktive" },
        { id: "alle", label: "Alle", href: "/admin/handler?vis=alle" },
      ]}
    />
  );
}
