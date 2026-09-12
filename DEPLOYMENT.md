# Kirana Ledger — Render & Supabase Deployment Guide

This document outlines the production deployment procedure for the **Kirana Ledger backend** on **Render (Free Web Service)** connecting to a hosted **Supabase PostgreSQL** database (`ap-south-1` / Mumbai).

---

## 1. Architecture Overview

```
Client (Web / Mobile Frontend)
       │ HTTPS
       ▼
Render Free Web Service (Docker)
  ├── Runtime: Node.js 20+ (Alpine)
  ├── Process: node dist/server.js
  ├── Injected PORT: Set dynamically by Render
  └── Connection Pool: pg.Pool (DATABASE_POOL_SIZE: 5)
       │
       │ Runtime Application Traffic (Port 6543, Transaction Mode)
       ├──────────────────────────────────────────────┐
       │                                              ▼
       │                            Supabase PostgreSQL (ap-south-1 / Mumbai)
       │                            ├── Supavisor Transaction Pooler (Port 6543)
       │                            └── Direct PostgreSQL Connection (Port 5432)
       │                                              ▲
       │ Prisma CLI Migrations (Port 5432)            │
       └──────────────────────────────────────────────┘
```

---

## 2. Render Service Configuration

| Parameter | Configuration |
| :--- | :--- |
| **Service Type** | Web Service |
| **Runtime / Environment** | Docker |
| **Instance Type** | Free ($0/month) — *No credit card or payment method required* |
| **Dockerfile Path** | `./Dockerfile` |
| **Docker Context** | `.` |
| **Health Check Path** | `/health` |

> **Note on Free Tier Behavior**: Render Free Web Services automatically spin down after 15 minutes of inactivity. Incoming requests will trigger a cold start (typically 30–50 seconds) before responding. This behavior is expected and accepted for this deployment tier.

---

## 3. Environment Variables & Secret Configuration

Configure the following environment variables in the **Environment** section of the Render dashboard. Do not place real values or credentials in the repository.

| Variable Name | Purpose & Format Description |
| :--- | :--- |
| `NODE_ENV` | Set to `production` to activate production logging, strict Zod validation, and security headers. |
| `DATABASE_URL` | Supabase **Supavisor Transaction Pooler** connection string (Port `6543`) used for runtime application queries. |
| `DIRECT_URL` | Supabase **Direct PostgreSQL** connection string (Port `5432`) used for Prisma CLI migration deployment. |
| `DATABASE_SSL` | Set to `true` to enable TLS encryption for all database connections. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Set to `true` to enforce strict SSL/TLS certificate chain verification. |
| `DATABASE_POOL_SIZE` | Set to `5` to keep application pool connections comfortably within Supabase free-tier limits. |
| `JWT_SECRET` | High-entropy string (at least 32 characters) used to sign and verify authentication JWTs. Must not contain common placeholder words. |
| `JWT_EXPIRES_IN` | Token validity duration (e.g., `1d` for 1 day). |
| `NODE_EXTRA_CA_CERTS` | Set to `/app/certs/supabase-root.crt` to load the official Supabase Root 2021 CA certificate into the Node.js TLS trust store. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed frontend HTTPS domains (e.g., `https://your-frontend-app.onrender.com`). In production, this must not be `*`. |

---

## 4. Prisma Database Migrations

Database schema migrations must **only** be executed against the **Direct PostgreSQL endpoint** (`DIRECT_URL` on Port `5432`), as transaction-mode connection poolers do not support session-level advisory locking required for DDL migrations.

```bash
# Run migrations targeting the direct Supabase connection
export DIRECT_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres"
export NODE_EXTRA_CA_CERTS="./certs/supabase-root.crt"
npx prisma migrate deploy
```

> **Important**: Do **not** run `npx prisma migrate deploy` against the pooled `DATABASE_URL` (Port `6543`).

---

## 5. Supabase Database Configuration

- **Platform**: Hosted Supabase PostgreSQL instance in the South Asia (Mumbai / `ap-south-1`) region.
- **Runtime Traffic**: Routed through the Supavisor connection pooler on Port `6543` in transaction mode.
- **Migration & Admin Traffic**: Routed through the direct PostgreSQL endpoint on Port `5432`.
- **TLS Verification**: Secured with strict certificate verification anchored to `certs/supabase-root.crt`.
- **Data Persistence**: Supabase PostgreSQL serves as the persistent cloud source of truth.

---

## 6. Deployment Procedure

Follow these manual steps in the Render dashboard to deploy the backend:

1. Push the project repository (including `Dockerfile`, `certs/`, and `.dockerignore`) to GitHub.
2. Log in to the [Render Dashboard](https://dashboard.render.com).
3. Click **"New +"** &rarr; **"Web Service"**.
4. Select **"Build and deploy from a Git repository"** and connect your backend repository.
5. Enter service details:
   - **Name**: `kirana-ledger-backend` (or your preferred name)
   - **Region**: Singapore (Southeast Asia) or geographically closest region
   - **Branch**: `main`
   - **Runtime**: `Docker`
   - **Instance Type**: `Free`
6. Set **Dockerfile Path** to `./Dockerfile` and **Docker Context** to `.`.
7. Configure the environment variables listed in **Section 3** in the Environment settings tab.
8. Set **Health Check Path** to `/health`.
9. Click **"Deploy Web Service"**.
10. Monitor the build logs to confirm multi-stage compilation and container startup (`Server running in production mode on port ...`).
11. Copy the generated service URL (e.g., `https://kirana-ledger-backend.onrender.com`).
12. Verify the public health check:
    ```bash
    curl -i https://<your-service-name>.onrender.com/health
    ```
    Expected response:
    ```json
    {
      "status": "success",
      "message": "Server is healthy",
      "timestamp": "..."
    }
    ```
13. Verify that authenticated API requests reach Supabase PostgreSQL without connection or certificate errors.

---

## 7. Current Project Status

- **Database Initialization**: The Supabase production PostgreSQL database has been provisioned in the Mumbai region (`ap-south-1`).
- **Schema Deployment**: All 2 committed Prisma migrations (`20260804135514_init` and `20260820190800_add_interest_engine_and_targeted_settlement`) have been deployed to Supabase.
- **Data Status**: Supabase contains the complete relational schema (`users`, `customers`, `transactions`, `_prisma_migrations`) with zero application rows.
- **Local Isolation**: The local development PostgreSQL database remains untouched and available for local development and testing.
