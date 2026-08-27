Supabase Edge Function: verify-reviewer

Overview
- This Edge Function verifies a Firebase ID token (issued after Google sign-in) and checks the `reviewers` table in Supabase for a matching `firebase_uid`.
- The frontend obtains a Firebase ID token after Google sign-in and POSTs it to the Edge Function URL.

Files added
- `functions/verify-reviewer/index.ts` — Deno-compatible Edge Function.
- `src/App.jsx` — updated to remove local reviewer password login and call the Edge Function at `VITE_VERIFY_REVIEWER_URL`.

What you must configure in Supabase (Edge Function secrets)
- `SUPABASE_URL` — Your Supabase project URL (e.g., https://xyz.supabase.co)
- `SUPABASE_SERVICE_ROLE_KEY` — The service_role key (KEEP THIS SECRET; DO NOT PUT IT INTO THE FRONTEND)
- `FIREBASE_PROJECT_ID` — Your Firebase project id (used to validate token `iss` and `aud`)
- `ALLOWED_ORIGINS` — Optional; a comma-separated list of allowed origins for CORS. If not set the function will respond with `Access-Control-Allow-Origin: *`.

How the Edge Function is called (frontend)
- The frontend will POST `{ "idToken": "<FIREBASE_ID_TOKEN>" }` to the URL set in the environment variable `VITE_VERIFY_REVIEWER_URL`.
- The Edge Function returns JSON `{ isReviewer: true, role: <optional role> }` or `{ isReviewer: false }`.

What you must configure in GitHub (repo secrets)
- `VITE_VERIFY_REVIEWER_URL` — Public URL for your deployed Supabase Edge Function. This is the only new `VITE_` variable and is safe to include in the frontend build.
- Do NOT add `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, or `FIREBASE_PROJECT_ID` as `VITE_` secrets or anywhere in your frontend config.

Supabase Database and RLS notes
- Keep Row-Level Security (RLS) enabled on the `reviewers` table. Do NOT create a public SELECT policy.
- Reviewer onboarding: add rows to `reviewers` table with columns: `id`, `firebase_uid`, `email`, `role` (optional). Use Supabase Studio or server-side admin tooling.

Local testing notes
- You can test the function locally using Supabase CLI or by deploying it to your Supabase project and using the function URL.
- When testing locally, set environment variables in your local env (do NOT commit secrets).

Frontend behavior changes
- The old `VITE_APPROVED_REVIEWER_EMAILS` client-side whitelist and the reviewer username/password login were removed.
- After Google sign-in, the frontend obtains the Firebase ID token and calls the Edge Function. If `isReviewer: true`, reviewer UI is enabled; otherwise the user is signed out and shown an access denied message.

If you want, I can:
- Add a short admin script to batch-add reviewer rows to Supabase (example SQL or JS using the service_role key).
- Create a minimal test harness demonstrating a successful/failed verification (without embedding secrets).

Instructions I will follow next if you approve
- Add a short README entry into the app's main README describing the new secret(s) and deployment steps for the Edge Function.
- (Optional) Add an example admin script to add reviewers.

