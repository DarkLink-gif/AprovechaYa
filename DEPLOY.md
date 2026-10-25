# AprovechaYa — Guía de despliegue de las correcciones

## 1. Base de datos (obligatorio, una sola vez)
Supabase → **SQL Editor** → pega y ejecuta `supabase/migrations/04_rls_and_fixes.sql`.
Es idempotente. ⚠️ **Reemplaza todas las políticas RLS** de `profiles`, `products` y de los buckets
`product-images` / `avatars` por las nuevas. (Las migraciones 01–03 quedan cubiertas por la 04.)

Opcional: borra los productos de prueba viejos con imagen base64 (descomenta la última línea del SQL).

## 2. Auth
Authentication → **URL Configuration**:
- Site URL: `http://localhost:8000`
- Redirect URLs: `http://localhost:8000/**` (agrega aquí tu dominio real cuando publiques)

Para pruebas rápidas puedes desactivar *Confirm email*; con confirmación activa, la foto se sube
después del primer login (o desde Mi Perfil).

## 3. Secrets (Edge Functions → Secrets)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GROQ_API_KEY`.
Opcional: `ALLOWED_ORIGINS` (lista separada por comas; por defecto incluye localhost:8000/3000/5500),
`GROQ_MODEL`, `GROQ_REASONING_EFFORT`.
`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solos. La etiqueta "Deprecated"
del service_role **no hace falta resetearla** para que esto funcione.

## 4. Desplegar las 3 funciones
```
supabase functions deploy scan-product --no-verify-jwt
supabase functions deploy create-checkout-session --no-verify-jwt
supabase functions deploy stripe-webhook --no-verify-jwt
```
Las tres validan por su cuenta (JWT del usuario o firma de Stripe). `stripe-webhook` DEBE llevar
`--no-verify-jwt`: Stripe no envía JWT de Supabase.

## 5. Webhook en Stripe
Dashboard → Developers → Webhooks → endpoint:
`https://nfrhomsdzrvjhpzjfpvd.supabase.co/functions/v1/stripe-webhook`
Eventos: `checkout.session.completed` y `payment_intent.succeeded`.
Copia el *Signing secret* (`whsec_...`) a `STRIPE_WEBHOOK_SECRET`.
Revisa "Recent deliveries": deben responder 200.

## 6. Git
```
git rm -r --cached supabase/.temp
git add .gitignore && git commit -m "fix: seguridad, checkout, RLS, IA"
```

## 7. Prueba end-to-end
1. Registrar cuenta **Comercio** → confirmar correo → login → el sidebar debe decir `merchant` y tu nombre.
2. "+" → subir 2 fotos (la X de cada miniatura funciona) → Analizar con IA → autocompleta.
3. Foto con moho → debe **bloquear** Publicar.
4. Publicar → aparece en Explorar. En "Mis Publicaciones" lo ves aunque ya esté reservado.
5. Cuenta **Consumidor** → Reservar y pagar (tarjeta `4242 4242 4242 4242`) → vuelve, "Confirmando…" y queda RESERVED.
6. Comercio → "Marcar como recogido" → SOLD.
