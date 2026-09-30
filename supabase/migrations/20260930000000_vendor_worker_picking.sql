create table if not exists public.vendor_workers (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  auth_user_id uuid not null unique,
  worker_name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_workers_vendor_id_idx
  on public.vendor_workers(vendor_id);

create table if not exists public.order_item_picking_tasks (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  worker_id uuid not null references public.vendor_workers(id) on delete restrict,
  quantity integer not null default 0,
  status text not null default 'assigned',
  assigned_at timestamptz not null default now(),
  picked_at timestamptz null,
  updated_at timestamptz not null default now()
);

create unique index if not exists order_item_picking_tasks_order_item_idx
  on public.order_item_picking_tasks(order_item_id);

create index if not exists order_item_picking_tasks_vendor_idx
  on public.order_item_picking_tasks(vendor_id, status);

create index if not exists order_item_picking_tasks_worker_idx
  on public.order_item_picking_tasks(worker_id, status);

alter table public.vendor_workers enable row level security;
alter table public.order_item_picking_tasks enable row level security;

drop policy if exists "Vendor workers can read own vendor workers" on public.vendor_workers;
create policy "Vendor workers can read own vendor workers"
on public.vendor_workers
for select
to authenticated
using (
  auth_user_id = auth.uid()
  or exists (
    select 1
    from public.vendors v
    where v.id = vendor_workers.vendor_id
      and v.auth_user_id = auth.uid()
  )
);

drop policy if exists "Vendor can insert own worker profiles" on public.vendor_workers;
create policy "Vendor can insert own worker profiles"
on public.vendor_workers
for insert
to authenticated
with check (
  exists (
    select 1
    from public.vendors v
    where v.id = vendor_workers.vendor_id
      and v.auth_user_id = auth.uid()
  )
);

drop policy if exists "Vendor can update own worker profiles" on public.vendor_workers;
create policy "Vendor can update own worker profiles"
on public.vendor_workers
for update
to authenticated
using (
  exists (
    select 1
    from public.vendors v
    where v.id = vendor_workers.vendor_id
      and v.auth_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.vendors v
    where v.id = vendor_workers.vendor_id
      and v.auth_user_id = auth.uid()
  )
);

drop policy if exists "Vendor can read own picking tasks" on public.order_item_picking_tasks;
create policy "Vendor can read own picking tasks"
on public.order_item_picking_tasks
for select
to authenticated
using (
  exists (
    select 1
    from public.vendors v
    where v.id = order_item_picking_tasks.vendor_id
      and v.auth_user_id = auth.uid()
  )
);

drop policy if exists "Vendor can create own picking tasks" on public.order_item_picking_tasks;
create policy "Vendor can create own picking tasks"
on public.order_item_picking_tasks
for insert
to authenticated
with check (
  exists (
    select 1
    from public.vendors v
    where v.id = order_item_picking_tasks.vendor_id
      and v.auth_user_id = auth.uid()
  )
);

drop policy if exists "Vendor can update own picking tasks" on public.order_item_picking_tasks;
create policy "Vendor can update own picking tasks"
on public.order_item_picking_tasks
for update
to authenticated
using (
  exists (
    select 1
    from public.vendors v
    where v.id = order_item_picking_tasks.vendor_id
      and v.auth_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.vendor_workers w
    where w.id = order_item_picking_tasks.worker_id
      and w.auth_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.vendors v
    where v.id = order_item_picking_tasks.vendor_id
      and v.auth_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.vendor_workers w
    where w.id = order_item_picking_tasks.worker_id
      and w.auth_user_id = auth.uid()
  )
);
