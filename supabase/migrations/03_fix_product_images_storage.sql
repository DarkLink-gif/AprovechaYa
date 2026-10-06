-- =====================================================================
-- SQL PARA MOVER IMÁGENES A SUPABASE STORAGE
-- Ejecutar en Supabase Dashboard → SQL Editor
-- =====================================================================

-- 1. Crear bucket para imágenes de productos (si no existe)
-- NOTA: Ejecutar esto en Dashboard → Storage → New bucket
-- Nombre: product-images | Público: NO (usar URLs firmadas)

-- 2. Agregar columna image_urls (array de URLs) a products
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS image_urls text[] DEFAULT '{}';

-- 3. Migrar datos existentes: convertir image_url (base64) a image_urls
-- NOTA: Esto requiere procesamiento en aplicación, no en SQL puro
-- Se hará vía script de migración en la app

-- 4. Hacer image_url nullable y eventualmente deprecada
ALTER TABLE public.products 
ALTER COLUMN image_url DROP NOT NULL;

-- 5. Policies para bucket product-images (ejecutar en Dashboard → Storage → Policies)
-- SELECT público para imágenes de productos disponibles
-- CREATE POLICY "Product images are publicly accessible" ON storage.objects
-- FOR SELECT USING (bucket_id = 'product-images');

-- INSERT para usuarios autenticados (sus propios productos)
-- CREATE POLICY "Users can upload product images" ON storage.objects
-- FOR INSERT WITH CHECK (
--   bucket_id = 'product-images' AND 
--   auth.uid()::text = (storage.foldername(name))[1]
-- );

-- UPDATE/DELETE para dueños
-- CREATE POLICY "Users can update own product images" ON storage.objects
-- FOR UPDATE USING (
--   bucket_id = 'product-images' AND 
--   auth.uid()::text = (storage.foldername(name))[1]
-- );
-- CREATE POLICY "Users can delete own product images" ON storage.objects
-- FOR DELETE USING (
--   bucket_id = 'product-images' AND 
--   auth.uid()::text = (storage.foldername(name))[1]
-- );

-- =====================================================================
-- NOTAS DE MIGRACIÓN:
-- 1. Crear bucket 'product-images' en Dashboard → Storage (Privado)
-- 2. Ejecutar policies arriba en Dashboard → Storage → Policies
-- 3. La app subirá imágenes a Storage y guardará URLs firmadas en image_urls[]
-- 4. image_url (base64) se mantendrá por compatibilidad pero se irá deprecando
-- =====================================================================