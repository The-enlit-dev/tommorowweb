-- Fix: the UPI ID check used {2,256}, but PostgreSQL regular expressions allow repetition counts up
-- to 255, so every save that included a UPI ID failed with "invalid repetition count(s)".
-- Same rule otherwise: handle (2–255 chars) @ bank handle.
alter table public.commerce_settings drop constraint if exists commerce_settings_upi_id_check;
alter table public.commerce_settings
  add constraint commerce_settings_upi_id_check check (upi_id ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$');
