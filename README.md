# aivorah-platform-admin-service

Backend for the internal Aivorah Admin panel (platform super admin, not school admin): overview, students, teachers, schools, admin users, LLM usage stats and AI insights, bulk import.

**Called by:** frontend Aivorah Admin persona (`src/screens/aivorah-admin`).

## Endpoints
| Route | What it does |
|---|---|
| `GET /overview` | Platform totals |
| `/students` | List, assign teacher, bulk create, bulk import (Excel) |
| `GET /teachers` | List teachers |
| `/schools` | List schools, school structure, edit school |
| `/admin/users` | Admin users: list, create, edit, block/unblock (single + bulk), reset password |
| `GET /llm-stats, /llm-stats/insights` | LLM usage numbers and AI-written insights |
| `GET /charts-data` | Dashboard chart data |
| `GET /health` | Health check |

## Run locally
```bash
npm ci
cp .env.example .env   # fill in values; see table below
npm run dev            # nodemon, port 3023
```

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `3023`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project and service-role key (server-only, never expose) |
| `FIREBASE_SERVICE_ACCOUNT` or `FIREBASE_SERVICE_ACCOUNT_B64` | Firebase Admin credentials (JSON, or base64 of the JSON) |
| `ADMIN_EMAILS`, `ADMIN_EMAIL` | Who may call this service (comma-separated) |
| `FIREBASE_API_KEY` | Firebase Web API key, used to create accounts |
| `AUTH_SERVICE_URL` | aivorah-auth-service base URL (password reset) |
| `APP_URL` | App link used in emails |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | AI insights on LLM usage |
| `RESEND_API_KEY` / `EMAIL_USER`, `EMAIL_PASS` | Outgoing email: Resend, or Gmail SMTP as fallback |

## Tests
```bash
npm test
```

## Deploy
- **Render** web service `aivorah-platform-admin-service` → https://aivorah-platform-admin-service-vaeu.onrender.com
- Auto-deploys from `main`. Build `npm install`, start `npm start`.
- CI: no CI config yet; run `npm test` before merging
- After a merge, check the live commit on Render matches the branch head.

## Auth
Every route goes through `requireAdmin`: valid Firebase ID token and an email listed in `ADMIN_EMAILS`.

## Folder layout
| Path | Why it exists |
|---|---|
| `index.js` | Express app: middleware, route mounting, `/health`, listen |
| `routes/` | One file per admin area (overview, students, teachers, schools, adminUsers, llmStats, charts-data) |
| `middleware/` | `auth.js`: `requireAdmin` (Firebase token + email in `ADMIN_EMAILS`) |
| `services/` | Account creation, bulk import, curriculum, LLM stats/insights, mailer, Supabase/Firebase clients |
| `tests/` | Jest tests |
