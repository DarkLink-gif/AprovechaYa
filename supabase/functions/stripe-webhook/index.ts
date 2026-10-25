import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno"
import { adminClient, type AdminClient } from "../_shared/auth.ts"

// Desplegar con:  supabase functions deploy stripe-webhook --no-verify-jwt
// (Stripe no envía JWT de Supabase; la autenticidad se valida con la firma de Stripe.)

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})
const cryptoProvider = Stripe.createSubtleCryptoProvider()

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const signature = req.headers.get('stripe-signature')
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!signature || !webhookSecret) {
    return new Response(JSON.stringify({ error: 'Falta la firma o el secreto del webhook' }), { status: 400 })
  }

  const body = await req.text()
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider)
  } catch (err) {
    console.error('Firma del webhook inválida:', (err as Error).message)
    return new Response(JSON.stringify({ error: 'Firma inválida' }), { status: 400 })
  }

  try {
    const admin = adminClient()

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.payment_status === 'paid') {
        const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
        await reserveAfterPayment(admin, session.metadata?.productId, session.metadata?.userId, pi)
      }
    } else if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent
      await reserveAfterPayment(admin, pi.metadata?.productId, pi.metadata?.userId, pi.id)
    }

    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    // 500 => Stripe reintenta el webhook más tarde
    console.error('Error procesando webhook:', error)
    return new Response(JSON.stringify({ error: 'Error interno' }), { status: 500 })
  }
})

// Idempotente: se puede llamar varias veces con el mismo pago.
async function reserveAfterPayment(
  admin: AdminClient,
  productId: string | undefined,
  userId: string | undefined,
  paymentIntentId: string | undefined,
) {
  if (!productId || !userId) return

  // Reserva atómica: solo si sigue disponible
  const { data: updated, error } = await admin
    .from('products')
    .update({ status: 'RESERVED', reserved_by: userId })
    .eq('id', productId)
    .eq('status', 'AVAILABLE')
    .select('id')
  if (error) throw error
  if (updated && updated.length > 0) {
    console.log(`Producto ${productId} reservado por ${userId}`)
    return
  }

  // No se pudo reservar: ¿ya es de este mismo usuario (evento duplicado)?
  const { data: current } = await admin.from('products').select('reserved_by').eq('id', productId).maybeSingle()
  if (current?.reserved_by === userId) return

  // Otro usuario ganó la carrera (o el producto ya no existe): reembolsar
  console.warn(`Producto ${productId} no disponible; reembolsando pago de ${userId}`)
  if (paymentIntentId) {
    try {
      await stripe.refunds.create({ payment_intent: paymentIntentId })
    } catch (e) {
      console.error('No se pudo reembolsar (¿ya reembolsado?):', (e as Error).message)
    }
  }
}
