import AdminFaner from "./AdminFaner";

// Faner øverst på "Rapporter": åbne, opklarede (de seneste 48 timer) og
// arkivet. Arkivet vises kun for admin og chef (siden tjekker selv rollen).
export default function RapportFaner({
  aktiv,
  visArkiv,
}: {
  aktiv: "aabne" | "opklarede" | "arkiv";
  visArkiv: boolean;
}) {
  const faner = [
    { id: "aabne", label: "Åbne", href: "/admin/rapporter" },
    { id: "opklarede", label: "Opklarede (48 t)", href: "/admin/opklarede-rapporter" },
    ...(visArkiv ? [{ id: "arkiv", label: "Arkiv", href: "/admin/rapport-arkiv" }] : []),
  ];
  return <AdminFaner faner={faner} aktiv={aktiv} label="Rapporter" />;
}
