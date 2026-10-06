-- =====================================================================
-- SQL PARA FIXEAR EXPIRACIÓN REAL DE PRODUCTOS
-- Ejecutar en Supabase Dashboard → SQL Editor
-- =====================================================================

-- 1. Agregar columna expires_at (timestamp con zona horaria)
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- 2. Actualizar expires_at existente basado en created_at + expiration_hours
UPDATE public.products 
SET expires_at = created_at + (expiration_hours || ' hours')::interval
WHERE expires_at IS NULL;

-- 3. Trigger para actualizar expires_at automáticamente al insertar/actualizar
CREATE OR REPLACE FUNCTION public.update_expires_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET SEARCH_PATH = PUBLIC
AS $$
BEGIN
  NEW.expires_at = NEW.created_at + (NEW.expiration_hours || ' hours')::interval;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_products_expires_at ON public.products;
CREATE TRIGGER update_products_expires_at
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_expires_at();

-- 4. Índice para consultas eficientes de productos vigentes
CREATE INDEX IF NOT EXISTS idx_products_expires_at 
ON public.products (expires_at) 
WHERE status = 'AVAILABLE';

-- 5. Función para limpiar productos expirados (ejecutar via cron job)
CREATE OR REPLACE FUNCTION public.cleanup_expired_products()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET SEARCH_PATH = PUBLIC
AS $$
BEGIN
  UPDATE public.products 
  SET status = 'EXPIRED' 
  WHERE status = 'AVAILABLE' 
    AND expires_at < now();
  
  RAISE NOTICE 'Productos expirados marcados: %', ROW_COUNT;
END;
$$;

-- =====================================================================
-- NOTAS:
-- - Ejecutar cleanup_expired_products() via pg_cron cada hora:
--   SELECT cron.schedule('cleanup-expired-products', '0 * * * *', 'SELECT public.cleanup_expired_products();');
-- - En el frontend, filtrar por expires_at > now() en lugar de solo status
-- =====================================================================