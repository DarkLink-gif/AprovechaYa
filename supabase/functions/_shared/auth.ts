import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Cliente con service role: salta RLS. Solo usar dentro de Edge Functions.
export function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

export type AdminClient = ReturnType<typeof adminClient>

// Valida el JWT del usuario que llama a la función. Devuelve null si no es válido.
export async function getUserFromRequest(req: Request, admin: AdminClient) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) return null
  return data.user
}
