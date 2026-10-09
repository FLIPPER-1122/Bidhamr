"use client";

// Kort over pakkeshops (Leaflet + OpenStreetMap). Indlæses kun, når
// pakkeshop-vinduet åbnes (next/dynamic i PakkeshopVaelger), så Leaflet og
// dets CSS ikke kommer med på andre sider. Listen ved siden af er den
// tilgængelige vej - kortet er en ekstra hjælp, men markørerne kan også nås
// med tastaturet (Tab + Enter).
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useRef } from "react";
import type { Pakkeshop } from "@/lib/fragt/types";

// Danmark, hvis ingen shop har koordinater.
const DANMARK: L.LatLngTuple = [56.0, 10.4];

function ikon(nr: number, valgt: boolean) {
  return L.divIcon({
    className: "",
    iconSize: [32, 32],
    iconAnchor: [16, 30],
    html: `<span class="grid h-8 w-8 place-items-center rounded-full border-2 border-white text-[13px] font-bold text-white shadow-[0_2px_6px_rgba(0,0,0,.35)] ${
      valgt ? "bg-orange-knap scale-110" : "bg-groen"
    }">${nr}</span>`,
  });
}

export default function PakkeshopKort({
  shops,
  valgtId,
  onVaelg,
}: {
  shops: Pakkeshop[];
  valgtId: string | null;
  onVaelg: (id: string) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const kortRef = useRef<L.Map | null>(null);
  const lagRef = useRef<L.LayerGroup | null>(null);
  const markoererRef = useRef(new Map<string, { m: L.Marker; nr: number }>());
  const onVaelgRef = useRef(onVaelg);
  useEffect(() => {
    onVaelgRef.current = onVaelg;
  });

  // Kortet oprettes én gang.
  useEffect(() => {
    if (!elRef.current) return;
    const kort = L.map(elRef.current, { center: DANMARK, zoom: 6, scrollWheelZoom: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(kort);
    kort.attributionControl.setPrefix(false);
    lagRef.current = L.layerGroup().addTo(kort);
    kortRef.current = kort;
    // Vinduet kan ændre størrelse (mobil/desktop, tastatur på mobil).
    const ro = new ResizeObserver(() => kort.invalidateSize());
    ro.observe(elRef.current);
    const markoerer = markoererRef.current;
    return () => {
      ro.disconnect();
      kort.remove();
      kortRef.current = null;
      lagRef.current = null;
      markoerer.clear();
    };
  }, []);

  // Markører, når søgeresultatet skifter.
  useEffect(() => {
    const kort = kortRef.current;
    const lag = lagRef.current;
    if (!kort || !lag) return;
    lag.clearLayers();
    markoererRef.current.clear();
    const punkter: L.LatLngTuple[] = [];
    shops.forEach((s, i) => {
      if (s.lat === null || s.lng === null) return;
      const m = L.marker([s.lat, s.lng], {
        icon: ikon(i + 1, false),
        title: `${i + 1}. ${s.navn}, ${s.adresse}`,
        alt: s.navn,
        keyboard: true,
        riseOnHover: true,
      });
      m.on("click", () => onVaelgRef.current(s.id));
      m.on("keypress", (e: L.LeafletKeyboardEvent) => {
        if (e.originalEvent.key === " ") onVaelgRef.current(s.id);
      });
      m.addTo(lag);
      markoererRef.current.set(s.id, { m, nr: i + 1 });
      punkter.push([s.lat, s.lng]);
    });
    if (punkter.length === 1) kort.setView(punkter[0], 15);
    else if (punkter.length > 1) kort.fitBounds(L.latLngBounds(punkter), { padding: [32, 32], maxZoom: 16 });
  }, [shops]);

  // Den valgte shop fremhæves og centreres.
  useEffect(() => {
    const kort = kortRef.current;
    if (!kort) return;
    for (const [id, { m, nr }] of markoererRef.current) {
      const valgt = id === valgtId;
      m.setIcon(ikon(nr, valgt));
      m.setZIndexOffset(valgt ? 1000 : 0);
      if (valgt) kort.panTo(m.getLatLng(), { animate: true });
    }
  }, [valgtId, shops]);

  return (
    <div
      ref={elRef}
      role="region"
      aria-label="Kort over pakkeshops"
      className="h-full min-h-[200px] w-full bg-groen-lys"
    />
  );
}
