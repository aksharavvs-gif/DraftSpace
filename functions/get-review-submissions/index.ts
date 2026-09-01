// Supabase Edge Function: verify Firebase ID token, confirm reviewer, and
// return all submissions for reviewers.
// Required Edge Function secrets:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - FIREBASE_PROJECT_ID
// - ALLOWED_ORIGINS (optional)

let joseModule: any = null

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '')

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
  if (!joseModule) joseModule = await import('npm:jose@4.14.4')

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

// helper to return JSON with CORS headers
const makeJson = (obj: any, status = 200) => {
  const allowedOriginHeader = ALLOWED_ORIGINS ? ALLOWED_ORIGINS : '*'
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOriginHeader,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  })
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS || '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } })

    if (req.method !== 'POST') return makeJson({ error: 'Method not allowed' }, 405)

    // read token from Authorization header
    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) return makeJson({ error: 'Missing or malformed Authorization header' }, 400)

    const idToken = authHeader.slice(7).trim()
    if (!idToken) return makeJson({ error: 'Missing idToken' }, 400)

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      console.log('get-review-submissions: token verify failed', { name: err?.name || null, message: err?.message || null })
      return makeJson({ error: 'Invalid token' }, 401)
    }

    const uid = payload?.sub
    if (!uid) return makeJson({ error: 'Invalid token payload' }, 400)

    // Now verify reviewer role via reviewers table (reuse existing check)
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return makeJson({ error: 'Server misconfigured' }, 500)

    const checkUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviewers?firebase_uid=eq.${encodeURIComponent(uid)}&select=role`
    const checkRes = await fetch(checkUrl, { method: 'GET', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/json' } })
    if (!checkRes.ok) {
      console.error('get-review-submissions: reviewer check failed', await checkRes.text())
      return makeJson({ error: 'Upstream error' }, 502)
    }
    const checkData = await checkRes.json()
    if (!Array.isArray(checkData) || checkData.length === 0) return makeJson({ error: 'Not authorized' }, 403)

    // authorized; fetch submissions
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?order=submitted_at.desc`
    const res = await fetch(url, { method: 'GET', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/json' } })

    if (!res.ok) {
      console.error('get-review-submissions: submissions query failed', await res.text())
      return makeJson({ error: 'Upstream error' }, 502)
    }

    const submissions = await res.json()
    return makeJson({ submissions }, 200)
  } catch (err) {
    console.error('Unexpected error in get-review-submissions', err)
    return makeJson({ error: 'Internal error' }, 500)
  }
})
