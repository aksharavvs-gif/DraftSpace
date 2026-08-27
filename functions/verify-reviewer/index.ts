import { createRemoteJWKSet, jwtVerify } from 'https://cdn.jsdelivr.net/npm/jose@4.14.4/+esm'

// Supabase Edge Function to verify Firebase ID token and check reviewers table.
// Required environment variables (set in Supabase Edge Function secrets):
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - FIREBASE_PROJECT_ID
// - ALLOWED_ORIGINS (optional)

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '')

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))

async function verifyIdToken(idToken: string) {
  if (!FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID not configured')

  const issuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`

  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer,
    audience: FIREBASE_PROJECT_ID,
  })

  // payload.sub is the Firebase UID
  return payload
}

export default async function handler(req: Request) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGINS || '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      })
    }

    const origin = req.headers.get('origin') || ''
    const allowedOriginHeader = ALLOWED_ORIGINS ? ALLOWED_ORIGINS : '*'

    const body = await req.json().catch(() => null)
    let idToken = body?.idToken

    // support Authorization: Bearer <token>
    if (!idToken) {
      const authHeader = req.headers.get('authorization') || ''
      if (authHeader.toLowerCase().startsWith('bearer ')) {
        idToken = authHeader.slice(7).trim()
      }
    }

    if (!idToken) {
      return new Response(JSON.stringify({ error: 'Missing idToken' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
      })
    }

    // Verify token
    let payload: any
    try {
      const verified = await verifyIdToken(idToken)
      payload = verified
    } catch (err) {
      console.error('Token verification failed', err)
      return new Response(JSON.stringify({ isReviewer: false, reason: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
      })
    }

    const uid = payload.sub
    if (!uid) {
      return new Response(JSON.stringify({ isReviewer: false }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
      })
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase config missing in Edge Function')
      return new Response(JSON.stringify({ isReviewer: false, reason: 'Server misconfigured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
      })
    }

    // Query Supabase REST for reviewer by firebase_uid
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviewers?firebase_uid=eq.${encodeURIComponent(uid)}&select=role`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      console.error('Supabase query failed', await res.text())
      return new Response(JSON.stringify({ isReviewer: false, reason: 'Upstream error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
      })
    }

    const data = await res.json()
    if (Array.isArray(data) && data.length > 0) {
      const role = data[0].role || null
      return new Response(JSON.stringify({ isReviewer: true, role }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
      })
    }

    return new Response(JSON.stringify({ isReviewer: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader },
    })
  } catch (err) {
    console.error('Unexpected error in verify-reviewer', err)
    return new Response(JSON.stringify({ isReviewer: false, reason: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
