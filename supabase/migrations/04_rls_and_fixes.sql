-- =====================================================================
-- AprovechaYa - 04: Correcciones consolidadas (IDEMPOTENTE)
-- Ejecutar en Supabase Dashboard -> SQL Editor (se puede correr varias veces).
--
-- Qué arregla:
--   1. profiles.role acepta 'charity'  (antes el registro como institución fallaba)
--   2. Trigger de perfil robusto (valida el rol, no rompe el signUp)
--   3. products: expires_at server-side, status válido, user_id/status forzados
--   4. RLS real en profiles y products (REEMPLAZA todas las políticas existentes)
--   5. Storage: buckets product-images y avatars públicos + políticas por carpeta
--   6. RPC mark_product_picked_up (el comercio marca "recogido" => SOLD)
--   7. cleanup_expired_products() corregida
--   8. Realtime habilitado para products
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Columnas
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists created_at timestamptz not null default now();

alter table public.products add column if not exists packaging_type text;
alter table public.products add column if not exists packaging_condition text;
alter table public.products add column if not exists image_urls text[] default '{}';
alter table public.products add column if not exists expires_at timestamptz;
alter table public.products alter column image_url drop not null;

update public.products
   set expires_at = created_at + make_interval(hours => coalesce(expiration_hours, 12)::int)
 where expires_at is null;

-- ---------------------------------------------------------------------
-- 1. Restricciones CHECK (role y status)
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.profiles'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;

  for c in
    select conname from pg_constraint
     where conrelid = 'public.products'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.products drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check check (role in ('consumer', 'merchant', 'charity'));
alter table public.products
  add constraint products_status_check check (status in ('AVAILABLE', 'RESERVED', 'SOLD', 'EXPIRED'));

-- ---------------------------------------------------------------------
-- 2. Trigger: crear perfil al registrarse
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_name text;
begin
  v_role := lower(coalesce(new.raw_user_meta_data->>'role', 'consumer'));
  if v_role not in ('consumer', 'merchant', 'charity') then
    v_role := 'consumer';
  end if;

  v_name := left(
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1), 'Usuario'),
    120
  );
  if v_name = '' then v_name := 'Usuario'; end if;

  insert into public.profiles (id, full_name, role)
  values (new.id, v_name, v_role)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 3. Trigger BEFORE INSERT en products (el servidor decide, no el cliente)
-- ---------------------------------------------------------------------
create or replace function public.products_before_insert()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();          -- no se puede publicar a nombre de otro
    new.status := 'AVAILABLE';          -- nadie nace ya reservado
    new.reserved_by := null;
  end if;
  new.expiration_hours := least(greatest(coalesce(new.expiration_hours, 12), 1), 72);
  new.created_at := now();
  new.expires_at := new.created_at + make_interval(hours => new.expiration_hours::int);
  return new;
end;
$$;

drop trigger if exists update_products_expires_at on public.products;
drop function if exists public.update_expires_at();
drop trigger if exists products_before_insert on public.products;
create trigger products_before_insert
  before insert on public.products
  for each row execute function public.products_before_insert();

-- ---------------------------------------------------------------------
-- 4. RLS (reemplaza TODAS las políticas de profiles y products)
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.products enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
     where schemaname = 'public' and tablename in ('profiles', 'products')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles: cada quien ve y edita solo lo suyo; el rol NO se puede cambiar desde el cliente
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

create policy profiles_insert_own on public.profiles
  for insert with check (id = auth.uid() and role = 'consumer');

create policy profiles_update_own on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select p.role from public.profiles p where p.id = auth.uid()));

-- products: públicas solo las disponibles y vigentes; el dueño y el que reservó ven la suya
create policy products_select on public.products
  for select using (
    (status = 'AVAILABLE' and (expires_at is null or expires_at > now()))
    or user_id = auth.uid()
    or reserved_by = auth.uid()
  );

create policy products_insert_merchant on public.products
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'merchant')
  );

-- Solo se puede borrar lo que aún nadie reservó (no hay políticas de UPDATE: lo hacen las funciones)
create policy products_delete_own_available on public.products
  for delete using (user_id = auth.uid() and status = 'AVAILABLE');

-- ---------------------------------------------------------------------
-- 5. Storage: buckets públicos + políticas por carpeta (userId/archivo)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-images', 'product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('avatars',        'avatars',        true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (coalesce(qual, '') ilike '%product-images%' or coalesce(with_check, '') ilike '%product-images%'
            or coalesce(qual, '') ilike '%avatars%'       or coalesce(with_check, '') ilike '%avatars%')
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

create policy "aprovechaya_images_read" on storage.objects
  for select using (bucket_id in ('product-images', 'avatars'));

create policy "aprovechaya_images_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('product-images', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "aprovechaya_images_update_own" on storage.objects
  for update to authenticated
  using (bucket_id in ('product-images', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);

create policy "aprovechaya_images_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id in ('product-images', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------
-- 6. RPC: el comercio confirma que el cliente recogió el producto
-- ---------------------------------------------------------------------
create or replace function public.mark_product_picked_up(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.products
     set status = 'SOLD'
   where id::text = p_id and user_id = auth.uid() and status = 'RESERVED';
  if not found then
    raise exception 'No se pudo marcar: la oferta no está reservada o no es tuya';
  end if;
end;
$$;

revoke all on function public.mark_product_picked_up(text) from public, anon;
grant execute on function public.mark_product_picked_up(text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Limpieza de ofertas vencidas (opcional, vía pg_cron)
-- ---------------------------------------------------------------------
drop function if exists public.cleanup_expired_products();
create or replace function public.cleanup_expired_products()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.products set status = 'EXPIRED'
   where status = 'AVAILABLE' and expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.cleanup_expired_products() from public, anon, authenticated;

-- Para programarla cada hora (requiere habilitar la extensión pg_cron):
-- select cron.schedule('cleanup-expired-products', '0 * * * *', 'select public.cleanup_expired_products();');

-- ---------------------------------------------------------------------
-- 8. Índice y Realtime
-- ---------------------------------------------------------------------
create index if not exists idx_products_available_expires
  on public.products (expires_at) where status = 'AVAILABLE';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products'
  ) then
    alter publication supabase_realtime add table public.products;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- OPCIONAL: borrar productos de prueba antiguos con imagen base64 (pesan cientos de KB)
-- delete from public.products where image_url like 'data:%';
-- ---------------------------------------------------------------------
