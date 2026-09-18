import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import * as fs from 'node:fs';
import * as path from 'node:path';

const client = new SecretsManagerClient({
  customUserAgent: process.env.USER_AGENT_STRING,
});

interface RdsSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

async function getDatabaseCredentials(secretArn: string): Promise<RdsSecret> {
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  if (!response.SecretString) {
    throw new Error("Database secret has no SecretString");
  }

  return JSON.parse(response.SecretString) as RdsSecret;
}

export const handler = async () => {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    throw new Error("DATABASE_SECRET_ARN environment variable is not set");
  }

  const credentials = await getDatabaseCredentials(secretArn);

  const pool = new Pool({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    // The RDS CA bundle is copied next to this file at bundling time (see
    // database.ts commandHooks) so the server certificate is fully verified.
    ssl: {
      ca: fs.readFileSync(path.join(__dirname, "rds-global-bundle.pem"), "utf8"),
      rejectUnauthorized: true,
    },
  });

  try {
    const db = drizzle(pool);
    const migrationsFolder = path.join(__dirname, "drizzle");

    console.log(`Running migrations from ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log("Migrations complete.");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Migrations applied successfully" }),
    };
  } finally {
    await pool.end();
  }
}