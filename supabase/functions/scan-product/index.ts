import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { corsHeaders, json } from "../_shared/cors.ts"
import { adminClient, getUserFromRequest } from "../_shared/auth.ts"

const MODEL = Deno.env.get('GROQ_MODEL') || 'qwen/qwen3.8-27b'
const MAX_IMAGES = 5
const MAX_IMAGE_CHARS = 4_000_000
const PACKAGING_TYPES = ['EMPAQUETADO', 'SIN_EMPAQUE']
const CONDITIONS = ['BUENO', 'REGULAR', 'MALO']

function parseGroqResponse(content: string): Record<string, unknown> | null {
  // Algunos modelos razonadores devuelven <think>...</think> antes del JSON
  const clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json|```/g, '').trim()
  try { return JSON.parse(clean) } catch (_) { /* se intenta extraer el objeto */ }
  const match = clean.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch (_) { return null }
  }
  return null
}

const oneOf = (v: unknown, allowed: string[], fallback: string) => {
  const s = String(v ?? '').toUpperCase().trim()
  return allowed.includes(s) ? s : fallback
}
const toBool = (v: unknown) => v === true || String(v).toLowerCase() === 'true'
const round2 = (n: number) => Math.round(n * 100) / 100

function guessMime(b64: string): string {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { error: 'Método no permitido' }, 405)

  try {
    // 1) Solo usuarios con sesión y cuenta de Comercio pueden gastar cuota de IA
    const admin = adminClient()
    const user = await getUserFromRequest(req, admin)
    if (!user) return json(req, { error: 'Debes iniciar sesión.' }, 401)

    const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (profile?.role !== 'merchant') {
      return json(req, { error: 'Solo las cuentas de Comercio pueden analizar productos.' }, 403)
    }

    const apiKey = Deno.env.get('GROQ_API_KEY')
    if (!apiKey) {
      console.error('GROQ_API_KEY no configurada')
      return json(req, { error: 'El servicio de IA no está configurado.' }, 500)
    }

    // 2) Validar imágenes
    const body = await req.json().catch(() => ({}))
    const raw: unknown[] = Array.isArray(body.base64Images) ? body.base64Images : (body.base64Image ? [body.base64Image] : [])
    if (raw.length === 0) return json(req, { error: 'No se proporcionaron imágenes.' }, 400)
    if (raw.length > MAX_IMAGES) return json(req, { error: `Máximo ${MAX_IMAGES} imágenes.` }, 400)

    const imageUrls: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0 || item.length > MAX_IMAGE_CHARS) {
        return json(req, { error: 'Imagen inválida o demasiado grande.' }, 400)
      }
      imageUrls.push(item.startsWith('data:image/') ? item : `data:${guessMime(item)};base64,${item}`)
    }

    const now = new Date().toISOString()
    const prompt = `Fecha y hora actual (UTC): ${now}.
Analiza las imágenes de este producto alimenticio y responde SOLO con un objeto JSON válido (sin markdown, sin texto extra) con estas claves:
- product_name: nombre corto del producto (string)
- expiration_hours: horas hasta el vencimiento (número entero). Si ves una fecha de vencimiento impresa, calcula las horas desde la fecha actual. Si no hay fecha visible, estima por tipo de producto y estado.
- original_price: precio normal estimado en USD, sin descuento (número)
- suggested_price: precio sugerido con descuento en USD (número, menor que original_price)
- packaging_type: "EMPAQUETADO" o "SIN_EMPAQUE" (frutas/verduras sueltas, pan suelto, granel)
- packaging_condition: "BUENO", "REGULAR" o "MALO" (estado del PRODUCTO si no tiene empaque)
- safety_risk: true/false

REGLAS:
- safety_risk = true SOLO si hay moho visible, descomposición/putrefacción, líquidos sospechosos, plagas o empaque que exponga el alimento a contaminación visible.
- Un producto sin empaque pero fresco NO es riesgo sanitario.
- Si no estás seguro del precio, usa una estimación razonable para El Salvador en USD.`

    const payload: Record<string, unknown> = {
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      }],
      temperature: 0.1,
      max_tokens: 1000,
    }
    const effort = Deno.env.get('GROQ_REASONING_EFFORT')
    if (effort) payload.reasoning_effort = effort

    // 3) Llamar a Groq
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
    })
    const groqData = await groqResponse.json().catch(() => ({}))

    if (!groqResponse.ok) {
      console.error('Groq API error:', groqResponse.status, JSON.stringify(groqData).slice(0, 500))
      const status = groqResponse.status === 429 ? 429 : 502
      return json(req, { error: groqResponse.status === 429
        ? 'La IA está saturada. Intenta de nuevo en unos segundos.'
        : 'La IA no pudo procesar la solicitud. Intenta de nuevo.' }, status)
    }

    const content: string | undefined = groqData.choices?.[0]?.message?.content
    if (!content) {
      console.error('Respuesta vacía de Groq:', JSON.stringify(groqData).slice(0, 500))
      return json(req, { error: 'La IA devolvió una respuesta vacía.' }, 502)
    }

    const parsed = parseGroqResponse(content)
    if (!parsed) {
      console.error('No se pudo parsear la respuesta de IA:', content.slice(0, 300))
      return json(req, { error: 'No se pudo interpretar la respuesta de la IA.' }, 502)
    }

    const packagingType = oneOf(parsed.packaging_type, PACKAGING_TYPES, 'EMPAQUETADO')
    const packagingCondition = oneOf(parsed.packaging_condition, CONDITIONS, 'REGULAR')

    // 4) Rechazo por seguridad alimentaria (respuesta 200 con rejected=true)
    if (toBool(parsed.safety_risk)) {
      return json(req, {
        rejected: true,
        error: 'PRODUCTO_NO_APTO',
        message: 'El producto presenta riesgos para la salud (moho, descomposición o contaminación). No puede publicarse.',
        packaging_type: packagingType,
        packaging_condition: packagingCondition,
      })
    }

    // 5) Normalizar y validar lo que devuelve la IA
    const hours = Math.min(72, Math.max(1, Math.round(Number(parsed.expiration_hours)) || 12))
    const suggested = round2(Math.min(1000, Math.max(0.5, Number(parsed.suggested_price) || 0.5)))
    let original = Number(parsed.original_price)
    if (!(original > suggested) || original > 5000) original = round2(suggested * 1.5)

    return json(req, {
      product_name: String(parsed.product_name ?? '').trim().slice(0, 120) || 'Producto',
      expiration_hours: hours,
      original_price: round2(original),
      suggested_price: suggested,
      urgency: hours < 6 ? 'ALTA' : hours <= 24 ? 'MEDIA' : 'BAJA',
      packaging_type: packagingType,
      packaging_condition: packagingCondition,
    })
  } catch (error) {
    console.error('scan-product error:', error)
    return json(req, { error: 'Error interno del escáner.' }, 500)
  }
})
