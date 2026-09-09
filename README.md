# Task Board

### 🔗 Live application: [https://app-board.pages.dev](https://app-board.pages.dev)

Multi-tenant SaaS platform for project management, task tracking, and team collaboration.

## Tech Stack

| Layer    | Technology                                  |
| -------- | ------------------------------------------- |
| Frontend | Angular 22, Spartan UI, Tailwind CSS        |
| Backend  | Hono (Cloudflare Workers), MongoDB          |
| Shared   | Zod v4 schemas, TypeScript contracts        |
| Tooling  | Vitest, Playwright, ESLint, Prettier, Husky |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [Docker](https://www.docker.com/) (for MongoDB)
- npm (comes with Node.js)

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/Nikolai-Adamovich/task-board.git
cd task-board
npm install
```

### 2. Start MongoDB (single-node replica set)

MongoDB **must run as a replica set** — project creation seeds statuses, task types and the default board inside a
MongoDB transaction (DEC-025), which a standalone `mongod` cannot execute. Use the provided compose file; it starts
`mongod --replSet rs0` and runs `rs.initiate()` automatically via healthcheck:

```bash
docker compose up -d        # first start initiates the replica set
```

On subsequent runs (e.g. after reboot):

```bash
docker compose start
```

> **Production / Atlas:** MongoDB Atlas Free tiers are replica sets out of the box — no extra configuration needed.

> **Fallback:** if the server detects a topology without transaction support (e.g. a plain standalone `mongod`), it logs
> a warning and falls back to the legacy compensating-cleanup seed so local development does not hard-fail. The atomic
> transaction path is the primary mechanism everywhere else.

### 3. Configure environment

Create `server/.dev.vars`:

```env
MONGODB_URI=mongodb://localhost:27017/task-board?replicaSet=rs0&directConnection=true
JWT_SECRET=<your-generated-secret>
```

Generate a random secret for local development:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output as the `JWT_SECRET` value.

### 4. Start the application

One-command alternative (builds shared, starts MongoDB via docker compose, launches server + ui in a zellij layout;
assumes Docker, zellij and konsole):

```bash
./start-local.sh
```

Or open two terminals manually:

```bash
# Terminal 1 — Backend API (http://localhost:8787)
npm run dev -w server
```

```bash
# Terminal 2 — Frontend UI (http://localhost:4200)
npm run start -w ui
```

Open **http://localhost:4200** in your browser.

## Development Scripts

| Command             | Description                        |
| ------------------- | ---------------------------------- |
| `npm run lint`      | Run ESLint across all workspaces   |
| `npm run lint:fix`  | Auto-fix lint issues               |
| `npm run format`    | Format code with Prettier          |
| `npm run build`     | Build all packages                 |
| `npm run test`      | Run all tests (shared, server, ui) |
| `npm run test:e2e`  | Run Playwright E2E tests           |
| `npm run typecheck` | Type-check shared and server       |

## Project Structure

```
task-board/
├── shared/          # Zod schemas, TypeScript types, API contracts
├── server/          # Hono API (Cloudflare Workers)
│   ├── src/
│   │   ├── middleware/   # Auth, RBAC, validation, error handling
│   │   ├── repositories/ # Data access layer
│   │   ├── routes/       # API endpoints
│   │   ├── services/     # Business logic
│   │   └── types/        # Server-specific types
│   └── .dev.vars         # Local env vars (git-ignored)
├── ui/              # Angular SPA
│   ├── src/
│   │   ├── app/
│   │   │   ├── features/   # Feature modules (auth, boards, etc.)
│   │   │   ├── guards/     # Route guards
│   │   │   ├── shell/      # App shell, header, sidebar
│   │   │   └── stores/     # State management
│   │   └── environments/   # Environment configs
│   └── e2e/              # Playwright E2E tests
└── docs/            # Architecture & specifications
```

## License

Private — not licensed for public distribution.
