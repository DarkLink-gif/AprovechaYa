-- =====================================================================
-- SQL PARA FIXEAR REGISTRO CON EMAIL CONFIRMATION + TRIGGER DE PERFIL
-- Ejecutar en Supabase Dashboard → SQL Editor
-- =====================================================================

-- 1. Trigger function para crear perfil automáticamente al registrarse
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'Usuario'),
    coalesce(new.raw_user_meta_data->>'role', 'consumer'),
    null
  );
  return new;
end;
$$;

-- 2. Trigger que se ejecuta al insertar en auth.users
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Permitir que usuarios actualicen su propio perfil (incluyendo avatar_url)
-- Asegurar que RLS permita UPDATE en profiles
-- (Las policies de INSERT/SELECT/UPDATE en profiles ya deberían existir)

-- 4. Habilitar realtime para profiles si se quiere notificar cambios
-- alter publication supabase_realtime add table profiles;

-- =====================================================================
-- NOTAS:
-- - El trigger usa raw_user_meta_data que se pasa en signUp({data: {...}})
-- - full_name y role vienen del formulario de registro
-- - avatar_url se deja null inicialmente; se actualiza tras login
-- - El trigger usa SECURITY DEFINER para poder insertar en profiles
-- =====================================================================