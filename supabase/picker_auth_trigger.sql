-- RivoCity Picker auth flow: no Edge Functions required.
-- Run this ONCE in Supabase SQL Editor.

alter table public.picker_profiles
  add column if not exists address text,
  add column if not exists documents_submitted jsonb not null default '[]'::jsonb;

-- Generate the public Picker ID before the Auth user is committed.
-- This lets the normal Supabase signUp() response include the Picker ID.
create or replace function public.assign_picker_login_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_picker_id text;
  v_exists boolean;
begin
  v_role := new.raw_user_meta_data ->> 'picker_role';

  if v_role is distinct from 'picker' then
    return new;
  end if;

  for i in 1..50 loop
    v_picker_id := 'Rpicker-' || lpad((floor(random() * 10000))::int::text, 4, '0');

    select exists(
      select 1
      from public.picker_profiles
      where picker_login_id = v_picker_id
    ) into v_exists;

    if not v_exists then
      exit;
    end if;

    v_picker_id := null;
  end loop;

  if v_picker_id is null then
    raise exception 'Could not generate a unique Picker ID';
  end if;

  new.raw_user_meta_data :=
    coalesce(new.raw_user_meta_data, '{}'::jsonb)
    || jsonb_build_object('picker_login_id', v_picker_id);

  return new;
end;
$$;

drop trigger if exists before_picker_auth_user_created on auth.users;

create trigger before_picker_auth_user_created
  before insert on auth.users
  for each row
  execute function public.assign_picker_login_id();

-- Create the normal public Picker record after Supabase Auth creates the user.
create or replace function public.create_picker_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_source text;
  v_vendor_id uuid;
begin
  v_role := new.raw_user_meta_data ->> 'picker_role';

  if v_role is distinct from 'picker' then
    return new;
  end if;

  v_source := coalesce(new.raw_user_meta_data ->> 'registration_source', 'pwa');

  if v_source = 'vendor' then
    v_vendor_id := nullif(new.raw_user_meta_data ->> 'created_by_vendor_id', '')::uuid;
  end if;

  insert into public.picker_profiles (
    auth_user_id,
    picker_login_id,
    email,
    full_name,
    phone,
    city,
    locality,
    pincode,
    address,
    latitude,
    longitude,
    availability_status,
    application_status,
    registration_source,
    created_by_vendor_id
  )
  values (
    new.id,
    new.raw_user_meta_data ->> 'picker_login_id',
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', 'Picker'),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(new.raw_user_meta_data ->> 'city', ''),
    nullif(new.raw_user_meta_data ->> 'locality', ''),
    nullif(new.raw_user_meta_data ->> 'pincode', ''),
    nullif(new.raw_user_meta_data ->> 'address', ''),
    nullif(new.raw_user_meta_data ->> 'latitude', '')::double precision,
    nullif(new.raw_user_meta_data ->> 'longitude', '')::double precision,
    'offline',
    'pending',
    v_source,
    v_vendor_id
  );

  return new;
end;
$$;

drop trigger if exists on_picker_auth_user_created on auth.users;

create trigger on_picker_auth_user_created
  after insert on auth.users
  for each row
  execute function public.create_picker_profile_from_auth();

-- Vendor Portal can see Pickers created by that vendor.
drop policy if exists "Vendors can view their created pickers" on public.picker_profiles;

create policy "Vendors can view their created pickers"
on public.picker_profiles
for select
to authenticated
using (
  created_by_vendor_id = (
    select v.id
    from public.vendors v
    where v.auth_user_id = auth.uid()
    limit 1
  )
);

-- Vendor can approve only Pickers it created.
drop policy if exists "Vendors can approve their created pickers" on public.picker_profiles;

create policy "Vendors can approve their created pickers"
on public.picker_profiles
for update
to authenticated
using (
  created_by_vendor_id = (
    select v.id
    from public.vendors v
    where v.auth_user_id = auth.uid()
    limit 1
  )
)
with check (
  created_by_vendor_id = (
    select v.id
    from public.vendors v
    where v.auth_user_id = auth.uid()
    limit 1
  )
);

-- Vendor can create the worker record after approving its Picker.
drop policy if exists "Vendors can create their picker workers" on public.vendor_workers;

create policy "Vendors can create their picker workers"
on public.vendor_workers
for insert
to authenticated
with check (
  vendor_id = (
    select v.id
    from public.vendors v
    where v.auth_user_id = auth.uid()
    limit 1
  )
);

-- Verify.
select
  id,
  picker_login_id,
  email,
  full_name,
  registration_source,
  created_by_vendor_id,
  application_status,
  pincode,
  address,
  documents_submitted
from public.picker_profiles
order by created_at desc
limit 20;
