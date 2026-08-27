// Supabase Edge Function: accept a Firebase ID token, verify it, and insert
// a submission into the `submissions` table using the Supabase service_role key.
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
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      })
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
    }

    // Read body
    const body = await req.json().catch(() => null)

    // Accept Authorization Bearer <idToken> or body.idToken
    let idToken = null
    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader && !body?.idToken) {
      console.log('create-submission: missing authorization header and body.idToken')
    }

    if (authHeader) {
      if (!authHeader.toLowerCase().startsWith('bearer ')) {
        console.log('create-submission: malformed authorization header')
      } else {
        idToken = authHeader.slice(7).trim()
        console.log('create-submission: received authorization header; token length=', idToken.length)
      }
    }

    if (!idToken && body?.idToken) {
      // body.idToken present (less common); do not log its value
      idToken = body.idToken
      console.log('create-submission: received idToken in request body; token length=', idToken?.length || 0)
    }

    if (!idToken) {
      return new Response(JSON.stringify({ error: 'Missing idToken' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      // Log verification error safely (name/message only)
      console.log('create-submission: firebase token verification failed', { name: err?.name || null, message: err?.message || null })
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

    // Expect submission payload in body.submission or body
    const submission = body?.submission || body
    if (!submission || typeof submission !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing submission payload' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    // Build row server-side; ignore any client-supplied user_id
    const row: any = {
      title: submission.title || '',
      review_status: submission.review_status || 'Awaiting review',
      response_time: submission.response_time || 'Within 72 hours',
      stage: submission.stage || null,
      writing_type: submission.writing_type || [],
      draft: submission.draft || '',
      context: submission.context || '',
      feedback: null,
      comments: submission.comments || [],
      question_replies: submission.question_replies || [],
      user_id: uid,
      user_email: submission.user_email || null,
    }

    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify([row]),
    })

    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch (e) { data = text }

    if (!res.ok) {
      console.error('Supabase insert failed', res.status, text)
      return new Response(JSON.stringify({ error: 'Upstream insert failed', status: res.status, body: data }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
    }

    // data should be an array with the inserted row
    const inserted = Array.isArray(data) ? data[0] : data

    return new Response(JSON.stringify({ submission: inserted }), { status: 201, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOriginHeader } })
  } catch (err) {
    console.error('Unexpected error in submit-submission', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
