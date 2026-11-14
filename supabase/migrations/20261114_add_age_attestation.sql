-- DraftSpace age confirmation storage.
-- This table stores the canonical Firebase UID keyed account record used by the app.
-- A user is only eligible to create an account when age_13_or_older is true and
-- age_attested_at is set. No birthday or exact age is collected.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text not null unique,
  email text,
  age_13_or_older boolean,
  age_attested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists firebase_uid text,
  add column if not exists email text,
  add column if not exists age_13_or_older boolean,
  add column if not exists age_attested_at timestamptz,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

create unique index if not exists profiles_firebase_uid_unique_idx
  on public.profiles (firebase_uid);

create index if not exists profiles_age_attested_idx
  on public.profiles (age_attested_at)
  where age_13_or_older is true;

-- Keep the age attestation immutable after the first successful record.
create or replace function public.lock_profile_age_confirmation()
returns trigger
language plpgsql
as $$
begin
  if old.age_13_or_older is null and new.age_13_or_older is true and old.age_attested_at is null and new.age_attested_at is not null then
    return new;
  end if;

  if old.age_13_or_older is distinct from new.age_13_or_older or old.age_attested_at is distinct from new.age_attested_at then
    raise exception 'Age confirmation is locked after attestation.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_age_confirmation_lock on public.profiles;
create trigger profiles_age_confirmation_lock
before update on public.profiles
for each row
execute function public.lock_profile_age_confirmation();

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all"
on public.profiles for select
using (true);

drop policy if exists "profiles_insert_blocked" on public.profiles;
create policy "profiles_insert_blocked"
on public.profiles for insert
with check (false);

drop policy if exists "profiles_update_blocked" on public.profiles;
create policy "profiles_update_blocked"
on public.profiles for update
using (false)
with check (false);

drop policy if exists "profiles_delete_blocked" on public.profiles;
create policy "profiles_delete_blocked"
on public.profiles for delete
using (false);
