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
      {/* Mål for "Spring til indhold" i topbaren. På mobil fylder indholdet
          mindst skærmhøjden, så footeren ikke hopper inde i billedet, når en
          side skifter fra indlæsning (skelet) til det rigtige indhold (CLS). */}
      <div id="indhold" tabIndex={-1} className="flex flex-1 flex-col outline-none max-lg:min-h-svh">
        {children}
      </div>
      <Footer />
    </FavoritterProvider>
  );
}
