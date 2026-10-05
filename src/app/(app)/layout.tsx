import Header from "@/components/Header";
import Footer from "@/components/Footer";
import FavoritterProvider from "@/components/FavoritterProvider";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <FavoritterProvider>
      <Header />
      {/* Mål for "Spring til indhold" i topbaren */}
      <div id="indhold" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </div>
      <Footer />
    </FavoritterProvider>
  );
}
