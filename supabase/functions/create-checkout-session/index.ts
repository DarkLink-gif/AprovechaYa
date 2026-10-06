import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || 'https://localhost:3000',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || 'http://localhost:8000,http://localhost:3000,http://127.0.0.1:5500').split(',')

function validateOrigin(origin: string | null): boolean {
  if (!origin) return false
  return ALLOWED_ORIGINS.includes(origin)
}

function createErrorResponse(message: string, status: number) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Validate Origin header
  const origin = req.headers.get('origin')
  if (!validateOrigin(origin)) {
    return createErrorResponse('Origin not allowed', 403)
  }

  try {
    // Create Supabase client with user's JWT for auth validation
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return createErrorResponse('Missing authorization header', 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    // Get authenticated user from JWT
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return createErrorResponse('Invalid or expired token', 401)
    }

    const { productId } = await req.json()
    if (!productId) {
      return createErrorResponse('Missing productId', 400)
    }

    // Validate userId matches authenticated user (ignore body userId)
    const requestUserId = (await req.json()).userId
    if (requestUserId && requestUserId !== user.id) {
      return createErrorResponse('User ID mismatch', 403)
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
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Corrección de la columna: discount_price
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
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return createErrorResponse(error.message, 400)
  }
})