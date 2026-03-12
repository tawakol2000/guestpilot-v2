# GuestPilot v2

Production deployment structure with clean separation of frontend and backend.

## Folder Structure

- **backend/** — Express + Prisma backend service
  - Deployed on Railway: https://backend-production-31542.up.railway.app
  - GitHub: https://github.com/tawakol2000/guestpilot-backend

- **frontend/** — Next.js 15 + React 19 frontend application
  - Deployed on Vercel: https://v0-inbox-dashboard-wrrb.vercel.app
  - GitHub: https://github.com/tawakol2000/v0-inbox-dashboard

## Setup

### Backend
```bash
cd backend
npm install
npm run build
npm run dev  # local development
```

### Frontend
```bash
cd frontend
npm install
npm run dev  # local development on localhost:3000
```

## Environment Variables

### Backend (Railway)
- `DATABASE_URL` — PostgreSQL connection
- `JWT_SECRET` — Auth token signing key
- `ANTHROPIC_API_KEY` — Claude API key
- `NODE_ENV` — `production`
- `CORS_ORIGINS` — Frontend URL for CORS
- `DRY_RUN` — Set to `true` to restrict messages to test conversation 40570028

### Frontend (Vercel)
- `NEXT_PUBLIC_API_URL` — Backend API URL

## Deployment

Both services auto-deploy on push to GitHub:
- Backend: Push to `tawakol2000/guestpilot-backend` main branch
- Frontend: Push to `tawakol2000/v0-inbox-dashboard` main branch

## Important Notes

- Database: Railway PostgreSQL (internal networking within same project)
- Messages: DRY_RUN=true restricts test sends to conversation 40570028
- Webhooks: Set Hostaway webhook to `https://backend-production-31542.up.railway.app/webhooks/hostaway/{tenantId}`
