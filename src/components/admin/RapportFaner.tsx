import AdminFaner from "./AdminFaner";

// Faner øverst på "Rapporter": åbne, opklarede (de seneste 48 timer),
// rapporter af chatbeskeder/profiler (bruger_rapporter) og arkivet. Arkivet vises kun for admin og chef (siden tjekker selv rollen).
export default function RapportFaner({
  aktiv,
  visArkiv,
}: {
  aktiv: "aabne" | "opklarede" | "arkiv" | "chat";
  visArkiv: boolean;
}) {
  // Anmeldelser fra hjemmesiden (også uden login) ligger under DSA.
  const faner = [
    { id: "dsa", label: "Anmeldelser (DSA)", href: "/admin/dsa" },
    { id: "aabne", label: "Åbne", href: "/admin/rapporter" },
    { id: "opklarede", label: "Opklarede (48 t)", href: "/admin/opklarede-rapporter" },
    { id: "chat", label: "Chat og profiler", href: "/admin/bruger-rapporter" },
    ...(visArkiv ? [{ id: "arkiv", label: "Arkiv", href: "/admin/rapport-arkiv" }] : []),
  ];
  return <AdminFaner faner={faner} aktiv={aktiv} label="Rapporter" />;
}
