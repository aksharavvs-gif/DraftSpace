// Supabase Edge Function: verify Firebase ID token and return submissions
// for the authenticated Firebase user. Uses SUPABASE_SERVICE_ROLE_KEY
// Required Edge Function secrets:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - FIREBASE_PROJECT_ID
// - ALLOWED_ORIGINS (optional)

let joseModule: any = null

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''
const ALLOWED_ORIGINS = Deno.env.get('ALLOWED_ORIGINS') || ''

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

let jwksCache: { keys: any[]; fetchedAt: number } | null = null
const JWKS_TTL = 5 * 60 * 1000

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
    if (jwksCache) return jwksCache.keys
    throw err
  }
}

async function verifyIdToken(idToken: string) {
  if (!FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID not configured')

  const issuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`

  if (!joseModule) {
    joseModule = await import('npm:jose@4.14.4')
  }

  const header = await joseModule.decodeProtectedHeader(idToken)
  const kid = header.kid

  const jwks = await getJwks()
  const jwk = jwks.find((k) => k.kid === kid) || jwks[0]
  if (!jwk) throw new Error('No JWK available')

  const alg = jwk.alg || 'RS256'
  const key = await joseModule.importJWK(jwk, alg)

  const { payload } = await joseModule.jwtVerify(idToken, key, {
    issuer,
    audience: FIREBASE_PROJECT_ID,
  })

  return payload
}

// Handler
Deno.serve(async (req: Request) => {
  try {
    const origin = req.headers.get('origin') || ''
    const allowedOriginHeader = ALLOWED_ORIGINS ? ALLOWED_ORIGINS : '*'

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOriginHeader,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      })
    }

    if (req.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      console.log('get-submissions: missing or malformed authorization header')
      return new Response(JSON.stringify({ error: 'Missing or malformed Authorization header' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    const idToken = authHeader.slice(7).trim()
    if (!idToken) {
      return new Response(JSON.stringify({ error: 'Missing idToken' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      console.log('get-submissions: firebase token verification failed', { name: err?.name || null, message: err?.message || null })
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    const uid = payload?.sub
    if (!uid) {
      return new Response(JSON.stringify({ error: 'Invalid token payload' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase config missing in Edge Function')
      return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?user_id=eq.${encodeURIComponent(uid)}&order=submitted_at.desc`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    })

    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch (e) { data = text }

    if (!res.ok) {
      console.error('Supabase query failed', res.status, text)
      return new Response(JSON.stringify({ error: 'Upstream query failed', status: res.status, body: data }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    return new Response(JSON.stringify({ submissions: data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
  } catch (err) {
    console.error('Unexpected error in get-submissions', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
