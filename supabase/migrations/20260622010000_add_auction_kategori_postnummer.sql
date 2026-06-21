-- Tilføjer kategori og postnummer til auctions, brugt af "Opret auktion"-formularen.

alter table public.auctions
  add column kategori text,
  add column postnummer text;
