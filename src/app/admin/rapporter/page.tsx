import Link from "next/link";
import { Suspense } from "react";
import { kraevSideRolle, harMindstRolle } from "@/lib/adminAuth";
import AdminSearchInput from "@/components/admin/AdminSearchInput";
import AdminActionKnap from "@/components/admin/AdminActionKnap";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import FlereHandlinger from "@/components/admin/FlereHandlinger";
import { indgrebFelter } from "@/components/admin/indgrebFelter";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminBadge from "@/components/admin/AdminBadge";
import AdminTom from "@/components/admin/AdminTom";
import AdminFejl from "@/components/admin/AdminFejl";
import AdminListe, { type Kolonne } from "@/components/admin/AdminListe";
import AdminSideskift, { adminHref, laesSide } from "@/components/admin/AdminSideskift";
import { AnmeldelserFaner } from "@/components/admin/OmraadeFaner";
import { kategoriLabel } from "@/lib/anmeldelseKategorier";
import { RAPPORT_NOTE } from "@/lib/tekster/adminSkabeloner";
import {
  rapportMarkerBehandlet,
  rapportSletMidlertidigt,
  rapportFjernOpslag,
  rapportGenaabn,
} from "@/app/actions/adminActions";

// Anmeldte auktioner (fane under Anmeldelser). Hurtighandlingerne står på
// rækken: "Skjul auktion" (admin), "Markér som behandlet" og - under Flere
// handlinger - "Fjern opslag". Uden søgning hentes 25 ad gangen i databasen.
// Med søgning (titel og anmelder ligger i andre tabeller) søges blandt de
// 500 nyeste åbne.

const PR_SIDE = 25;

type RapportRow = {
  id: string;
  auction_id: string;
  reporter_id: string;
  category: string;
  description: string | null;
  created_at: string;
  status: string;
};

const STATUS: Record<string, { tone: "gul" | "blaa" | "roed"; tekst: string }> = {
  pending: { tone: "gul", tekst: "Afventer" },
  under_behandling: { tone: "blaa", tekst: "Skjult – undersøges" },
  fjernet: { tone: "roed", tekst: "Opslag fjernet" },
};

const lille =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-kant-staerk bg-white px-3 text-[13px] font-medium text-tekst transition-colors hover:bg-admin-bg lg:min-h-8";

