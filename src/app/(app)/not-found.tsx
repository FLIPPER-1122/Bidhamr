import SideFindesIkke from "@/components/fejl/SideFindesIkke";

// 404 inde i appen (notFound() fra en side under (app), fx en auktion eller
// profil, der ikke findes). Vises med topbar og footer.
export default function NotFound() {
  return <SideFindesIkke />;
}
