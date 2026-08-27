import { useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  arrayUnion,
  serverTimestamp,
} from 'firebase/firestore'
import './App.css'
import { auth, googleProvider, hasFirebaseConfig, db } from './firebase'

const writingOptions = [
  'Creative Writing',
  'Argumentative Essay',
  'Personal Essay',
  'Research Paper',
  'Literary Analysis',
  'Scholarship Essay',
  'Poetry',
  'Speech',
  'Journalism',
  'Memoir',
]

const gradeOptions = ['9th grade', '10th grade', '11th grade', '12th grade', 'College']

const interestOptions = [
  'Creative Writing',
  'College Essays',
  'Journalism',
  'Scholarship Essays',
  'Research Papers',
  'Literary Analysis',
  'Poetry',
  'Speeches',
  'Other',
]

const reasonOptions = [
  'Better my writing',
  'Preserve my personal voice',
  'Get thoughtful feedback',
  'Learn how to revise',
  'Build confidence',
  'Share work with others',
]

const STORAGE_KEY = 'draftspace-submissions'
const ONBOARDING_STORAGE_KEY = 'draftspace-onboarding-complete'

// Submissions are persisted exclusively to Firestore. Do not initialize from localStorage.

const formatTimestamp = (ts) => {
  try {
    if (!ts) return null
    // Firestore Timestamp has toDate(), plain JS Date is instance of Date
    const date = typeof ts.toDate === 'function' ? ts.toDate() : ts instanceof Date ? ts : new Date(ts)
    return date.toLocaleString()
  } catch {
    return null
  }
}

