# GuestPilot v2

Multi-tenant AI guest services platform for serviced apartments. Automates guest communication across Airbnb, Booking.com, WhatsApp, and direct channels via Hostaway PMS integration.

## Folder Structure

- **backend/** — Express + Prisma + Claude AI backend
  - Deployed on Railway: https://backend-production-31542.up.railway.app
  - GitHub: https://github.com/tawakol2000/guestpilot-backend

- **frontend/** — Next.js 16 + React 19 frontend
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
| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Auth token signing key |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `OPENAI_API_KEY` | No | OpenAI embeddings (RAG disabled without) |
| `COHERE_API_KEY` | No | Cohere embeddings + reranking |
| `REDIS_URL` | No | BullMQ queue (falls back to polling) |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse observability |
| `LANGFUSE_SECRET_KEY` | No | Langfuse observability |
| `LANGFUSE_HOST` | No | Default: https://cloud.langfuse.com |
| `NODE_ENV` | No | `production` for Railway |
| `CORS_ORIGINS` | No | Comma-separated frontend URLs |
| `RAILWAY_PUBLIC_DOMAIN` | No | Public URL for webhooks |
| `DRY_RUN` | No | Restrict messages to specific conversation IDs |

### Frontend (Vercel)
| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | Backend API URL |

## Deployment

Both services auto-deploy on push to GitHub:
- Backend: Push to `tawakol2000/guestpilot-backend` main branch
- Frontend: Push to `tawakol2000/v0-inbox-dashboard` main branch

## Important Notes

- Database: Railway PostgreSQL (internal networking within same project)
- Webhooks: Set Hostaway webhook to `https://backend-production-31542.up.railway.app/webhooks/hostaway/{tenantId}`
- See `SPEC.md` for complete system specification
- See `CLAUDE.md` for AI assistant context
