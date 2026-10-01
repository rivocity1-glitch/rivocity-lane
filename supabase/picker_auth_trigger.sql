-- RivoCity Picker auth flow: no Edge Functions required.
-- Run this ONCE in Supabase SQL Editor.

alter table public.picker_profiles
  add column if not exists address text,
  add column if not exists documents_submitted jsonb not null default '[]'::jsonb;

create or replace function public.handle_picker_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_source text;
  v_vendor_id uuid;
  v_picker_id text;
  v_exists boolean;
begin
  v_role := new.raw_user_meta_data ->> 'picker_role';

  if v_role is distinct from 'picker' then
    return new;
  end if;

  v_source := coalesce(new.raw_user_meta_data ->> 'registration_source', 'pwa');

  if v_source = 'vendor' then
    v_vendor_id := nullif(new.raw_user_meta_data ->> 'created_by_vendor_id', '')::uuid;
  end if;

  -- Generate the public Picker ID.
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
    v_picker_id,
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
    case when v_source = 'vendor' then 'approved' else 'pending' end,
    v_source,
    v_vendor_id
  );

  if v_source = 'vendor' and v_vendor_id is not null then
    insert into public.vendor_workers (
      vendor_id,
      auth_user_id,
      worker_name,
      status
    )
    values (
      v_vendor_id,
      new.id,
      coalesce(new.raw_user_meta_data ->> 'full_name', 'Picker'),
      'active'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_picker_auth_user_created on auth.users;

create trigger on_picker_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_picker_auth_user();

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