export default async function AdminRapporter({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; side?: string }>;
}) {
  const { admin: supabase, rolle } = await kraevSideRolle("medarbejder");
  // Kun de to handlinger, der ændrer et opslag, kræver admin.
  const kanModerereOpslag = harMindstRolle(rolle, "admin");

  const { q, side: sideParam } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  const side = laesSide(sideParam);

  // Behandlede rapporter flyttes til /admin/opklarede-rapporter.
  const basis = supabase
    .from("reports")
    .select("id, auction_id, reporter_id, category, description, created_at, status", { count: "exact" })
    .neq("status", "behandlet")
    .order("created_at", { ascending: true });
  const { data: rapporter, error, count } = søgetekst
    ? await basis.limit(500)
    : await basis.range((side - 1) * PR_SIDE, side * PR_SIDE - 1);

  const alle = (rapporter ?? []) as RapportRow[];
  const auktionIds = [...new Set(alle.map((r) => r.auction_id))];
  const brugerIds = [...new Set(alle.map((r) => r.reporter_id))];

  const [{ data: auktioner }, { data: brugere }] = await Promise.all([
    auktionIds.length
      ? supabase.from("auctions").select("id, titel, seller_id").in("id", auktionIds)
      : Promise.resolve({ data: [] as { id: string; titel: string; seller_id: string }[] }),
    brugerIds.length
      ? supabase.from("users").select("id, navn, email").in("id", brugerIds)
      : Promise.resolve({ data: [] as { id: string; navn: string; email: string }[] }),
  ]);

  const titelMap = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));
  const brugerMap = new Map(
    (brugere ?? []).map((u) => [u.id as string, { navn: u.navn as string | null, email: u.email as string }]),
  );

  const rows = søgetekst
    ? alle.filter((r) => {
        const nål = søgetekst.toLowerCase();
        const anmelder = brugerMap.get(r.reporter_id);
        return [titelMap.get(r.auction_id), kategoriLabel(r.category), r.description, anmelder?.navn, anmelder?.email].some((v) =>
          (v ?? "").toLowerCase().includes(nål),
        );
      })
    : alle;
  const antal = søgetekst ? rows.length : (count ?? rows.length);

  const kolonner: Kolonne<RapportRow>[] = [
    {
      id: "status",
      label: "Status",
      mobil: "status",
      className: "lg:w-40",
      celle: (r) => {
        const s = STATUS[r.status] ?? STATUS.pending;
        return (
          <span className="flex flex-wrap gap-1.5">
            <AdminBadge tone={s.tone}>{s.tekst}</AdminBadge>
            <AdminBadge tone="graa">{kategoriLabel(r.category)}</AdminBadge>
          </span>
        );
      },
    },
    {
      id: "auktion",
      label: "Auktion",
      mobil: "titel",
      celle: (r) => (
        <span className="block min-w-0">
          <Link href={`/auktion/${r.auction_id}`} className="font-semibold text-tekst hover:text-groen hover:underline">
            {titelMap.get(r.auction_id) ?? "(slettet auktion)"}
          </Link>
          {r.description && <span className="mt-0.5 block text-[13px] font-normal text-tekst-daempet">{r.description}</span>}
        </span>
      ),
    },
    {
      id: "anmelder",
      label: "Anmelder",
      className: "lg:w-48",
      celle: (r) => {
        const a = brugerMap.get(r.reporter_id);
        return a ? (
          <Link href={`/admin/brugere/${r.reporter_id}`} className="block min-w-0 truncate text-[13px] hover:underline">
            {a.navn ?? "Uden navn"} · {new Date(r.created_at).toLocaleDateString("da-DK")}
          </Link>
        ) : (
          <span className="text-tekst-svag">—</span>
        );
      },
    },
    {
      id: "handling",
      label: "Handlinger",
      mobil: "handling",
      className: "lg:w-[330px]",
      celle: (r) =>
        r.status !== "pending" ? (
          <AdminActionKnap action={rapportGenaabn} hiddenFields={{ rapportId: r.id }} label="Genåbn" className={lille} kvittering="Anmeldelsen er genåbnet" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {kanModerereOpslag && (
              <ConfirmDialog
                triggerLabel="Skjul auktion"
                triggerClassName="btn btn-primaer btn-lille"
                title="Skjul auktionen, mens den undersøges?"
                description="Auktionen skjules fra platformen. Den kan vises igen under Auktioner. Sælgeren får begrundelsen og kan klage."
                confirmLabel="Skjul auktionen"
                action={rapportSletMidlertidigt}
                hiddenFields={{ rapportId: r.id }}
                fakta={[
                  { label: "Auktion", vaerdi: titelMap.get(r.auction_id) ?? "(slettet auktion)" },
                  { label: "Anmeldt for", vaerdi: kategoriLabel(r.category) },
                ]}
                {...indgrebFelter({
                  faktaPlaceholder: "Fx: Vi undersøger, om varen er en kopi. Auktionen er skjult imens.",
                  standardRegel: r.category === "forbudt_vare" ? "forbudt_vare" : undefined,
                })}
                kvittering="Auktionen er skjult"
              />
            )}
            <ConfirmDialog
              triggerLabel="Intet brud – luk"
              triggerClassName={kanModerereOpslag ? lille : "btn btn-primaer btn-lille"}
              title="Markér anmeldelsen som behandlet?"
              description="Auktionen forbliver aktiv. Anmeldelsen flyttes til Opklarede."
              confirmLabel="Markér som behandlet"
              action={rapportMarkerBehandlet}
              hiddenFields={{ rapportId: r.id }}
              aarsagField={{
                label: "Note",
                placeholder: "Hvad har du tjekket, og hvad er konklusionen?",
                required: true,
                skabeloner: RAPPORT_NOTE,
              }}
              kvittering="Anmeldelsen er markeret som behandlet"
            />
            {kanModerereOpslag && (
              <FlereHandlinger>
                <ConfirmDialog
                  triggerLabel="Fjern opslag permanent"
                  triggerClassName="inline-flex min-h-10 items-center rounded-lg border border-fejl-kant bg-white px-3 text-[13px] font-medium text-fejl-tekst hover:bg-fejl-bg lg:min-h-8"
                  title="Fjern opslaget permanent?"
                  description="Auktionen annulleres og skjules fra platformen. Anmeldelsen bevares som dokumentation. Sælgeren får begrundelsen og kan klage."
                  confirmLabel="Fjern opslaget"
                  action={rapportFjernOpslag}
                  hiddenFields={{ rapportId: r.id }}
                  fakta={[{ label: "Auktion", vaerdi: titelMap.get(r.auction_id) ?? "(slettet auktion)" }]}
                  fare
                  kanIkkeFortrydes
                  {...indgrebFelter({
                    faktaPlaceholder: "Fx: Auktionen sælger et skydevåben, som ikke må sælges på BidHamr.",
                    standardRegel: r.category === "forbudt_vare" ? "forbudt_vare" : undefined,
                  })}
                  kvittering="Opslaget er fjernet"
                />
              </FlereHandlinger>
            )}
          </div>
        ),
    },
  ];

  return (
    <AdminSide>
      <AdminSideHoved
        titel="Anmeldelser"
        forklaring="Brugere har anmeldt en auktion. Se opslaget, og skjul det eller luk anmeldelsen direkte fra rækken. Ældste først."
        hoejre={
          <span className="text-sm text-tekst-daempet">
            {antal} {antal === 1 ? "anmeldelse" : "anmeldelser"}
          </span>
        }
      />
      <AnmeldelserFaner aktiv="aabne" rolle={rolle} />

      <Suspense>
        <AdminSearchInput placeholder="Søg på auktion, kategori, beskrivelse eller anmelder" />
      </Suspense>

      {error && <AdminFejl hvad="Anmeldelserne" />}

      <AdminListe
        label="Anmeldte auktioner"
        raekker={rows}
        kolonner={kolonner}
        noegle={(r) => r.id}
        fremhaev={(r) => r.status === "pending"}
        tom={
          <AdminTom
            tekst={søgetekst ? `Ingen anmeldelser matcher "${søgetekst}".` : "Der er ingen åbne anmeldelser af auktioner."}
            nulstilHref={søgetekst ? "/admin/rapporter" : undefined}
            link={{ href: "/admin/opklarede-rapporter", label: "Se opklarede" }}
          />
        }
      />

      {!søgetekst && (
        <AdminSideskift
          side={side}
          harNaeste={side * PR_SIDE < antal}
          antalSider={Math.max(1, Math.ceil(antal / PR_SIDE))}
          lavHref={(s) => adminHref("/admin/rapporter", { side: s })}
        />
      )}
    </AdminSide>
  );
}
