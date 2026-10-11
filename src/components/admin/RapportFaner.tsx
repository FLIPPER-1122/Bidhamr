import { AnmeldelserFaner } from "@/components/admin/OmraadeFaner";

// Faner øverst på de gamle "Rapporter"-sider. De hører nu til menupunktet
// Anmeldelser (DSA, auktioner, chat og profiler, bedømmelser, opklarede,
// arkiv) - samme faner alle steder. Arkivet vises kun for admin og chef
// (siden tjekker selv rollen).
export default function RapportFaner({
  aktiv,
  visArkiv,
}: {
  aktiv: "aabne" | "opklarede" | "arkiv" | "chat";
  visArkiv: boolean;
}) {
  return <AnmeldelserFaner aktiv={aktiv} rolle={visArkiv ? "admin" : "medarbejder"} />;
}
