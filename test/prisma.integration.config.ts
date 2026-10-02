import { defineConfig } from 'prisma/config';

const backendRoot = process.cwd();

export default defineConfig({
  schema: `${backendRoot}/prisma/`,
  migrations: {
    path:
      process.env['CODEKIDS_IT_MIGRATIONS'] ??
      `${backendRoot}/prisma/migrations`,
    seed: `tsx ${backendRoot}/prisma/seed.ts`,
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
