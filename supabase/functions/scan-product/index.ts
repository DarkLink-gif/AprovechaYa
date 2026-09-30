import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function parseGroqResponse(content) {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const base64Images = body.base64Images || (body.base64Image ? [body.base64Image] : [])
    const apiKey = Deno.env.get('GROQ_API_KEY')

    console.log("=== scan-product START ===");
    console.log("Number of images:", base64Images.length);
    console.log("GROQ_API_KEY exists:", !!apiKey);

    if (!apiKey) {
      console.error("ERROR: GROQ_API_KEY no configurada");
      return new Response(
        JSON.stringify({ error: "La API Key 'GROQ_API_KEY' no está configurada en los Secretos de Supabase." }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (base64Images.length === 0) {
      return new Response(
        JSON.stringify({ error: "No se proporcionaron imágenes" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (base64Images.length > 5) {
      return new Response(
        JSON.stringify({ error: "Máximo 5 imágenes permitidas" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const imageUrls = base64Images.map(base64Image => {
      let imageUrl = base64Image;
      if (base64Image && !base64Image.startsWith('data:')) {
        let mimeType = 'image/jpeg';
        if (base64Image.startsWith('iVBORw0KGgo')) mimeType = 'image/png';
        else if (base64Image.startsWith('UklGR')) mimeType = 'image/webp';
        imageUrl = `data:${mimeType};base64,${base64Image}`;
      }
      return imageUrl;
    });

    const prompt = `Analiza las imágenes de este producto alimenticio. Evalúa:
1. Nombre del producto (product_name)
2. Horas estimadas hasta vencimiento (expiration_hours, número)
3. Precio sugerido con descuento en USD (suggested_price, número)
4. Urgencia: "ALTA" (vence en <6h), "MEDIA" (6-24h), "BAJA" (>24h)
5. Tipo de empaque: "EMPAQUETADO", "SIN_EMPAQUE" (frutas/verduras sueltas, panadería sin bolsa, granel, etc.)
6. Condición: "BUENO", "REGULAR", "MALO" (evalúa el estado del PRODUCTO, no del empaque si no tiene)
7. Riesgo sanitario: true/false (moho, descomposición, signos de putrefacción, olor visible, plagas)

REGLAS CLAVE:
- Si el producto NO TIENE EMPAQUE (frutas, verduras, pan suelto, granel): packaging_type = "SIN_EMPAQUE" y evalúa condición del PRODUCTO en sí.
- SOLO safety_risk = true si hay: moho visible, descomposición/putrefacción, líquidos sospechosos, plagas, olor visible a podrido.
- Un producto sin empaque pero FRESCO (manzana sana, pan fresco, verduras crujientes) NO es riesgo sanitario.
- Empaque roto/sucio SOLO es riesgo si expone el alimento a contaminación visible.

Devuelve ÚNICAMENTE un objeto JSON válido con: product_name, expiration_hours, suggested_price, urgency, packaging_type, packaging_condition, safety_risk (boolean). Sin markdown, sin texto extra.`;

    console.log("Calling Groq API with", imageUrls.length, "images...");
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen/qwen3.8-27b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...imageUrls.map(url => ({ type: "image_url", image_url: { url } }))
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    })

    console.log("Groq response status:", groqResponse.status);
    const groqData = await groqResponse.json()
    console.log("Groq response data:", JSON.stringify(groqData).substring(0, 500));

    if (!groqResponse.ok) {
      console.error("Groq API error:", groqData);
      return new Response(
        JSON.stringify({ error: groqData.error?.message || "Error al comunicarse con la API de Groq", groqStatus: groqResponse.status }),
        { status: groqResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const content = groqData.choices?.[0]?.message?.content;
    console.log("Groq content:", content);
    if (!content) {
      return new Response(
        JSON.stringify({ error: "Respuesta vacía de Groq" }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const parsed = parseGroqResponse(content);
    console.log("Parsed result:", parsed);
    if (!parsed) {
      return new Response(
        JSON.stringify({ error: "No se pudo parsear la respuesta de la IA", rawContent: content }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const required = ['product_name', 'expiration_hours', 'suggested_price', 'urgency', 'packaging_type', 'packaging_condition', 'safety_risk'];
    for (const field of required) {
      if (!(field in parsed)) {
        console.error("Missing field:", field, "in parsed:", parsed);
        return new Response(
          JSON.stringify({ error: `Campo faltante en respuesta IA: ${field}`, parsed }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    if (parsed.safety_risk === true) {
      return new Response(
        JSON.stringify({ 
          error: "PRODUCTO_NO_APTO",
          message: "El producto presenta riesgos para la salud (moho, descomposición, signos de putrefacción). No puede publicarse.",
          safety_risk: true,
          packaging_type: parsed.packaging_type,
          packaging_condition: parsed.packaging_condition
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        product_name: parsed.product_name,
        expiration_hours: Number(parsed.expiration_hours) || 12,
        suggested_price: Number(parsed.suggested_price) || 0,
        urgency: parsed.urgency || 'MEDIA',
        packaging_type: parsed.packaging_type || 'EMPAQUETADO',
        packaging_condition: parsed.packaging_condition
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error("scan-product catch error:", error);
    return new Response(
      JSON.stringify({ error: error.message, stack: error.stack }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function parseGroqResponse(content) {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}