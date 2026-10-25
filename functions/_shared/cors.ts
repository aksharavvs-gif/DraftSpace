const DEFAULT_ALLOWED_ORIGINS = [
  'https://draftsspace.com',
  'https://aksharavvs-gif.github.io',
]

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const CORS_HEADERS = 'Authorization, Content-Type, apikey, X-Client-Info, Prefer, Accept'

function normalizeOrigin(value: string) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

export function getAllowedOrigins() {
  const configuredValue = Deno.env.get('ALLOWED_ORIGINS') || ''
  const configuredOrigins = configuredValue
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)

  return Array.from(new Set([...configuredOrigins, ...DEFAULT_ALLOWED_ORIGINS]))
}

export function getCorsHeaders(req: Request) {
  const origin = normalizeOrigin(req.headers.get('origin') || '')
  const allowedOrigins = getAllowedOrigins()

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    Vary: 'Origin',
  }

  if (!origin) {
    return headers
  }

  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

export function getCorsOptionsResponse(req: Request) {
  const origin = normalizeOrigin(req.headers.get('origin') || '')
  const allowedOrigins = getAllowedOrigins()

  if (!origin || !allowedOrigins.includes(origin)) {
    return new Response(null, {
      status: 403,
      headers: {
        ...getCorsHeaders(req),
      },
    })
  }

  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(req),
  })
}
