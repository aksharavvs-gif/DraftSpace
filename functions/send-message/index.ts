import { getCorsHeaders, getCorsOptionsResponse } from '../_shared/cors.ts'

let joseModule: any = null

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || ''

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
    console.error('send-message: reviewer lookup failed', await res.text())
    return false
  }

  const data = await res.json()
  return Array.isArray(data) && data.length > 0
}

async function listReviewerUids() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return []

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/reviewers?select=firebase_uid`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    console.error('send-message: reviewer list failed', await res.text())
    return []
  }

  const data = await res.json()
  if (!Array.isArray(data)) return []

  return data
    .map((row: any) => row?.firebase_uid)
    .filter((value: any) => typeof value === 'string' && value.trim().length > 0)
}

async function createNotificationsForMessage({
  submissionId,
  messageId,
  senderUid,
  senderName,
  submissionTitle,
  recipientUids,
}: {
  submissionId: string
  messageId: string
  senderUid: string
  senderName: string | null
  submissionTitle: string | null
  recipientUids: string[]
}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !messageId) return []

  const deduped = Array.from(new Set(recipientUids.filter((value) => typeof value === 'string' && value.trim().length > 0 && value !== senderUid)))
  if (deduped.length === 0) return []

  const listUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?message_id=eq.${encodeURIComponent(messageId)}&select=id,recipient_uid`
  const existingRes = await fetch(listUrl, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  })

  const existingRows = existingRes.ok ? await existingRes.json() : []
  const existingByRecipient = new Set(
    Array.isArray(existingRows)
      ? existingRows
          .map((row: any) => row?.recipient_uid)
          .filter((value: any) => typeof value === 'string' && value.trim().length > 0)
      : [],
  )

  const rows = deduped
    .filter((recipientUid) => !existingByRecipient.has(recipientUid))
    .map((recipientUid) => ({
      recipient_uid: recipientUid,
      type: 'new_message',
      submission_id: submissionId,
      message_id: messageId,
      sender_uid: senderUid,
      sender_name: senderName || null,
      submission_name: submissionTitle || null,
      is_read: false,
      created_at: new Date().toISOString(),
    }))

  if (!rows.length) return []

  const notificationsUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications`
  const insertRes = await fetch(notificationsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  })

  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => '')
    let payload: any = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    console.error('send-message: notification insert failed', {
      status: insertRes.status,
      code: payload?.code || null,
      message: payload?.message || null,
      recipientCount: rows.length,
      messageId,
      submissionId,
    })
    return []
  }

  try {
    return await insertRes.json()
  } catch {
    return []
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
    if (req.method === 'OPTIONS') {
      return getCorsOptionsResponse(req)
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
      console.log('send-message: token verify failed', { name: err?.name || null, message: err?.message || null })
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
    const messageText = typeof body?.message === 'string' ? body.message.trim() : ''

    if (!submissionId) {
      return makeJson({ error: 'Missing submission id' }, 400)
    }

    if (!messageText) {
      return makeJson({ error: 'Message is required' }, 400)
    }

    const submissionUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=id,user_id,title`
    const submissionRes = await fetch(submissionUrl, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })

    if (!submissionRes.ok) {
      console.error('send-message: submission lookup failed', await submissionRes.text())
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

    const senderRole = reviewer ? 'reviewer' : 'student'
    const firebaseName = typeof payload?.name === 'string' ? payload.name.trim() : ''
    const requestSenderName = typeof body?.sender_name === 'string' ? body.sender_name.trim() : ''
    const senderName = senderRole === 'student'
      ? (firebaseName ? firebaseName.split(/\s+/)[0] : requestSenderName ? requestSenderName.split(/\s+/)[0] : null)
      : null
    const row = {
      submission_id: submissionId,
      sender_uid: uid,
      sender_role: senderRole,
      message: messageText,
      ...(senderName ? { sender_name: senderName } : {}),
    }

    const insertUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/messages`
    const firstAttempt = await fetch(insertUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify([row]),
    })

    let insertData: any = null
    let insertRes = firstAttempt
    let insertText = await insertRes.text()
    try { insertData = JSON.parse(insertText) } catch (e) { insertData = insertText }

    if (!insertRes.ok && senderName) {
      const fallbackRow = {
        submission_id: submissionId,
        sender_uid: uid,
        sender_role: senderRole,
        message: messageText,
      }

      insertRes = await fetch(insertUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify([fallbackRow]),
      })

      insertText = await insertRes.text()
      try { insertData = JSON.parse(insertText) } catch (e) { insertData = insertText }
    }

    if (!insertRes.ok) {
      console.error('send-message: insert failed', insertRes.status, insertText)
      return makeJson({ error: 'Upstream insert failed', details: insertData }, 502)
    }

    const saved = Array.isArray(insertData) ? insertData[0] : insertData
    const messageId = saved?.id || row?.id || null

    try {
      if (!messageId) {
        console.error('send-message: message insert succeeded but no message id was returned; notification creation skipped', {
          submissionId,
          senderRole,
          senderUid: uid,
        })
      } else {
        const recipientUids: string[] = []
        if (senderRole === 'student') {
          const reviewerUids = await listReviewerUids()
          recipientUids.push(...reviewerUids)
        } else {
          recipientUids.push(String(submission.user_id || ''))
        }

        const notificationRows = await createNotificationsForMessage({
          submissionId: String(submissionId),
          messageId: String(messageId),
          senderUid: uid,
          senderName: senderName || null,
          submissionTitle: typeof submission?.title === 'string' ? submission.title : null,
          recipientUids,
        })

        if (notificationRows.length > 0) {
          console.log('send-message: created notifications', notificationRows.length)
        }
      }
    } catch (notificationErr) {
      console.error('send-message: notification creation failed', {
        name: notificationErr instanceof Error ? notificationErr.name : 'Error',
        message: notificationErr instanceof Error ? notificationErr.message : String(notificationErr),
      })
    }

    return makeJson({ message: saved || row }, 200)
  } catch (err) {
    console.error('Unexpected error in send-message', err)
    return makeJson({ error: 'Internal error' }, 500)
  }
})
