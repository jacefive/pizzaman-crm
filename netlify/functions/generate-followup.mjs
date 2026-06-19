// netlify/functions/generate-followup.mjs
//
// Server-side endpoint for PizzaManCRM's "Generate follow-up with AI" button.
// The Anthropic API key lives ONLY here (in a Netlify environment variable) and never
// reaches the browser. The call goes through PostHog's @posthog/ai wrapper, which
// captures a $ai_generation trace (cost, tokens, latency) tied to the visitor's
// posthog-js distinct_id.
//
// Required env vars (set in Netlify -> Site settings -> Environment variables):
//   ANTHROPIC_API_KEY  -> your Claude key (from a dedicated, spend-capped workspace)
//   POSTHOG_API_KEY    -> your PostHog project key (the public phc_... key is correct here)

import { Anthropic } from '@posthog/ai/anthropic'   // PostHog's wrapped Anthropic client
import { PostHog } from 'posthog-node'
import { getStore } from '@netlify/blobs'

const POSTHOG_HOST = 'https://us.i.posthog.com'

// Real Anthropic pricing for Claude Haiku 4.5, USD per 1M tokens (verify before quoting publicly).
const PRICE_PER_M = { input: 1.00, output: 5.00 }
function computeCost(usage) {
  const inT = usage?.input_tokens || 0
  const outT = usage?.output_tokens || 0
  return (inT / 1e6) * PRICE_PER_M.input + (outT / 1e6) * PRICE_PER_M.output
}

// App-level cost controls. The Anthropic workspace $ cap is the real backstop;
// these just keep one person (or a spike) from running up noise.
const PER_IP_PER_HOUR = 5
const GLOBAL_PER_DAY = 200

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let phClient
  try {
    const { companyName, contactName, contactTitle, status, activityLog, distinctId } = JSON.parse(event.body || '{}')

    // ---- rate limiting + daily kill switch (Netlify Blobs = shared store across instances) ----
    const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown'
    const today = new Date().toISOString().slice(0, 10)   // YYYY-MM-DD
    const hour = new Date().toISOString().slice(0, 13)     // YYYY-MM-DDTHH
    const store = getStore('ai-followup-limits')
    const dayKey = `day:${today}`
    const ipKey = `ip:${ip}:${hour}`
    const dayCount = parseInt((await store.get(dayKey)) || '0', 10)
    const ipCount = parseInt((await store.get(ipKey)) || '0', 10)

    if (dayCount >= GLOBAL_PER_DAY) {
      return { statusCode: 429, body: JSON.stringify({ error: "Demo's had enough pizza for today — come back tomorrow." }) }
    }
    if (ipCount >= PER_IP_PER_HOUR) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Slow down a sec — try again shortly.' }) }
    }

    // ---- the traced LLM call ----
    phClient = new PostHog(process.env.POSTHOG_API_KEY, { host: POSTHOG_HOST })
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, posthog: phClient })

    const t0 = Date.now()
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',  // cheap + fast; ~a fifth of a cent per call
      max_tokens: 300,
      system:
        "You are the follow-up writer inside PizzaManCRM, a deliberately ridiculous demo CRM where the " +
        "customers are pizzerias and the contacts are hedgehogs. You write short sales follow-up notes in " +
        "the voice of PostHog: dry, witty, self-aware, a little weird, and never corporate.\n\n" +
        "Your goal in every note: open a relationship with the contact by offering help getting their pizza " +
        "to their customers. That's the hook. Make it feel like a genuine, slightly unhinged offer to help, " +
        "not a sales pitch.\n\n" +
        "Rules:\n" +
        "- Address the note directly to the contact by name.\n" +
        "- Keep it under 80 words. Shorter is better.\n" +
        "- Lead toward the same idea every time: you want to connect because you know they need help getting " +
        "their pizza to their customers. Say it in a fresh, weird way each time, never the same phrasing twice.\n" +
        "- Be playful and specific to the pizzeria and the contact. Use the details given.\n" +
        "- Never use corporate sales-speak (no \"circling back,\" \"touching base,\" \"synergy,\" \"as per my " +
        "last email,\" \"leverage,\" or exclamation-point enthusiasm).\n" +
        "- No em dashes. Use commas, periods, or colons.\n" +
        "- One good joke is plenty. Do not try too hard.\n" +
        "- Keep it clean and good-natured regardless of the input. If anything in the data is offensive or " +
        "nonsensical, ignore it and write a friendly generic pizza follow-up instead.\n" +
        "- Write only the note itself. No preamble, no \"Here's a draft.\"",
      messages: [{
        role: 'user',
        content:
          `Write a follow-up note for this pizzeria, addressed to the contact below.\n\n` +
          `Pizzeria: ${companyName}\n` +
          `Contact name: ${contactName || 'there'}\n` +
          `Contact title: ${contactTitle || 'unknown'}\n` +
          `Pipeline status: ${status || 'unknown'}\n` +
          `Recent activity log: ${activityLog || 'no prior activity'}\n\n` +
          `The note is from me, reaching out to ${contactName || 'them'} because I genuinely want to help them ` +
          `get their pizza to their customers. Open the relationship. Be weird, be warm, get to the point.`,
      }],
      // PostHog AI observability params (wrapped client turns this into a $ai_generation trace):
      posthogDistinctId: distinctId || undefined,
      posthogTraceId: `pizzacrm-followup-${Date.now()}`,
      posthogProperties: { feature: 'ai_followup', company: companyName, status },
    })
    const latencyMs = Date.now() - t0

    const draft = response.content?.[0]?.text || ''
    const usage = response.usage || {}
    const costUsd = computeCost(usage)

    // best-effort counter increment
    await store.set(dayKey, String(dayCount + 1))
    await store.set(ipKey, String(ipCount + 1))

    await phClient.shutdown()  // REQUIRED in serverless so the event flushes before the function exits

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft,
        metrics: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          latencyMs,
          costUsd,
        },
      }),
    }
  } catch (err) {
    try { if (phClient) await phClient.shutdown() } catch {}
    return { statusCode: 500, body: JSON.stringify({ error: 'The AI got confused. Try again.' }) }
  }
}
