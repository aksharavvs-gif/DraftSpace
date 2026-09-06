// Supabase Edge Function: verify Firebase ID token, confirm reviewer, and
// persist reviewer feedback (upsert into `reviews` and update `submissions`).
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

    const body = await req.json().catch(() => null)

    const authHeader = req.headers.get('authorization') || ''
    if (!authHeader.toLowerCase().startsWith('bearer ')) return makeJson({ error: 'Missing or malformed Authorization header' }, 400)

    const idToken = authHeader.slice(7).trim()
    if (!idToken) return makeJson({ error: 'Missing idToken' }, 400)

    let payload: any
    try {
      payload = await verifyIdToken(idToken)
    } catch (err: any) {
      console.log('submit-review: token verify failed', { name: err?.name || null, message: err?.message || null })
      return makeJson({ error: 'Invalid token' }, 401)
    }

    const uid = payload?.sub
    if (!uid) return makeJson({ error: 'Invalid token payload' }, 400)

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return makeJson({ error: 'Server misconfigured' }, 500)

    // Verify reviewer via reviewers table
    const checkUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviewers?firebase_uid=eq.${encodeURIComponent(uid)}&select=role`
    const checkRes = await fetch(checkUrl, { method: 'GET', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/json' } })
    if (!checkRes.ok) {
      console.error('submit-review: reviewer check failed', await checkRes.text())
      return makeJson({ error: 'Upstream error' }, 502)
    }
    const checkData = await checkRes.json()
    if (!Array.isArray(checkData) || checkData.length === 0) return makeJson({ error: 'Not authorized' }, 403)

    // Validate payload: must include submission id
    const submissionId = body?.submission_id || body?.id || null
    if (!submissionId) return makeJson({ error: 'Missing submission id' }, 400)

    // Build review row and submission update from body; ignore any client-supplied reviewer_uid or user_id
    const reviewRow: any = {
      submission_id: submissionId,
      reviewer_uid: uid,
      overall: body?.overall || null,
      strengths: body?.strengths || null,
      areas: body?.areas || null,
      voice: body?.voice || null,
      next: body?.next || null,
    }
      // Prevent overwriting an existing completed review: check for an existing
      // review row for this submission_id and reject updates if one exists.
      try {
        const checkReviewsUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews?submission_id=eq.${encodeURIComponent(submissionId)}`
        const checkRes = await fetch(checkReviewsUrl, { method: 'GET', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } })
        const checkText = await checkRes.text()
        let checkData: any = null
        try { checkData = JSON.parse(checkText) } catch (e) { checkData = checkText }
        if (!checkRes.ok) {
          console.error('submit-review: reviews lookup failed', checkRes.status, checkText)
          return makeJson({ error: 'Upstream error' }, 502)
        }

        if (Array.isArray(checkData) && checkData.length > 0) {
          // A review already exists for this submission; reject further edits.
          return makeJson({ error: 'Review already submitted and cannot be modified' }, 409)
        }
      } catch (err) {
        console.error('submit-review: error checking existing reviews', err)
        return makeJson({ error: 'Internal error' }, 500)
      }

      // Insert new review into reviews table (do not overwrite existing rows)
      const insertUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviews`
      const insertRes = await fetch(insertUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'return=representation' }, body: JSON.stringify([reviewRow]) })

      const insertText = await insertRes.text()
      let insertData: any = null
      try { insertData = JSON.parse(insertText) } catch (e) { insertData = insertText }
      if (!insertRes.ok) {
        console.error('submit-review: insert review failed', insertRes.status, insertText)
        return makeJson({ error: 'Upstream error', details: insertData }, 502)
      }

    // Prepare submission update
    const submissionUpdate: any = {
      review_status: body?.review_status || 'Feedback ready',
      response_time: body?.response_time || 'Sent today',
      feedback: body?.feedback || null,
      comments: body?.comments || [],
      question_replies: body?.question_replies || [],
      responded_at: new Date().toISOString(),
    }

    const updateUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=*
`
    const updateRes = await fetch(updateUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'return=representation' }, body: JSON.stringify(submissionUpdate) })

    const updateText = await updateRes.text()
    let updateData: any = null
    try { updateData = JSON.parse(updateText) } catch (e) { updateData = updateText }
    if (!updateRes.ok) {
      console.error('submit-review: update submission failed', updateRes.status, updateText)
      return makeJson({ error: 'Upstream error', details: updateData }, 502)
    }

    // updateData should be array with updated row(s)
    const updatedRow = Array.isArray(updateData) ? updateData[0] : updateData
    return makeJson({ submission: updatedRow }, 200)
  } catch (err) {
    console.error('Unexpected error in submit-review', err)
    return makeJson({ error: 'Internal error' }, 500)
  }
})
