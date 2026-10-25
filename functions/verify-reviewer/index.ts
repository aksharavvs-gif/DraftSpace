// Secure Firebase ID-token verification for Supabase Edge Functions.
// This implementation does NOT trust any client-provided user ID.
// The database lookup is keyed only by the verified JWT subject (`sub`).
//
// Required secrets for this Edge Function:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - FIREBASE_PROJECT_ID (required)
// - ALLOWED_ORIGINS (optional)
//
// Firebase Auth issuers for standard ID tokens are project-scoped and must match:
// https://securetoken.google.com/<project-id>

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''
const FIREBASE_ISSUER = FIREBASE_PROJECT_ID ? `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` : ''

const DEFAULT_ALLOWED_ORIGINS = [
  'https://draftsspace.com',
  'https://aksharavvs-gif.github.io',
]

interface FirebaseJwk {
  kid: string
  kty: string
  alg: string
  use: string
  n: string
  e: string
  [key: string]: unknown
}

interface DecodedJwt {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  iat?: number
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

function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < value.length; i++) {
    binary += String.fromCharCode(value[i])
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
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

function parseJwtSegment(segment: string): Record<string, unknown> {
  try {
    const buffer = base64UrlDecode(segment)
    const text = new TextDecoder().decode(buffer)
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('Malformed JWT: unable to decode segment')
  }
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
    throw new Error('JWT is expired')
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('JWT missing valid sub claim')
  }

  const audience = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : []

  if (!audience.includes(FIREBASE_PROJECT_ID)) {
    throw new Error('JWT audience mismatch')
  }

  return payload
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization') || ''
  if (!authHeader) return null

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

// Use Deno.serve to match Supabase Edge Function handler format.
Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') {
      return getCorsOptionsResponse(req)
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const tokenFromBody = typeof body?.idToken === 'string' ? body.idToken.trim() : ''
    const idToken = extractBearerToken(req) || tokenFromBody

    if (!idToken) {
      return new Response(JSON.stringify({ error: 'Missing idToken' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      })
    }

    let verifiedPayload: DecodedJwt
    try {
      verifiedPayload = await verifyFirebaseIdToken(idToken)
    } catch (error) {
      console.error('Token verification failed', error)
      return new Response(JSON.stringify({ isReviewer: false, reason: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      })
    }

    // IMPORTANT: Only trust the subject claim from the verified token.
    // Never use a userId from a request body, query string, or URL parameter.
    const uid = verifiedPayload.sub
    if (!uid) {
      return new Response(JSON.stringify({ isReviewer: false, reason: 'Token missing subject' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      })
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Supabase config missing in Edge Function')
      return new Response(JSON.stringify({ isReviewer: false, reason: 'Server misconfigured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      })
    }

    // Strict DB lookup: use the verified Firebase user ID only.
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
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      })
    }

    const data = await res.json()
    if (Array.isArray(data) && data.length > 0) {
      const role = data[0]?.role ?? null
      return new Response(JSON.stringify({ isReviewer: true, role }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
      })
    }

    return new Response(JSON.stringify({ isReviewer: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    })
  } catch (error) {
    console.error('Unexpected error in verify-reviewer', error)
    return new Response(JSON.stringify({ isReviewer: false, reason: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    })
  }
})
