# PI Backend - Node.js Express Server

Node.js Express server that handles all database interactions with Supabase.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Make sure `.env` file is configured with your Supabase credentials

3. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Environment Variables

All environment variables are configured in `.env` file:
- Supabase URL and keys
- PostgreSQL connection strings
- Server port

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /api/test` - Example endpoint (adjust based on your schema)

## Database

This server is the only component that directly interacts with the Supabase/PostgreSQL database. The frontend should make API calls to this server for all database operations.
