// Temporary repro script: post a submission to Supabase REST API
// Usage: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in your shell

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
const FIREBASE_UID = process.env.TEST_FIREBASE_UID || process.env.FIREBASE_UID || null
const PROFILE_EMAIL = process.env.TEST_PROFILE_EMAIL || null

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment. Aborting.')
  process.exit(1)
}

const row = {
  title: 'Repro test: why insert fails',
  review_status: 'Awaiting review',
  response_time: 'Within 72 hours',
  stage: 'Drafting',
  writing_type: ['Creative Writing'],
  draft: 'This is a test draft used to reproduce an insert failure.',
  context: 'Test context',
  feedback: null,
  comments: [
    { id: 1, passage: 'The opening felt alive.', note: 'Nice imagery.' }
  ],
  question_replies: [],
  user_id: FIREBASE_UID,
  user_email: PROFILE_EMAIL || null,
}

const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/submissions`

;(async () => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify([row]),
    })

    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch (e) { data = text }

    console.log('HTTP status:', res.status, res.statusText)
    console.log('Response body:', JSON.stringify(data, null, 2))

    if (!res.ok) {
      // Attempt to surface common Supabase error fields if present
      if (data && typeof data === 'object') {
        console.log('error.message:', data.message || data.error || null)
        console.log('error.details:', data.details || null)
        console.log('error.hint:', data.hint || null)
        console.log('error.code:', data.code || null)
      }
      process.exit(2)
    }

    console.log('Insert succeeded; returned row:', JSON.stringify(data[0] || data, null, 2))
  } catch (err) {
    console.error('Fetch error:', err)
    process.exit(3)
  }
})()
