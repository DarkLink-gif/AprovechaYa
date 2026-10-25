// Utilidades CORS compartidas por las Edge Functions.
// Secret opcional en Supabase: ALLOWED_ORIGINS = "https://tu-dominio.com,http://localhost:8000"
// (también se acepta el nombre antiguo ALLOWED_ORIGIN).

const DEFAULT_ORIGINS = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]

export function allowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') || Deno.env.get('ALLOWED_ORIGIN') || ''
  const list = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_ORIGINS
}

// Origen seguro: nunca se refleja un origen que no esté en la lista permitida.
export function safeOrigin(req: Request): string {
  const list = allowedOrigins()
  const origin = (req.headers.get('origin') || '').replace(/\/$/, '')
  return list.includes(origin) ? origin : list[0]
}

// URL base a la que Stripe devuelve al usuario. Solo se acepta si su origen está permitido.
export function returnBase(req: Request, returnUrl?: unknown): string {
  try {
    if (typeof returnUrl === 'string' && returnUrl) {
      const u = new URL(returnUrl)
      if (allowedOrigins().includes(u.origin)) return `${u.origin}${u.pathname}`
    }
  } catch (_) { /* URL inválida: se usa el origen seguro */ }
  return `${safeOrigin(req)}/`
}

export function corsHeaders(req: Request) {
  return {
    'Access-Control-Allow-Origin': safeOrigin(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}
