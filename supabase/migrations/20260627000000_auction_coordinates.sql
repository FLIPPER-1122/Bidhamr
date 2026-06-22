-- Koordinater (fra DAWA's postnummer-opslag) bruges til radius-baseret
-- filtrering på auktionsoversigten.

alter table public.auctions
  add column lat double precision,
  add column lng double precision;
