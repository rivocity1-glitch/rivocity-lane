create table if not exists public.picker_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique,
  full_name text not null,
  phone text not null,
  city text not null,
  locality text null,
  pincode text null,
  latitude double precision null,
  longitude double precision null,
  availability_status text not null default 'offline'
    check (availability_status in ('available','offline','busy')),
  application_status text not null default 'pending'
    check (application_status in ('pending','approved','rejected','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists picker_profiles_auth_user_idx
  on public.picker_profiles(auth_user_id);
create index if not exists picker_profiles_location_idx
  on public.picker_profiles(latitude, longitude);
create index if not exists picker_profiles_status_idx
  on public.picker_profiles(application_status, availability_status);

create table if not exists public.picker_vendor_requests (
  id uuid primary key default gen_random_uuid(),
  picker_id uuid not null references public.picker_profiles(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','cancelled')),
  requested_at timestamptz not null default now(),
  responded_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists picker_vendor_requests_picker_idx
  on public.picker_vendor_requests(picker_id, status);
create index if not exists picker_vendor_requests_vendor_idx
  on public.picker_vendor_requests(vendor_id, status);
create unique index if not exists picker_vendor_requests_pending_idx
  on public.picker_vendor_requests(picker_id, vendor_id)
  where status = 'pending';

alter table public.picker_profiles enable row level security;
alter table public.picker_vendor_requests enable row level security;

drop policy if exists "Picker can read own profile" on public.picker_profiles;
create policy "Picker can read own profile"
on public.picker_profiles for select to authenticated
using ((select auth.uid()) = auth_user_id);

drop policy if exists "Picker can create own profile" on public.picker_profiles;
create policy "Picker can create own profile"
on public.picker_profiles for insert to authenticated
with check ((select auth.uid()) = auth_user_id);

drop policy if exists "Picker can update own profile" on public.picker_profiles;
create policy "Picker can update own profile"
on public.picker_profiles for update to authenticated
using ((select auth.uid()) = auth_user_id)
with check ((select auth.uid()) = auth_user_id);

drop policy if exists "Vendors can view approved available pickers" on public.picker_profiles;
create policy "Vendors can view approved available pickers"
on public.picker_profiles for select to authenticated
using (
  application_status = 'approved'
  and availability_status = 'available'
  and exists (
    select 1 from public.vendors v
    where v.auth_user_id = (select auth.uid())
  )
);

drop policy if exists "Admins can view picker profiles" on public.picker_profiles;
create policy "Admins can view picker profiles"
on public.picker_profiles for select to authenticated
using (
  exists (
    select 1 from public.admin_users a
    where a.auth_user_id = (select auth.uid())
      and a.role = 'super_admin'
  )
);

drop policy if exists "Admins can update picker profiles" on public.picker_profiles;
create policy "Admins can update picker profiles"
on public.picker_profiles for update to authenticated
using (
  exists (
    select 1 from public.admin_users a
    where a.auth_user_id = (select auth.uid())
      and a.role = 'super_admin'
  )
)
with check (
  exists (
    select 1 from public.admin_users a
    where a.auth_user_id = (select auth.uid())
      and a.role = 'super_admin'
  )
);

drop policy if exists "Pickers can read own requests" on public.picker_vendor_requests;
create policy "Pickers can read own requests"
on public.picker_vendor_requests for select to authenticated
using (
  exists (
    select 1 from public.picker_profiles p
    where p.id = picker_vendor_requests.picker_id
      and p.auth_user_id = (select auth.uid())
  )
);

drop policy if exists "Pickers can respond to own requests" on public.picker_vendor_requests;
create policy "Pickers can respond to own requests"
on public.picker_vendor_requests for update to authenticated
using (
  exists (
    select 1 from public.picker_profiles p
    where p.id = picker_vendor_requests.picker_id
      and p.auth_user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.picker_profiles p
    where p.id = picker_vendor_requests.picker_id
      and p.auth_user_id = (select auth.uid())
  )
);

drop policy if exists "Vendors can read own picker requests" on public.picker_vendor_requests;
create policy "Vendors can read own picker requests"
on public.picker_vendor_requests for select to authenticated
using (
  exists (
    select 1 from public.vendors v
    where v.id = picker_vendor_requests.vendor_id
      and v.auth_user_id = (select auth.uid())
  )
);

drop policy if exists "Vendors can create picker requests" on public.picker_vendor_requests;
create policy "Vendors can create picker requests"
on public.picker_vendor_requests for insert to authenticated
with check (
  exists (
    select 1 from public.vendors v
    where v.id = picker_vendor_requests.vendor_id
      and v.auth_user_id = (select auth.uid())
  )
  and exists (
    select 1 from public.picker_profiles p
    where p.id = picker_vendor_requests.picker_id
      and p.application_status = 'approved'
      and p.availability_status = 'available'
  )
);

drop policy if exists "Vendors can cancel picker requests" on public.picker_vendor_requests;
create policy "Vendors can cancel picker requests"
on public.picker_vendor_requests for update to authenticated
using (
  exists (
    select 1 from public.vendors v
    where v.id = picker_vendor_requests.vendor_id
      and v.auth_user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.vendors v
    where v.id = picker_vendor_requests.vendor_id
      and v.auth_user_id = (select auth.uid())
  )
);

drop policy if exists "Admins can read picker requests" on public.picker_vendor_requests;
create policy "Admins can read picker requests"
on public.picker_vendor_requests for select to authenticated
using (
  exists (
    select 1 from public.admin_users a
    where a.auth_user_id = (select auth.uid())
      and a.role = 'super_admin'
  )
);

create or replace function public.accept_picker_vendor_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.picker_vendor_requests;
  v_picker public.picker_profiles;
  v_worker public.vendor_workers;
begin
  select * into v_request
  from public.picker_vendor_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Picker request not found';
  end if;

  select * into v_picker
  from public.picker_profiles
  where id = v_request.picker_id
    and auth_user_id = (select auth.uid())
  for update;

  if v_picker.id is null then
    raise exception 'Picker is not authorized for this request';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Picker request is no longer pending';
  end if;

  if v_picker.application_status <> 'approved' then
    raise exception 'Picker application is not approved';
  end if;

  update public.picker_vendor_requests
  set status = 'accepted',
      responded_at = now(),
      updated_at = now()
  where id = v_request.id;

  update public.picker_profiles
  set availability_status = 'busy',
      updated_at = now()
  where id = v_picker.id;

  select * into v_worker
  from public.vendor_workers
  where auth_user_id = v_picker.auth_user_id
    and vendor_id = v_request.vendor_id
  limit 1;

  if v_worker.id is null then
    insert into public.vendor_workers (
      vendor_id, auth_user_id, worker_name, status
    )
    values (
      v_request.vendor_id, v_picker.auth_user_id, v_picker.full_name, 'active'
    )
    returning * into v_worker;
  else
    update public.vendor_workers
    set worker_name = v_picker.full_name,
        status = 'active',
        updated_at = now()
    where id = v_worker.id
    returning * into v_worker;
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'worker_id', v_worker.id,
    'vendor_id', v_request.vendor_id,
    'picker_id', v_picker.id
  );
end;
$$;

revoke execute on function public.accept_picker_vendor_request(uuid) from public;
grant execute on function public.accept_picker_vendor_request(uuid) to authenticated;
