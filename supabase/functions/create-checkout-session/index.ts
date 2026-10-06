import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:8000,http://localhost:3000,http://127.0.0.1:5500').split(',')

function getCorsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : (Deno.env.get('ALLOWED_ORIGIN') || 'https://localhost:3000')
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  }
}

function createErrorResponse(message: string, status: number, origin: string | null) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { ...getCorsHeaders(origin), 'Content-Type': 'application/json' } }
  )
}

function getCorsHeaders(origin: string | null) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : (Deno.env.get('ALLOWED_ORIGIN') || 'https://localhost:3000')
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  }
}

serve(async (req) => {
  const origin = req.headers.get('origin')
  const corsHeaders = getCorsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Validate Origin header
  const originHeader = req.headers.get('origin')
  if (!originHeader || !ALLOWED_ORIGINS.includes(originHeader)) {
    return createErrorResponse('Origin not allowed', 403, originHeader)
  }

  try {
    // Create Supabase client with user's JWT for auth validation
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return createErrorResponse('Missing authorization header', 401, originHeader)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    // Get authenticated user from JWT
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return createErrorResponse('Invalid or expired token', 401, originHeader)
    }

    const { productId } = await req.json()
    if (!productId) {
      return createErrorResponse('Missing productId', 400, originHeader)
    }

    // Validate userId matches authenticated user (ignore body userId)
    const body = await req.json()
    const requestUserId = body.userId
    if (requestUserId && requestUserId !== user.id) {
      return createErrorResponse('User ID mismatch', 403, originHeader)
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: prodError } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', productId)
      .single()

    if (prodError || !product) {
      throw new Error("Producto no encontrado en la base de datos")
    }

    // Validate product is available and not expired
    if (product.status !== 'AVAILABLE') {
      throw new Error("El producto no está disponible para reserva")
    }

    if (product.expires_at && new Date(product.expires_at) < new Date()) {
      throw new Error("El producto ha expirado")
    }

    // Validate minimum price for Stripe ($0.50 minimum)
    const priceInCents = Math.round(Number(product.discount_price) * 100)
    if (isNaN(priceInCents) || priceInCents < 50) {
      throw new Error("El precio mínimo es $0.50")
    }

    // For donations, use atomic update with status check
    if (product.is_donation === true) {
      const { data, error: updError } = await supabaseAdmin
        .from('products')
        .update({ status: 'RESERVED', reserved_by: user.id })
        .eq('id', productId)
        .eq('status', 'AVAILABLE')
        .select('id')
        .single()

      if (updError || !data) {
        throw new Error("El producto ya no está disponible")
      }

      const redirectUrl = `${origin}/?status=success&product_id=${productId}&donation=true`
      return new Response(
        JSON.stringify({ url: redirectUrl, donation: true }),
        { headers: { ...getCorsHeaders(originHeader), 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Validate minimum price for Stripe ($0.50 minimum)
    const priceInCents = Math.round(Number(product.discount_price) * 100)

    if (isNaN(priceInCents) || priceInCents < 50) {
      throw new Error("El precio mínimo es $0.50")
    }

    // Create Stripe Checkout session with atomic reservation
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: product.title || 'Reserva de Oferta',
              metadata: { product_id: productId }
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${origin}/?status=success&product_id=${productId}`,
      cancel_url: `${origin}/?status=cancelled`,
      metadata: { productId, userId: user.id },
      payment_intent_data: {
        metadata: { productId, userId: user.id }
      }
    })

    // Atomic reservation: mark as RESERVED only if still AVAILABLE
    const { data: reserved, error: reserveError } = await supabaseAdmin
      .from('products')
      .update({ status: 'RESERVED', reserved_by: user.id })
      .eq('id', productId)
      .eq('status', 'AVAILABLE')
      .select('id')
      .single()

    if (reserveError || !reserved) {
      // If reservation failed, don't create Stripe session
      throw new Error("El producto ya no está disponible")
    }

    return new Response(
      JSON.stringify({ url: session.url }),
      { headers: { ...getCorsHeaders(originHeader), 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return createErrorResponse(error.message, 400, originHeader)
  }
})