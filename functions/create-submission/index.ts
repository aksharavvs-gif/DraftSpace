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

const DEFAULT_ALLOWED_ORIGINS = [
  'https://draftsspace.com',
  'https://aksharavvs-gif.github.io',
]

function normalizeOrigin(value: string) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

function getAllowedOrigins() {
  const configuredValue = Deno.env.get('ALLOWED_ORIGINS') || ''
  const configuredOrigins = configuredValue
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)

  return Array.from(new Set([...configuredOrigins, ...DEFAULT_ALLOWED_ORIGINS]))
}

function getCorsHeaders(req: Request) {
  const origin = normalizeOrigin(req.headers.get('origin') || '')
  const allowedOrigins = getAllowedOrigins()

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, X-Client-Info, Prefer, Accept',
    Vary: 'Origin',
  }

  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

function getCorsOptionsResponse(req: Request) {
  const origin = normalizeOrigin(req.headers.get('origin') || '')
  const allowedOrigins = getAllowedOrigins()

  if (!origin || !allowedOrigins.includes(origin)) {
    return new Response(null, {
      status: 403,
      headers: getCorsHeaders(req),
    })
  }

  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(req),
  })
}

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

const MAX_SUBMISSION_WORD_COUNT = 3000

function countWords(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return 0
  return text.split(/\s+/).filter(Boolean).length
}

function getRpcErrorCodeAndMessage(payload: any) {
  const errorText = typeof payload?.message === 'string' ? payload.message : ''
  const errorCode = typeof payload?.code === 'string' ? payload.code : ''

  if (errorCode === 'word_limit_exceeded' || /3,000-word limit|3,000 word limit|word limit/i.test(errorText)) {
    return {
      code: 'word_limit_exceeded',
      message: 'Submission exceeds the 3,000-word limit. Please reduce your draft to 3,000 words or fewer.',
    }
  }

  if (errorCode === 'daily_limit_reached' || /daily submission limit/i.test(errorText) || /limit reached/i.test(errorText)) {
    return {
      code: 'daily_limit_reached',
      message: 'You\'ve reached your daily submission limit. Please wait for the oldest submission in the last 24 hours to expire before submitting again.',
    }
  }

  if (errorCode === 'cooldown_active' || /wait before submitting again|cooldown/i.test(errorText)) {
    return {
      code: 'cooldown_active',
      message: 'Please wait before submitting again.',
    }
  }

  return {
    code: 'submission_rejected',
    message: errorText || 'Submission rejected by the server.',
  }
}

// Handler
Deno.serve(async (req: Request) => {
  const makeJson = (obj: any, status = 200) => {
    return new Response(JSON.stringify(obj), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(req),
      },
    })
  }

  try {
    if (req.method === 'OPTIONS') {
      return getCorsOptionsResponse(req)
    }

    if (req.method !== 'POST') {
      return makeJson({ error: 'Method not allowed' }, 405)
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
      return new Response(JSON.stringify({ error: 'Missing idToken' }), { status: 400, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
    }

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      // Log verification error safely (name/message only)
      console.log('create-submission: firebase token verification failed', { name: err?.name || null, message: err?.message || null })
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
    }

    const uid = payload?.sub
    if (!uid) {
      return new Response(JSON.stringify({ error: 'Invalid token payload' }), { status: 400, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase config missing in Edge Function')
      return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
    }

    // Expect submission payload in body.submission or body
    const submission = body?.submission || body
    if (!submission || typeof submission !== 'object') {
      return new Response(JSON.stringify({ error: 'Missing submission payload' }), { status: 400, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
    }

    // Build row server-side; ignore any client-supplied user_id
    const draftText = typeof submission.draft === 'string' ? submission.draft : String(submission.draft || '')
    const wordCount = countWords(draftText)
    if (wordCount > MAX_SUBMISSION_WORD_COUNT) {
      return makeJson({
        error: 'Submission exceeds the 3,000-word limit.',
        code: 'word_limit_exceeded',
        message: `Submission exceeds the 3,000-word limit. Please reduce your draft to 3,000 words or fewer.`,
      }, 400)
    }

    const rpcBody = {
      p_user_id: uid,
      p_title: typeof submission.title === 'string' ? submission.title : '',
      p_stage: submission.stage || 'Drafting',
      p_writing_type: typeof submission.writing_type === 'string' ? submission.writing_type : Array.isArray(submission.writing_type) ? submission.writing_type.join(', ') : '',
      p_draft: draftText,
      p_context: typeof submission.context === 'string' ? submission.context : '',
      p_comments: Array.isArray(submission.comments) ? submission.comments : [],
      p_question_replies: Array.isArray(submission.question_replies) ? submission.question_replies : [],
      p_user_email: typeof submission.user_email === 'string' ? submission.user_email : null,
      p_review_status: submission.review_status || 'Awaiting review',
      p_response_time: submission.response_time || 'Within 72 hours',
    }

    const rpcUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/submit_submission_with_limits`
    const rpcRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(rpcBody),
    })

    const rpcText = await rpcRes.text()
    let rpcData: any = null
    try { rpcData = JSON.parse(rpcText) } catch (e) { rpcData = rpcText }

    if (!rpcRes.ok) {
      const parsedError = getRpcErrorCodeAndMessage(rpcData)
      console.error('Supabase RPC insert failed', rpcRes.status, rpcData)
      return makeJson({
        error: parsedError.message,
        code: parsedError.code,
        message: parsedError.message,
      }, 400)
    }

    const inserted = Array.isArray(rpcData) ? rpcData[0] : rpcData

    return new Response(JSON.stringify({ submission: inserted }), { status: 201, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
  } catch (err) {
    console.error('Unexpected error in submit-submission', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) } })
  }
})
