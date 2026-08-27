// jose will be dynamically imported inside the verification path to avoid blocking
// module evaluation during cold-start (improves OPTIONS preflight latency).
let joseModule: any = null

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

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

// Simple in-memory cache for JWKS
let jwksCache: { keys: any[]; fetchedAt: number } | null = null
const JWKS_TTL = 5 * 60 * 1000 // 5 minutes

async function fetchJwksWithTimeout(timeoutMs = 3000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(JWKS_URL, { signal: controller.signal })
    clearTimeout(id)
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
    const body = await res.json()
    if (!body?.keys || !Array.isArray(body.keys)) throw new Error('Invalid JWKS payload')
    return body.keys
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

async function getJwks() {
  const now = Date.now()
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL) return jwksCache.keys

  try {
    const keys = await fetchJwksWithTimeout(3000)
    jwksCache = { keys, fetchedAt: Date.now() }
    return keys
  } catch (err) {
    // If fetch failed but cache exists, return cached keys as a fallback
    if (jwksCache) return jwksCache.keys
    throw err
  }
}

async function verifyIdToken(idToken: string) {
  if (!FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID not configured')

  const issuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`

  // lazy-load jose to avoid blocking on module initialization during cold start
  const importStart = Date.now()
  if (!joseModule) {
    console.log('verifyIdToken: importing jose...')
    joseModule = await import('npm:jose@4.14.4')
    console.log('verifyIdToken: imported jose', { importMs: Date.now() - importStart })
  } else {
    console.log('verifyIdToken: jose module cached')
  }

  // decode header to pick the right key
  const header = await joseModule.decodeProtectedHeader(idToken)
  const kid = header.kid

  const jwksStart = Date.now()
  const jwks = await getJwks()
  console.log('verifyIdToken: jwks fetched', { jwksMs: Date.now() - jwksStart, keys: jwks?.length ?? 0 })

  // find matching key by kid, fallback to trying all
  const jwk = jwks.find((k) => k.kid === kid) || jwks[0]
  if (!jwk) throw new Error('No JWK available')

  const alg = jwk.alg || 'RS256'
  const key = await joseModule.importJWK(jwk, alg)

  const verifyStart = Date.now()
  const { payload } = await joseModule.jwtVerify(idToken, key, {
    issuer,
    audience: FIREBASE_PROJECT_ID,
  })
  console.log('verifyIdToken: jwtVerify complete', { verifyMs: Date.now() - verifyStart })

  return payload
}

// Use Deno.serve to match Supabase Edge Function handler format.
Deno.serve(async (req: Request) => {
  try {
    const origin = req.headers.get('origin') || ''
    const allowedOriginHeader = ALLOWED_ORIGINS ? ALLOWED_ORIGINS : '*'

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOriginHeader,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      })
    }

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
})
