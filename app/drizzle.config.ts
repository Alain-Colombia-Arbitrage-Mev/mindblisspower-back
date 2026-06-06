import { defineConfig } from 'drizzle-kit';

// Drizzle Kit reads only the mlm + auth schemas. Catalogs and audit are
// read/written via raw SQL through the same client; no Drizzle codegen needed.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema/auth.ts', './src/db/schema/mlm.ts'],
  out: './drizzle',
  schemaFilter: ['auth', 'mlm'],
  dbCredentials: { url: process.env.DATABASE_URL! },
  // Never let drizzle-kit drop columns automatically — schema_mlm.sql owns the
  // shape. drizzle migrations only add things the app needs (e.g. new auth
  // tables added in Better Auth upgrades).
  strict: true,
  verbose: true,
});