const readCompletedOnboardingEmails = () => {
  if (typeof window === 'undefined') return []

  try {
    const stored = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
    if (!stored) return []

    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const hasCompletedOnboarding = (email) => {
  if (!email) return false
  return readCompletedOnboardingEmails().includes(email.toLowerCase())
}

const markOnboardingComplete = (email) => {
  if (!email || typeof window === 'undefined') return

  const normalizedEmail = email.toLowerCase()
  const current = readCompletedOnboardingEmails()

  if (current.includes(normalizedEmail)) return

  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify([...current, normalizedEmail]))
}

// Note: reviewer authorization is handled server-side via Supabase Edge Function.
// The old VITE_APPROVED_REVIEWER_EMAILS client-side whitelist was removed.

function App() {
  const [screen, setScreen] = useState('landing')
  const [accountStage, setAccountStage] = useState('auth')
  const [profile, setProfile] = useState({
    name: 'Ava',
    email: '',
    grade: '11th grade',
    interests: ['Creative Writing', 'College Essays'],
    reasons: ['Better my writing', 'Preserve my personal voice'],
  })
  const [submissions, setSubmissions] = useState([])
  const [authResolved, setAuthResolved] = useState(false)
  const [authUid, setAuthUid] = useState(null)
  const [selectedSubmissionId, setSelectedSubmissionId] = useState(null)
  const [wizardStep, setWizardStep] = useState(1)
  const [draftForm, setDraftForm] = useState({
    title: '',
    draft: '',
    writingType: [],
    stage: 'Drafting',
    context: '',
  })
  // local reviewer password login removed; reviewers authorize via Edge Function
  const [reviewerLoggedIn, setReviewerLoggedIn] = useState(false)
  const [reviewerSelectedSubmissionId, setReviewerSelectedSubmissionId] = useState(null)
  const [reviewerFeedback, setReviewerFeedback] = useState({
    overall: '',
    strengths: '',
    areas: '',
    voice: '',
    next: '',
  })
  const [chatMessages, setChatMessages] = useState([
    { id: 1, from: 'student', text: 'I’m wondering whether the ending lands emotionally.' },
    { id: 2, from: 'reviewer', text: 'Absolutely — I can help you shape that with a few questions.' },
  ])
  const [chatDraft, setChatDraft] = useState('')
  const [questionDraft, setQuestionDraft] = useState('')
  const [questionOpen, setQuestionOpen] = useState(false)
  const [reviewNotice, setReviewNotice] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [feedbackSubmittedMessage, setFeedbackSubmittedMessage] = useState('')
  const [authContext, setAuthContext] = useState('student')

  const selectedSubmission = useMemo(
    () => submissions.find((item) => item.id === selectedSubmissionId) ?? null,
    [selectedSubmissionId, submissions],
  )

  const reviewerSelectedSubmission = useMemo(
    () => submissions.find((item) => item.id === reviewerSelectedSubmissionId) ?? null,
    [reviewerSelectedSubmissionId, submissions],
  )

  const toggleSelection = (list, value) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value]

  useEffect(() => {
    // Submissions are stored only in Firestore; do not write them to localStorage.
  }, [submissions])

  // Listen for persistent submissions when Firebase is configured.
  useEffect(() => {
    if (!hasFirebaseConfig || !db) return undefined

    let q
    try {
      if (authUid && authContext !== 'reviewer') {
        q = query(collection(db, 'submissions'), where('userId', '==', authUid), orderBy('submitted_at', 'desc'))
      } else {
        // reviewers (or non-authenticated reviewer flow) see all submissions
        q = query(collection(db, 'submissions'), orderBy('submitted_at', 'desc'))
      }
    } catch (err) {
      console.error('Error building submissions query', err)
      return undefined
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const docs = snapshot.docs.map((d) => {
          const data = d.data()
          return {
            id: d.id,
            ...data,
            submittedAt: formatTimestamp(data.submitted_at) || data.submittedAt || 'Unknown',
            respondedAt: formatTimestamp(data.responded_at) || null,
          }
        })
        setSubmissions(docs)
      },
      (error) => {
        console.error('Error listening to submissions:', error)
        setReviewNotice('Unable to load submissions from the server.')
      },
    )

    return unsubscribe
  }, [hasFirebaseConfig, db, authUid, authResolved, authContext])

  useEffect(() => {
    if (!auth) {
      setAuthMessage('Add your Firebase credentials to enable Google sign-in.')
      return undefined
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      // mark that auth has been resolved and expose UID
      setAuthUid(user?.uid ?? null)
      setAuthResolved(true)

      if (!user) return
      if (authContext === 'reviewer') return

      const normalizedEmail = user.email?.toLowerCase() || ''

      setProfile((current) => ({
        ...current,
        name: user.displayName?.split(' ')[0] || current.name,
        email: normalizedEmail || current.email,
      }))
      setAuthMessage('')

      if (normalizedEmail && hasCompletedOnboarding(normalizedEmail)) {
        setScreen('dashboard')
        return
      }

      setAccountStage('onboarding')
      setScreen('onboarding')
    })

    return unsubscribe
  }, [auth, authContext])

  // If a reviewer signs in and no submission is selected yet, pick the newest one.
  useEffect(() => {
    if (reviewerLoggedIn && submissions.length > 0 && !reviewerSelectedSubmissionId) {
      setReviewerSelectedSubmissionId(submissions[0].id)
    }
  }, [reviewerLoggedIn, submissions, reviewerSelectedSubmissionId])

  const openAuth = () => {
    setAuthContext('student')
    setAccountStage('auth')
    setScreen('auth')
  }

  const handleGoogleSignIn = async () => {
    if (!auth || !googleProvider) {
      setAuthMessage('Google sign-in is not configured yet. Add your Firebase credentials to enable it.')
      return
    }

    setAuthContext('student')

    try {
      const result = await signInWithPopup(auth, googleProvider)
      const user = result.user
      const normalizedEmail = user.email?.toLowerCase() || ''

      setProfile((current) => ({
        ...current,
        name: user.displayName?.split(' ')[0] || current.name,
        email: normalizedEmail || current.email,
      }))

      if (normalizedEmail && hasCompletedOnboarding(normalizedEmail)) {
        setAccountStage('auth')
        setScreen('dashboard')
        setAuthMessage('')
        return
      }

      setAccountStage('onboarding')
      setScreen('onboarding')
      setAuthMessage('')
    } catch (error) {
      setAuthMessage(error.message || 'Google sign-in did not complete.')
    }
  }

  const handleOnboardingSubmit = (event) => {
    event.preventDefault()
    markOnboardingComplete(profile.email)
    setScreen('dashboard')
  }

  const handleSignOut = async () => {
    if (!auth) return
    await signOut(auth)
    setAuthContext('student')
    setScreen('landing')
    setAuthMessage('You signed out. Sign in again anytime.')
  }

  const startNewSubmission = () => {
    setDraftForm({ title: '', draft: '', writingType: [], stage: 'Drafting', context: '' })
    setWizardStep(1)
    setScreen('submission-step-1')
  }

  const goToSubmissionStep = (step) => {
    setWizardStep(step)
    setScreen(`submission-step-${step}`)
  }

  const goToDashboard = () => {
    setScreen('dashboard')
    setQuestionOpen(false)
  }

  const handleWizardNext = () => {
    if (wizardStep === 1) {
      if (!draftForm.title || !draftForm.draft) {
        setReviewNotice('Please add a title and paste your draft before continuing.')
        return
      }
      setReviewNotice('')
      goToSubmissionStep(2)
      return
    }

    if (wizardStep === 2) {
      if (!draftForm.writingType.length) {
        setReviewNotice('Choose at least one kind of writing so your reviewer can understand the piece.')
        return
      }
      setReviewNotice('')
      goToSubmissionStep(3)
      return
    }

    if (wizardStep === 3) {
      setReviewNotice('')
      const submit = async () => {
        // require Firestore and authenticated user
        if (!hasFirebaseConfig || !db) {
          setReviewNotice('Submission failed: server not configured. Please try again later.')
          return
        }

        if (!authResolved) {
          setReviewNotice('Authentication is still resolving. Please wait a moment and try again.')
          return
        }

        if (!authUid) {
          setReviewNotice('Please sign in before submitting your draft.')
          return
        }

        try {
          const payload = {
            title: draftForm.title,
            reviewStatus: 'Awaiting review',
            responseTime: 'Within 72 hours',
            stage: draftForm.stage,
            writingType: draftForm.writingType,
            draft: draftForm.draft,
            context: draftForm.context,
            feedback: null,
            comments: [
              { id: 1, passage: 'The opening image felt especially alive.', note: 'This sentence carries warmth and specificity.' },
            ],
            questionReplies: [],
            userId: authUid,
            userEmail: profile.email || null,
            submitted_at: serverTimestamp(),
            responded_at: null,
          }

          const ref = await addDoc(collection(db, 'submissions'), payload)

          // after success, rely on the snapshot listener to populate submissions
          setSelectedSubmissionId(ref.id)
          setScreen('submission-success')
          setReviewNotice('')
        } catch (err) {
          console.error('Error saving submission:', err)
          setReviewNotice('Unable to save your submission. Please try again.')
        }
      }

      submit()
    }
  }

  const handleReviewerGoogleSignIn = async () => {
    if (!auth || !googleProvider) {
      setReviewNotice('Google sign-in is not configured yet. Add your Firebase credentials to enable it.')
      return
    }

    setAuthContext('reviewer')
    setReviewNotice('')

    try {
      const result = await signInWithPopup(auth, googleProvider)

      // get a fresh Firebase ID token and POST to the Supabase Edge Function
      const idToken = await result.user.getIdToken()

      const verifyUrl = import.meta.env.VITE_VERIFY_REVIEWER_URL
      if (!verifyUrl) {
        // No verification endpoint configured
        await signOut(auth)
        setReviewNotice('Reviewer verification endpoint not configured. Contact the admin.')
        return
      }

      const resp = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })

      if (!resp.ok) {
        await signOut(auth)
        setReviewerLoggedIn(false)
        setReviewNotice('Reviewer verification failed. Access denied.')
        return
      }

      const data = await resp.json()
      if (data?.isReviewer) {
        const reviewerEmail = result.user.email?.toLowerCase() ?? ''
        setProfile((current) => ({
          ...current,
          name: result.user.displayName?.split(' ')[0] || current.name,
          email: reviewerEmail || current.email,
        }))
        setReviewerLoggedIn(true)
        setReviewerSelectedSubmissionId(submissions[0]?.id ?? null)
        setScreen('reviewer-dashboard')
        setReviewNotice('')
        return
      }

      await signOut(auth)
      setReviewerLoggedIn(false)
      setReviewNotice('Your google account is not authorized as a reviewer')
    } catch (error) {
      console.error('Reviewer sign-in error', error)
      setReviewNotice(error?.message || 'Google sign-in did not complete.')
    }
  }

  const sendReviewerFeedback = () => {
    if (!reviewerSelectedSubmission) return

    const persistFeedback = async () => {
      if (!hasFirebaseConfig || !db) {
        setReviewNotice('Feedback cannot be saved: server not configured.')
        return
      }

      try {
        const submissionDoc = doc(db, 'submissions', reviewerSelectedSubmission.id)
        await updateDoc(submissionDoc, {
          reviewStatus: 'Feedback ready',
          responseTime: 'Sent today',
          feedback: {
            overall: reviewerFeedback.overall,
            strengths: reviewerFeedback.strengths,
            areas: reviewerFeedback.areas,
            voice: reviewerFeedback.voice,
            next: reviewerFeedback.next,
          },
          responded_at: serverTimestamp(),
          questionReplies: [],
        })

        setFeedbackSubmittedMessage('feedback submitted.')
        setReviewNotice('')
        setScreen('reviewer-dashboard')
      } catch (err) {
        console.error('Error saving feedback:', err)
        setReviewNotice('Unable to save feedback. Please try again.')
      }
    }

    persistFeedback()
  }

  const sendChatMessage = (event) => {
    event.preventDefault()
    if (!chatDraft.trim()) return
    setChatMessages((current) => [...current, { id: Date.now(), from: 'reviewer', text: chatDraft }])
    setChatDraft('')
  }

  const sendQuestion = (event) => {
    event.preventDefault()
    if (!selectedSubmission || !questionDraft.trim()) return
    const persistQuestion = async () => {
      if (!hasFirebaseConfig || !db) {
        setReviewNotice('Unable to send your question: server not configured.')
        return
      }

      try {
        const submissionDoc = doc(db, 'submissions', selectedSubmission.id)
        const reply = { id: Date.now(), text: questionDraft }
        await updateDoc(submissionDoc, {
          questionReplies: arrayUnion(reply),
        })
        setQuestionDraft('')
        setQuestionOpen(false)
        setReviewNotice('Your question has been shared with the reviewer.')
      } catch (err) {
        console.error('Error saving question reply:', err)
        setReviewNotice('Unable to send your question. Please try again.')
      }
    }

    persistQuestion()
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => setScreen('landing')}>
          <span className="brand-mark">✦</span>
          DraftSpace
        </button>
        <nav className="topnav" aria-label="Primary navigation">
          <button type="button" onClick={() => setScreen('landing')}>Home</button>
          <button type="button" onClick={openAuth}>Create account</button>
          <button type="button" onClick={() => setScreen('reviewer-login')}>
            Reviewer access
          </button>
        </nav>
      </header>

      <main id="top">
        <div key={screen} className="page-transition">
        {screen === 'landing' && (
          <>
            <section className="hero section">
              <div className="hero-copy">
                <p className="eyebrow">A calmer place to grow your writing</p>
                <h1>Let your words meet thoughtful readers.</h1>
                <p className="hero-text">
                  DraftSpace is a free space where students submit work and receive warm,
                  human feedback that protects their voice instead of flattening it.
                </p>
                <div className="hero-actions">
                  <button type="button" className="button primary" onClick={openAuth}>
                    Create your account
                  </button>
                  <button type="button" className="button secondary" onClick={() => setScreen('reviewer-login')}>
                    Reviewer access
                  </button>
                </div>
                <ul className="hero-highlights">
                  <li>Free for students</li>
                  <li>Thoughtful feedback</li>
                  <li>Voice first</li>
                </ul>
              </div>

              <div className="hero-visual" aria-hidden="true">
                <svg viewBox="0 0 560 420" role="presentation">
                  <rect x="44" y="60" width="320" height="250" rx="28" className="card-shape" />
                  <rect x="82" y="102" width="110" height="14" rx="7" className="line-shape" />
                  <rect x="82" y="132" width="190" height="10" rx="5" className="line-shape faint" />
                  <rect x="82" y="154" width="170" height="10" rx="5" className="line-shape faint" />
                  <rect x="82" y="188" width="120" height="72" rx="14" className="note-shape" />
                  <rect x="220" y="188" width="96" height="72" rx="14" className="note-shape" />
                  <circle cx="420" cy="156" r="70" className="person-shape" />
                  <rect x="382" y="220" width="82" height="92" rx="24" className="person-shape" />
                  <rect x="388" y="250" width="70" height="58" rx="20" className="person-shape soft" />
                  <path d="M376 118c10-35 56-46 86-22" className="line-shape" />
                  <path d="M188 304c18 24 64 31 92 8" className="line-shape" />
                </svg>
              </div>
            </section>

            <section id="why" className="section split-section">
              <div className="section-copy">
                <p className="eyebrow">Why DraftSpace exists</p>
                <h2>Students need readers, not just corrections.</h2>
                <p>
                  Teachers are stretched thin, and AI tools can clean up grammar while
                  quietly removing personality. DraftSpace is built for the kind of feedback
                  that helps a writer feel more certain about their own voice.
                </p>
              </div>
              <div className="card card-soft">
                <h3>What makes it different</h3>
                <ul className="bullet-list">
                  <li>Feedback from real students who care about language and ideas.</li>
                  <li>Comments that point to strengths before discussing growth.</li>
                  <li>Room for conversation, not just one-way notes.</li>
                </ul>
              </div>
            </section>

            <section id="difference" className="section">
              <div className="section-intro">
                <p className="eyebrow">A different kind of tool</p>
                <h2>Not a rewrite engine. A conversation partner.</h2>
              </div>
              <div className="feature-grid">
                <article className="feature-card">
                  <h3>Human warmth</h3>
                  <p>Every interaction feels like an attentive reader leaning in.</p>
                </article>
                <article className="feature-card">
                  <h3>Voice first</h3>
                  <p>Reviewers call out where the writer sounds most like themselves.</p>
                </article>
                <article className="feature-card">
                  <h3>Mentorship over correction</h3>
                  <p>Questions invite deeper thinking rather than instant fixes.</p>
                </article>
              </div>
            </section>
          </>
        )}

        {screen === 'auth' && (
          <section className="flow-card">
            <p className="eyebrow">Create your account</p>
            <h2>Sign in with Google to begin.</h2>
            <p className="flow-copy">
              A simple account creates a calm home for your drafts and the feedback that follows.
            </p>
            <button type="button" className="button primary large" onClick={handleGoogleSignIn}>
              Continue with Google
            </button>
            {authMessage && <p className="tiny-note">{authMessage}</p>}
            {!hasFirebaseConfig && (
              <p className="tiny-note">
                This app is ready for Google auth. Add your Firebase credentials to the environment file to activate it.
              </p>
            )}
          </section>
        )}

        {screen === 'onboarding' && (
          <section className="flow-card">
            <p className="eyebrow">A brief welcome</p>
            <h2>Tell us a little about your writing life.</h2>
            <form onSubmit={handleOnboardingSubmit} className="stacked-form">
              <label className="field">
                <span>What grade level are you in?</span>
                <select
                  value={profile.grade}
                  onChange={(event) => setProfile((current) => ({ ...current, grade: event.target.value }))}
                >
                  {gradeOptions.map((grade) => (
                    <option key={grade} value={grade}>
                      {grade}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="field">
                <legend>What kinds of writing do you usually work on?</legend>
                <div className="chip-grid">
                  {interestOptions.map((option) => (
                    <label key={option} className={`chip ${profile.interests.includes(option) ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={profile.interests.includes(option)}
                        onChange={() =>
                          setProfile((current) => ({
                            ...current,
                            interests: toggleSelection(current.interests, option),
                          }))
                        }
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="field">
                <legend>Why did you join DraftSpace?</legend>
                <div className="chip-grid">
                  {reasonOptions.map((option) => (
                    <label key={option} className={`chip ${profile.reasons.includes(option) ? 'active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={profile.reasons.includes(option)}
                        onChange={() =>
                          setProfile((current) => ({
                            ...current,
                            reasons: toggleSelection(current.reasons, option),
                          }))
                        }
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <button type="submit" className="button primary">
                Continue to your dashboard
              </button>
            </form>
          </section>
        )}

        {screen === 'dashboard' && (
          <section className="dashboard-shell">
            <div className="dashboard-header">
              <div>
                <p className="eyebrow">Welcome back</p>
                <h2>Hello, {profile.name}.</h2>
                <p className="flow-copy">
                  Your drafts are safe here, and your reviewers will help you keep your voice intact.
                </p>
              </div>
              <div className="dashboard-actions">
                <button type="button" className="button primary" onClick={startNewSubmission}>
                  Start a new submission
                </button>
                <button type="button" className="button secondary" onClick={handleSignOut}>
                  Sign out
                </button>
              </div>
            </div>

            {submissions.length === 0 ? (
              <div className="empty-state">
                <h3>Your writing home is ready.</h3>
                <p>Share a draft whenever you are ready and we will connect you with a thoughtful reader.</p>
                <button type="button" className="button primary" onClick={startNewSubmission}>
                  Submit your first draft
                </button>
              </div>
            ) : (
              <div className="submission-grid">
                {submissions.map((item) => (
                  <article key={item.id} className="submission-card">
                    <div className="submission-card-top">
                      <div>
                        <p className="tiny-note">{item.submittedAt}</p>
                        <h3>{item.title}</h3>
                      </div>
                      <span className={`status-pill ${item.reviewStatus === 'Feedback ready' ? 'ready' : ''}`}>
                        {item.reviewStatus}
                      </span>
                    </div>
                    <p className="flow-copy">{item.writingType.join(', ')}</p>
                    <p className="flow-copy">Expected response: {item.responseTime}</p>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setSelectedSubmissionId(item.id)
                          setScreen('feedback')
                        }}
                      >
                        {item.feedback ? 'Open feedback' : 'View draft'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {screen === 'submission-step-1' && (
          <section className="flow-card">
            <p className="eyebrow">Step 1 of 3</p>
            <h2>Share your draft.</h2>
            <p className="flow-copy">
              Paste your work here and give it a title. A thoughtful reviewer will see the piece as you intended.
            </p>
            <form className="stacked-form" onSubmit={(event) => event.preventDefault()}>
              <label className="field">
                <span>What is this piece called?</span>
                <input
                  value={draftForm.title}
                  onChange={(event) => setDraftForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="My essay on home"
                />
              </label>

              <label className="field">
                <span>Paste your writing here</span>
                <textarea
                  rows="10"
                  value={draftForm.draft}
                  onChange={(event) => setDraftForm((current) => ({ ...current, draft: event.target.value }))}
                  placeholder="Start pasting your draft..."
                />
              </label>
              <div className="form-actions">
                <button type="button" className="button secondary" onClick={goToDashboard}>
                  Cancel
                </button>
                <button type="button" className="button primary" onClick={handleWizardNext}>
                  Continue
                </button>
              </div>
            </form>
          </section>
        )}

        {screen === 'submission-step-2' && (
          <section className="flow-card">
            <p className="eyebrow">Step 2 of 3</p>
            <h2>What kind of writing is this?</h2>
            <p className="flow-copy">
              Select one or more categories so the reviewer can read with the right context.
            </p>
            <div className="chip-grid">
              {writingOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`chip ${draftForm.writingType.includes(option) ? 'active' : ''}`}
                  onClick={() =>
                    setDraftForm((current) => ({
                      ...current,
                      writingType: toggleSelection(current.writingType, option),
                    }))
                  }
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="form-actions">
              <button type="button" className="button secondary" onClick={() => goToSubmissionStep(1)}>
                Back
              </button>
              <button type="button" className="button primary" onClick={handleWizardNext}>
                Continue
              </button>
            </div>
          </section>
        )}

        {screen === 'submission-step-3' && (
          <section className="flow-card">
            <p className="eyebrow">Step 3 of 3</p>
            <h2>Share any extra context.</h2>
            <p className="flow-copy">
              This part is optional. Add anything that might help your reviewer understand your intention.
            </p>
            <form className="stacked-form" onSubmit={(event) => event.preventDefault()}>
              <label className="field">
                <span>What are you most worried about with this piece?</span>
                <textarea
                  rows="4"
                  value={draftForm.context}
                  onChange={(event) => setDraftForm((current) => ({ ...current, context: event.target.value }))}
                  placeholder="I am unsure whether the ending feels earned..."
                />
              </label>
              <div className="form-actions">
                <button type="button" className="button secondary" onClick={() => goToSubmissionStep(2)}>
                  Back
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={handleWizardNext}
                  disabled={!authResolved || !authUid || !hasFirebaseConfig}
                >
                  Send submission
                </button>
                {(!authResolved || !authUid || !hasFirebaseConfig) && (
                  <p className="tiny-note">Sign in required and server must be configured to submit.</p>
                )}
              </div>
            </form>
          </section>
        )}

        {screen === 'submission-success' && (
          <section className="flow-card success-card">
            <div className="checkmark">✓</div>
            <p className="eyebrow">Submission received</p>
            <h2>Your draft is on its way.</h2>
            <p className="flow-copy">
              A reviewer will respond within 72 hours, and a confirmation email has been queued for you.
            </p>
            <div className="card-actions">
              <button type="button" className="button primary" onClick={goToDashboard}>
                Return to your dashboard
              </button>
            </div>
          </section>
        )}

        {screen === 'feedback' && selectedSubmission && (
          <section className="feedback-shell">
            <div className="feedback-essay">
              <div className="feedback-header">
                <div>
                  <p className="eyebrow">Feedback for {selectedSubmission.title}</p>
                  <h2>Your reviewer’s notes</h2>
                  <p className="tiny-note">
                    {selectedSubmission.respondedAt ? `Responded ${selectedSubmission.respondedAt}` : 'Awaiting feedback'}
                  </p>
                </div>
                <button type="button" className="button secondary" onClick={goToDashboard}>
                  Back to dashboard
                </button>
              </div>

              <div className="essay-panel">
                <h3>Your draft</h3>
                <p>{selectedSubmission.draft}</p>
              </div>

              <div className="comment-stack">
                {selectedSubmission.comments?.map((comment) => (
                  <article key={comment.id} className="comment-card">
                    <p className="comment-passage">“{comment.passage}”</p>
                    <p>{comment.note}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className="feedback-sidebar">
              <div className="card card-soft">
                <h3>Overall impression</h3>
                <p>{selectedSubmission.feedback?.overall ?? 'Your reviewer will leave thoughtful notes here once the feedback is ready.'}</p>
              </div>
              <div className="card card-soft">
                <h3>Strengths</h3>
                <p>{selectedSubmission.feedback?.strengths ?? 'A warm note about what is already working.'}</p>
              </div>
              <div className="card card-soft">
                <h3>Your voice</h3>
                <p>{selectedSubmission.feedback?.voice ?? 'A reminder of what makes your writing feel like you.'}</p>
              </div>
              <div className="card card-soft">
                <h3>Next steps</h3>
                <p>{selectedSubmission.feedback?.next ?? 'A few gentle questions to keep the conversation going.'}</p>
              </div>
              <div className="card card-soft">
                <h3>Questions for your reviewer</h3>
                <button type="button" className="button secondary full" onClick={() => setQuestionOpen((current) => !current)}>
                  Any questions about the feedback?
                </button>
                {questionOpen && (
                  <form className="stacked-form small" onSubmit={sendQuestion}>
                    <textarea
                      rows="4"
                      value={questionDraft}
                      onChange={(event) => setQuestionDraft(event.target.value)}
                      placeholder="Ask a follow-up question..."
                    />
                    <button type="submit" className="button primary full">
                      Send question
                    </button>
                  </form>
                )}
                {selectedSubmission.questionReplies?.length > 0 && (
                  <div className="comment-stack">
                    {selectedSubmission.questionReplies.map((reply) => (
                      <article key={reply.id} className="comment-card">
                        <p>{reply.text}</p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {screen === 'reviewer-login' && (
          <section className="flow-card">
            <p className="eyebrow">Reviewer access</p>
            <h2>Sign in to review student submissions.</h2>
            <button type="button" className="button primary large" onClick={handleReviewerGoogleSignIn}>
              Continue with Google as reviewer
            </button>
            <p className="tiny-note">Use your approved reviewer Google account to enter the workspace.</p>
            {reviewNotice && <p className="tiny-note">{reviewNotice}</p>}
          </section>
        )}

        {screen === 'reviewer-dashboard' && reviewerLoggedIn && (
          <section className="reviewer-shell">
            <div className="dashboard-header">
              <div>
                <p className="eyebrow">Reviewer workspace</p>
                <h2>New submissions ready for you.</h2>
                <p className="flow-copy">
                  Help the writer think more deeply rather than rewrite their work for them.
                </p>
              </div>
              <div className="reviewer-actions">
                <button type="button" className="button secondary" onClick={() => setScreen('reviewer-login')}>
                  Sign out
                </button>
                <button type="button" className="button primary" onClick={() => setScreen('reviewer-dashboard')}>
                  Open messages
                </button>
              </div>
            </div>

            <div className="reviewer-grid">
              <aside className="reviewer-list card">
                <h3>Assigned submissions</h3>
                {submissions.length === 0 ? (
                  <p className="flow-copy">No student drafts yet.</p>
                ) : (
                  submissions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`submission-item review-item ${reviewerSelectedSubmissionId === item.id ? 'selected' : ''}`}
                      onClick={() => setReviewerSelectedSubmissionId(item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>{item.reviewStatus}</span>
                    </button>
                  ))
                )}
              </aside>

              <div className="reviewer-workspace card">
                {reviewerSelectedSubmission ? (
                  <>
                    <div className="feedback-header">
                      <div>
                        <p className="eyebrow">Currently reviewing</p>
                        <h3>{reviewerSelectedSubmission.title}</h3>
                        <p className="tiny-note">Submitted {reviewerSelectedSubmission.submittedAt}</p>
                      </div>
                      <button type="button" className="button secondary" onClick={() => setScreen('reviewer-chat')}>
                        Open live chat
                      </button>
                    </div>

                    <div className="reviewer-body">
                      <div className="essay-panel">
                        <h4>Student draft</h4>
                        <p>{reviewerSelectedSubmission.draft}</p>
                      </div>
                      <div className="feedback-form">
                        <label className="field">
                          <span>Overall impression</span>
                          <textarea
                            rows="3"
                            value={reviewerFeedback.overall}
                            onChange={(event) => setReviewerFeedback((current) => ({ ...current, overall: event.target.value }))}
                            placeholder="What stood out?"
                          />
                        </label>
                        <label className="field">
                          <span>Strengths</span>
                          <textarea
                            rows="3"
                            value={reviewerFeedback.strengths}
                            onChange={(event) => setReviewerFeedback((current) => ({ ...current, strengths: event.target.value }))}
                            placeholder="Name the places where the voice feels especially alive."
                          />
                        </label>
                        <label className="field">
                          <span>Areas to improve</span>
                          <textarea
                            rows="3"
                            value={reviewerFeedback.areas}
                            onChange={(event) => setReviewerFeedback((current) => ({ ...current, areas: event.target.value }))}
                            placeholder="Suggest one or two thoughtful next steps."
                          />
                        </label>
                        <label className="field">
                          <span>Your voice section</span>
                          <textarea
                            rows="3"
                            value={reviewerFeedback.voice}
                            onChange={(event) => setReviewerFeedback((current) => ({ ...current, voice: event.target.value }))}
                            placeholder="Call out a moment that feels unmistakably the student’s."
                          />
                        </label>
                        <label className="field">
                          <span>Next steps</span>
                          <textarea
                            rows="3"
                            value={reviewerFeedback.next}
                            onChange={(event) => setReviewerFeedback((current) => ({ ...current, next: event.target.value }))}
                            placeholder="Ask one or two guiding questions."
                          />
                        </label>
                        <button type="button" className="button primary" onClick={sendReviewerFeedback}>
                          Send feedback
                        </button>
                        {feedbackSubmittedMessage && <p className="tiny-note">{feedbackSubmittedMessage}</p>}
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="flow-copy">Choose a submission to begin reviewing.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {screen === 'reviewer-chat' && reviewerLoggedIn && (
          <section className="flow-card chat-card">
            <div className="feedback-header">
              <div>
                <p className="eyebrow">Live conversation</p>
                <h2>Message with a student in real time.</h2>
              </div>
              <button type="button" className="button secondary" onClick={() => setScreen('reviewer-dashboard')}>
                Back to workspace
              </button>
            </div>
            <div className="chat-window">
              {chatMessages.map((message) => (
                <div key={message.id} className={`chat-bubble ${message.from === 'reviewer' ? 'reviewer' : 'student'}`}>
                  {message.text}
                </div>
              ))}
            </div>
            <form className="chat-form" onSubmit={sendChatMessage}>
              <input
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                placeholder="Write a message to the student..."
              />
              <button type="submit" className="button primary">
                Send
              </button>
            </form>
          </section>
        )}
        </div>
      </main>

      <footer className="footer">
        <div>
          <strong>DraftSpace</strong>
          <p>Free feedback for students who want to be heard.</p>
        </div>
        <div>
          <strong>Contact</strong>
          <a href="mailto:hello@draftspace.studio">hello@draftspace.studio</a>
        </div>
        <div>
          <strong>Explore</strong>
          <a href="#why">Why it exists</a>
          <a href="#preview">Product preview</a>
        </div>
        <p className="footer-note">Great writing grows through conversation.</p>
      </footer>
    </div>
  )
}

export default App
