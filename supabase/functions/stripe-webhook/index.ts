import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || 'https://localhost:3000',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const signature = req.headers.get('stripe-signature')
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')

    if (!signature || !webhookSecret) {
      return new Response(
        JSON.stringify({ error: 'Missing stripe-signature or webhook secret' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const body = await req.text()
    let event: Stripe.Event

    try {
      // Use constructEventAsync with SubtleCryptoProvider for Deno compatibility
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message)
      return new Response(
        JSON.stringify({ error: 'Webhook signature verification failed' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Handle checkout.session.completed (legacy, but kept for compatibility)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      
      if (session.payment_status === 'paid') {
        await handleSuccessfulPayment(session.metadata?.productId, session.metadata?.userId, supabase)
      }
    }

    // Handle payment_intent.succeeded (more reliable for payment confirmation)
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent
      const productId = paymentIntent.metadata?.productId
      const userId = paymentIntent.metadata?.userId
      
      if (productId && userId) {
        await handleSuccessfulPayment(productId, userId, supabase)
      }
    }

    return new Response(
      JSON.stringify({ received: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function handleSuccessfulPayment(
  productId: string | undefined, 
  userId: string | undefined, 
  supabase: ReturnType<typeof createClient>
) {
  if (!productId || !userId) return

  // Atomic update: only reserve if still AVAILABLE
  const { data, error } = await supabase
    .from('products')
    .update({ 
      status: 'RESERVED', 
      reserved_by: userId 
    })
    .eq('id', productId)
    .eq('status', 'AVAILABLE')
    .select('id')
    .single()

  if (error) {
    console.error('Error updating product after payment:', error)
    // Don't return error to Stripe - we already acknowledged the webhook
    // Log for manual review
    console.error(`Failed to reserve product ${productId} for user ${userId}:`, error)
    return
  }

  if (!data) {
    console.warn(`Product ${productId} was already reserved/sold (race condition)`)
    return
  }

  console.log(`Product ${productId} reserved by user ${userId} after successful payment`)
}