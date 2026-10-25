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

    if (req.method !== 'GET' && req.method !== 'POST') {
      return makeJson({ error: 'Method not allowed' }, 405)
    }

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
      console.log('get-notifications: token verify failed', {
        name: err?.name || null,
        message: err?.message || null,
      })
      return makeJson({ error: 'Invalid token' }, 401)
    }

    const uid = payload?.sub
    if (!uid) {
      return makeJson({ error: 'Invalid token payload' }, 400)
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return makeJson({ error: 'Server misconfigured' }, 500)
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : 'list'

    if (action === 'mark_read') {
      const notificationId = typeof body?.notification_id === 'string' || typeof body?.notification_id === 'number'
        ? String(body.notification_id)
        : ''

      if (!notificationId) {
        return makeJson({ error: 'Missing notification id' }, 400)
      }

      const patchUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?id=eq.${encodeURIComponent(notificationId)}&recipient_uid=eq.${encodeURIComponent(uid)}`
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ is_read: true }),
      })

      if (!patchRes.ok) {
        const text = await patchRes.text()
        console.error('get-notifications: mark_read failed', patchRes.status, text)
        return makeJson({ error: 'Unable to update notification' }, 502)
      }

      return makeJson({ ok: true }, 200)
    }

    if (action === 'mark_all_read') {
      const patchUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?recipient_uid=eq.${encodeURIComponent(uid)}`
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ is_read: true }),
      })

      if (!patchRes.ok) {
        const text = await patchRes.text()
        console.error('get-notifications: mark_all_read failed', patchRes.status, text)
        return makeJson({ error: 'Unable to update notifications' }, 502)
      }

      return makeJson({ ok: true }, 200)
    }

    const listUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?recipient_uid=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=30`
    const unreadUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?recipient_uid=eq.${encodeURIComponent(uid)}&is_read=is.false&select=id`

    const [listRes, unreadRes] = await Promise.all([
      fetch(listUrl, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
        },
      }),
      fetch(unreadUrl, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
        },
      }),
    ])

    if (!listRes.ok || !unreadRes.ok) {
      const listText = await listRes.text().catch(() => '')
      const unreadText = await unreadRes.text().catch(() => '')
      console.error('get-notifications: list query failed', {
        listStatus: listRes.status,
        unreadStatus: unreadRes.status,
        listText,
        unreadText,
      })
      return makeJson({ error: 'Unable to load notifications' }, 502)
    }

    const notifications = await listRes.json()
    const unreadRows = await unreadRes.json()
    const unreadCount = Array.isArray(unreadRows) ? unreadRows.length : 0

    return makeJson({
      notifications: Array.isArray(notifications) ? notifications : [],
      unread_count: unreadCount,
    }, 200)
  } catch (err) {
    console.error('Unexpected error in get-notifications', err)
    return makeJson({ error: 'Internal error' }, 500)
  }
})
