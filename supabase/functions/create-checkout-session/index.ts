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
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, userId } = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: prodError } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .single()

    if (prodError || !product) throw new Error("Producto no encontrado en la base de datos")

    // Si es donación, reservar directamente sin Stripe
    if (product.is_donation === true) {
      const { error: updError } = await supabase
        .from('products')
        .update({ status: 'RESERVED', reserved_by: userId })
        .eq('id', productId)

      if (updError) throw new Error("Error al reservar donación: " + updError.message)

      const origin = req.headers.get('origin') || ''
      return new Response(
        JSON.stringify({ 
          url: `${origin}/?status=success&product_id=${productId}&donation=true`,
          donation: true 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Corrección de la columna: discount_price
    const priceInCents = Math.round(Number(product.discount_price) * 100)

    if (isNaN(priceInCents) || priceInCents <= 0) {
      throw new Error("El precio del producto no es válido para Stripe.")
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: product.title || 'Reserva de Oferta',
            },
            unit_amount: priceInCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${req.headers.get('origin')}/?status=success&product_id=${productId}`,
      cancel_url: `${req.headers.get('origin')}/?status=cancelled`,
      metadata: { productId, userId },
    })

    return new Response(
      JSON.stringify({ url: session.url }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
