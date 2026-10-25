// Supabase Edge Function: verify Firebase ID token, confirm reviewer, and
// persist highlight data on the target submission row using the same Firebase
// reviewer authorization flow already used elsewhere in this app.

let joseModule: any = null

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''

const ALLOWED_SECTION_IDS = ['overall', 'strengths', 'areas', 'voice', 'next'] as const
const ALLOWED_HIGHLIGHT_COLORS = ['#FBE2CC', '#FFF0B8', '#DCEBFF', '#DDF3DF', '#F8DDEC'] as const
const MAX_HIGHLIGHTS_PER_REQUEST = 100
const MAX_REQUEST_BODY_BYTES = 256 * 1024

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
  if (!joseModule) joseModule = await import('npm:jose@4.14.4')

  const header = await joseModule.decodeProtectedHeader(idToken)
  const kid = header.kid
  if (!kid || typeof header.alg !== 'string' || header.alg !== 'RS256') {
    throw new Error('Unexpected token signing algorithm or missing kid')
  }

  const jwks = await getJwks()
  const jwk = jwks.find((k) => k.kid === kid)
  if (!jwk) throw new Error(`No matching JWK found for kid: ${kid}`)
  if (typeof jwk.alg === 'string' && jwk.alg !== 'RS256') {
    throw new Error(`Unexpected JWK signing algorithm for kid: ${kid}`)
  }

  const key = await joseModule.importJWK(jwk, 'RS256')

  const { payload } = await joseModule.jwtVerify(idToken, key, {
    issuer,
    audience: FIREBASE_PROJECT_ID,
  })

  return payload
}

function normalizeHighlightPayload(raw: any, index: number) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid highlight at index ${index}`)
  }

  const sectionId = typeof raw.section_id === 'string' ? raw.section_id : (typeof raw.section === 'string' ? raw.section : 'overall')
  if (!ALLOWED_SECTION_IDS.includes(sectionId as typeof ALLOWED_SECTION_IDS[number])) {
    throw new Error(`Invalid section_id at index ${index}`)
  }

  const color = typeof raw.color === 'string' ? raw.color : ''
  if (!ALLOWED_HIGHLIGHT_COLORS.includes(color as typeof ALLOWED_HIGHLIGHT_COLORS[number])) {
    throw new Error(`Invalid highlight color at index ${index}`)
  }

  const startOffset = Number(raw.start_offset)
  const endOffset = Number(raw.end_offset)

  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || !Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset <= startOffset) {
    throw new Error(`Invalid highlight offsets at index ${index}`)
  }

  return {
    id: String(raw.id || `highlight-${index}-${Date.now()}`),
    section_id: sectionId,
    section: sectionId,
    start_offset: startOffset,
    end_offset: endOffset,
    selected_text: typeof raw.selected_text === 'string' ? raw.selected_text : (typeof raw.quote === 'string' ? raw.quote : ''),
    quote: typeof raw.quote === 'string' ? raw.quote : (typeof raw.selected_text === 'string' ? raw.selected_text : ''),
    color,
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at || new Date().toISOString(),
  }
}

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
    if (req.method === 'OPTIONS') return getCorsOptionsResponse(req)
    if (req.method !== 'POST') return makeJson({ error: 'Method not allowed' }, 405)

    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) return makeJson({ error: 'Missing or malformed Authorization header' }, 400)

    const idToken = authHeader.slice(7).trim()
    if (!idToken) return makeJson({ error: 'Missing idToken' }, 400)

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      console.log('update-submission-highlights: token verify failed', { name: err?.name || null, message: err?.message || null })
      return makeJson({ error: 'Invalid token' }, 401)
    }

    const uid = payload?.sub
    if (!uid) return makeJson({ error: 'Invalid token payload' }, 400)

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return makeJson({ error: 'Server misconfigured' }, 500)

    const reviewerCheckUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviewers?firebase_uid=eq.${encodeURIComponent(uid)}&select=firebase_uid`
    const reviewerRes = await fetch(reviewerCheckUrl, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })

    if (!reviewerRes.ok) {
      console.error('update-submission-highlights: reviewer lookup failed', await reviewerRes.text())
      return makeJson({ error: 'Upstream error' }, 502)
    }

    const reviewerRows = await reviewerRes.json()
    if (!Array.isArray(reviewerRows) || reviewerRows.length === 0) {
      return makeJson({ error: 'Not authorized' }, 403)
    }

    const rawBody = await req.text()
    if (rawBody.length > MAX_REQUEST_BODY_BYTES) {
      return makeJson({ error: 'Request body too large' }, 413)
    }

    let body: any = null
    try {
      body = rawBody ? JSON.parse(rawBody) : null
    } catch {
      return makeJson({ error: 'Invalid request body' }, 400)
    }

    if (!body || typeof body !== 'object') return makeJson({ error: 'Invalid request body' }, 400)

    const submissionId = typeof body.submission_id === 'string' ? body.submission_id.trim() : ''
    if (!submissionId) return makeJson({ error: 'Missing or invalid submission id' }, 400)

    const highlights = Array.isArray(body.highlights) ? body.highlights : []
    if (highlights.length > MAX_HIGHLIGHTS_PER_REQUEST) {
      return makeJson({ error: 'Too many highlights in request' }, 413)
    }

    const normalizedHighlights = highlights.map((item, index) => normalizeHighlightPayload(item, index))

    const submissionLookupUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=id`
    const submissionLookupRes = await fetch(submissionLookupUrl, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })

    if (!submissionLookupRes.ok) {
      console.error('update-submission-highlights: submission lookup failed', submissionLookupRes.status, await submissionLookupRes.text())
      return makeJson({ error: 'Upstream error' }, 502)
    }

    const submissionRows = await submissionLookupRes.json()
    if (!Array.isArray(submissionRows) || submissionRows.length === 0) {
      return makeJson({ error: 'Submission not found' }, 404)
    }

    const updateUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=*`
    const res = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ highlights: normalizedHighlights }),
    })

    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch (e) { data = text }

    if (!res.ok) {
      console.error('update-submission-highlights: row update failed', res.status, text)
      return makeJson({ error: 'Upstream error', details: data }, 502)
    }

    const updatedRow = Array.isArray(data) ? data[0] : data
    return makeJson({
      submission_id: submissionId,
      highlights: Array.isArray(updatedRow?.highlights) ? updatedRow.highlights : normalizedHighlights,
    }, 200)
  } catch (err) {
    console.error('Unexpected error in update-submission-highlights', err)
    return makeJson({ error: 'Internal error' }, 500)
  }
})
