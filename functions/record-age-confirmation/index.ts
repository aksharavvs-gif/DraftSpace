// Supabase Edge Function: verify Firebase ID token, confirm the user is 13+,
// and persist the attestation to the `profiles` table keyed by Firebase UID.
// This function does not accept a client-supplied UID and ignores any body.uid.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''

const DEFAULT_ALLOWED_ORIGINS = [
  'https://draftsspace.com',
  'https://aksharavvs-gif.github.io',
]

interface DecodedJwt {
  iss?: string
  sub?: string
  aud?: string | string[]
  email?: string
  exp?: number
  iat?: number
  [key: string]: unknown
}

interface FirebaseJwk {
  kid: string
  kty: string
  alg: string
  use: string
  n: string
  e: string
  [key: string]: unknown
}

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
let jwksCache: { keys: FirebaseJwk[]; fetchedAt: number } | null = null
const JWKS_TTL_MS = 5 * 60 * 1000

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function parseJwtSegment(segment: string): Record<string, unknown> {
  try {
    const buffer = base64UrlDecode(segment)
    const text = new TextDecoder().decode(buffer)
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('Malformed JWT: unable to decode segment')
  }
}

async function fetchJwks(): Promise<FirebaseJwk[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(JWKS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`JWKS request failed: ${response.status} ${response.statusText}`)
    }

    const payload = (await response.json()) as { keys?: FirebaseJwk[] }
    if (!payload?.keys || !Array.isArray(payload.keys) || payload.keys.length === 0) {
      throw new Error('Invalid JWKS payload from Google APIs')
    }

    return payload.keys
  } finally {
    clearTimeout(timeoutId)
  }
}

async function getJwks(): Promise<FirebaseJwk[]> {
  const now = Date.now()
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys
  }

  const keys = await fetchJwks()
  jwksCache = { keys, fetchedAt: Date.now() }
  return keys
}

async function verifyFirebaseIdToken(idToken: string): Promise<DecodedJwt> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing ID token')
  }

  if (!FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_PROJECT_ID is not configured')
  }

  const expectedIssuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts
  const protectedHeader = parseJwtSegment(headerSegment) as { alg?: string; kid?: string }

  if (!protectedHeader.alg || protectedHeader.alg !== 'RS256') {
    throw new Error('Unsupported JWT algorithm')
  }

  if (!protectedHeader.kid) {
    throw new Error('JWT header missing kid')
  }

  const jwks = await getJwks()
  const matchingJwk = jwks.find((jwk) => jwk.kid === protectedHeader.kid)
  if (!matchingJwk) {
    throw new Error('No matching JWK found for this JWT')
  }

  if (matchingJwk.kty !== 'RSA') {
    throw new Error('Unexpected JWK type')
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    matchingJwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify'],
  )

  const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  const signatureBytes = base64UrlDecode(signatureSegment)
  const isValidSignature = await crypto.subtle.verify(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    cryptoKey,
    signatureBytes,
    signingInput,
  )

  if (!isValidSignature) {
    throw new Error('JWT signature verification failed')
  }

  const payload = parseJwtSegment(payloadSegment) as DecodedJwt

  if (typeof payload.iss !== 'string' || payload.iss !== expectedIssuer) {
    throw new Error(`JWT issuer mismatch. Expected ${expectedIssuer}`)
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error('JWT missing valid exp claim')
  }

  const nowInSeconds = Math.floor(Date.now() / 1000)
  if (payload.exp <= nowInSeconds) {
    throw new Error('JWT has expired')
  }

  return payload
}

function makeJson(req: Request, payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(req),
    },
  })
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') {
      return getCorsOptionsResponse(req)
    }

    if (req.method !== 'POST') {
      return makeJson(req, { error: 'Method not allowed' }, 405)
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return makeJson(req, { error: 'Request body required' }, 400)
    }

    const authHeader = req.headers.get('authorization') || ''
    let idToken = ''

    if (typeof body.idToken === 'string' && body.idToken.trim()) {
      idToken = body.idToken.trim()
    } else if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      idToken = authHeader.slice(7).trim()
    }

    if (!idToken) {
      return makeJson(req, { error: 'Missing idToken' }, 400)
    }

    const isEligible = body.age_13_or_older === true
    if (!isEligible) {
      return makeJson(req, { error: 'Age confirmation is required and must be true.' }, 400)
    }

    const verifiedPayload = await verifyFirebaseIdToken(idToken)
    const uid = typeof verifiedPayload.sub === 'string' ? verifiedPayload.sub : ''
    if (!uid) {
      return makeJson(req, { error: 'Invalid token payload' }, 400)
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase config missing in Edge Function')
      return makeJson(req, { error: 'Server misconfigured' }, 500)
    }

    const profilePayload = {
      firebase_uid: uid,
      email: typeof verifiedPayload.email === 'string' ? verifiedPayload.email : null,
      age_13_or_older: true,
      age_attested_at: new Date().toISOString(),
    }

    const upsertUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles?on_conflict=firebase_uid`
    const upsertResponse = await fetch(upsertUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify([profilePayload]),
    })

    const upsertText = await upsertResponse.text()
    let upsertData: any = null
    try {
      upsertData = JSON.parse(upsertText)
    } catch {
      upsertData = upsertText
    }

    if (!upsertResponse.ok) {
      console.error('Profiles upsert failed', upsertResponse.status, upsertData)
      return makeJson(req, { error: 'Unable to save age confirmation' }, 400)
    }

    return makeJson(req, { success: true, uid, age_13_or_older: true }, 200)
  } catch (error: any) {
    console.error('record-age-confirmation: unexpected error', error)
    return makeJson(req, { error: error?.message || 'Unable to verify age' }, 500)
  }
})
