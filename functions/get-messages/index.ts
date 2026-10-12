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

async function isReviewer(uid: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviewers?firebase_uid=eq.${encodeURIComponent(uid)}&select=firebase_uid`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    console.error('get-messages: reviewer lookup failed', await res.text())
    return false
  }

  const data = await res.json()
  return Array.isArray(data) && data.length > 0
}

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
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGINS || '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      })
    }

    if (req.method !== 'POST') {
      return makeJson({ error: 'Method not allowed' }, 405)
    }

    const body = await req.json().catch(() => null)
    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return makeJson({ error: 'Missing or malformed Authorization header' }, 400)
    }

    const idToken = authHeader.slice(7).trim()
    if (!idToken) {
      return makeJson({ error: 'Missing idToken' }, 400)
    }

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      console.log('get-messages: token verify failed', { name: err?.name || null, message: err?.message || null })
      return makeJson({ error: 'Invalid token' }, 401)
    }

    const uid = payload?.sub
    if (!uid) {
      return makeJson({ error: 'Invalid token payload' }, 400)
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return makeJson({ error: 'Server misconfigured' }, 500)
    }

    const submissionId = body?.submission_id || null
    if (!submissionId) {
      return makeJson({ error: 'Missing submission id' }, 400)
    }

    const submissionUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=id,user_id`
    const submissionRes = await fetch(submissionUrl, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })

    if (!submissionRes.ok) {
      console.error('get-messages: submission lookup failed', await submissionRes.text())
      return makeJson({ error: 'Unable to load submission' }, 502)
    }

    const submissionRows = await submissionRes.json()
    const submission = Array.isArray(submissionRows) ? submissionRows[0] : null
    if (!submission) {
      return makeJson({ error: 'Submission not found' }, 404)
    }

    const reviewer = await isReviewer(uid)
    const isOwner = String(submission.user_id) === String(uid)
    if (!reviewer && !isOwner) {
      return makeJson({ error: 'Not authorized' }, 403)
    }

    const messagesUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/messages?submission_id=eq.${encodeURIComponent(submissionId)}&order=created_at.asc`
    const res = await fetch(messagesUrl, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      console.error('get-messages: messages query failed', await res.text())
      return makeJson({ error: 'Upstream error' }, 502)
    }

    const data = await res.json()
    return makeJson({ messages: Array.isArray(data) ? data : [] }, 200)
  } catch (err) {
    console.error('Unexpected error in get-messages', err)
    return makeJson({ error: 'Internal error' }, 500)
  }
})
