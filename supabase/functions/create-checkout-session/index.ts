import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno"
import { corsHeaders, json, returnBase } from "../_shared/cors.ts"
import { adminClient, getUserFromRequest } from "../_shared/auth.ts"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})

// Si es true, solo cuentas "charity" pueden reservar donaciones.
const DONATIONS_ONLY_FOR_CHARITY = false
const MIN_PRICE_CENTS = 50 // mínimo de Stripe en USD

class UserError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { error: 'Método no permitido' }, 405)

  try {
    const admin = adminClient()

    // 1) Identidad: SIEMPRE del JWT, nunca del body
    const user = await getUserFromRequest(req, admin)
    if (!user) throw new UserError('Debes iniciar sesión para reservar.', 401)

    const body = await req.json().catch(() => ({}))
    const productId = typeof body.productId === 'string' ? body.productId : ''
    if (!productId) throw new UserError('Falta el producto a reservar.')

    // 2) Validar el producto
    const { data: product } = await admin.from('products').select('*').eq('id', productId).maybeSingle()
    if (!product) throw new UserError('La oferta no existe.', 404)
    if (product.status !== 'AVAILABLE') throw new UserError('Esta oferta ya no está disponible.', 409)
    if (product.expires_at && new Date(product.expires_at).getTime() <= Date.now()) {
      throw new UserError('Esta oferta ya venció.', 409)
    }
    if (product.user_id === user.id) throw new UserError('No puedes reservar tu propia oferta.')

    const base = returnBase(req, body.returnUrl)
    const sep = base.includes('?') ? '&' : '?'

    // 3) Donación: reserva directa, atómica (solo si sigue AVAILABLE)
    if (product.is_donation === true) {
      if (DONATIONS_ONLY_FOR_CHARITY) {
        const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
        if (profile?.role !== 'charity') throw new UserError('Las donaciones son solo para instituciones benéficas.', 403)
      }
      const { data: reserved, error } = await admin
        .from('products')
        .update({ status: 'RESERVED', reserved_by: user.id })
        .eq('id', productId)
        .eq('status', 'AVAILABLE')
        .select('id')
      if (error) throw error
      if (!reserved || reserved.length === 0) throw new UserError('Esta oferta ya no está disponible.', 409)

      return json(req, { donation: true, url: `${base}${sep}status=success&product_id=${productId}&donation=true` })
    }

    // 4) Pago con Stripe. La reserva real la hace el webhook cuando el pago se confirma
    //    (así un checkout abandonado no bloquea el producto).
    const priceInCents = Math.round(Number(product.discount_price) * 100)
    if (!Number.isFinite(priceInCents) || priceInCents < MIN_PRICE_CENTS) {
      throw new UserError('El precio mínimo para pagar con tarjeta es $0.50.')
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: String(product.title || 'Reserva de oferta').slice(0, 120) },
          unit_amount: priceInCents,
        },
        quantity: 1,
      }],
      success_url: `${base}${sep}status=success&product_id=${productId}`,
      cancel_url: `${base}${sep}status=cancelled`,
      client_reference_id: user.id,
      metadata: { productId, userId: user.id },
      payment_intent_data: { metadata: { productId, userId: user.id } },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return json(req, { url: session.url })
  } catch (error) {
    if (error instanceof UserError) return json(req, { error: error.message }, error.status)
    console.error('create-checkout-session error:', error)
    return json(req, { error: 'No se pudo iniciar el pago. Intenta de nuevo.' }, 500)
  }
})
