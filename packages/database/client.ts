import { readFileSync } from "node:fs";
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

/**
 * TLS settings for the Aurora connection.
 *
 * Aurora PostgreSQL 16+ ships with rds.force_ssl=1, so TLS is required, and
 * the RDS certificate authorities are not in the default trust store. The
 * container images download the RDS global CA bundle at build time and point
 * DB_SSL_CA_PATH at it so the server certificate is fully verified. Without a
 * bundle the connection still verifies against the system trust store, which
 * fails closed rather than silently skipping verification.
 */
function sslConfig(): PoolConfig["ssl"] {
	const caPath = process.env.DB_SSL_CA_PATH;
	if (!caPath) {
		return { rejectUnauthorized: true };
	}
	try {
		return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
	} catch (error) {
		// Fail loudly at startup rather than as an opaque 500 on the first query.
		throw new Error(
			`DB_SSL_CA_PATH is set to "${caPath}" but the file could not be read (${(error as Error).message}). Check the container image.`,
		);
	}
}

function poolConfig(): PoolConfig {
	// Local dev and drizzle-kit use a single connection string.
	if (process.env.DATABASE_URL) {
		return { connectionString: process.env.DATABASE_URL };
	}

	// In ECS the parts arrive separately: host and port from the cluster
	// endpoint, credentials injected from Secrets Manager.
	const host = process.env.DB_HOST;
	if (!host) {
		throw new Error(
			"Database is not configured. Set DATABASE_URL, or DB_HOST together with DB_PORT, DB_NAME, DB_USER and DB_PASSWORD.",
		);
	}

	return {
		host,
		port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
		database: process.env.DB_NAME,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		ssl: sslConfig(),
	};
}

const pool = new Pool(poolConfig());

export const db = drizzle({ client: pool, schema });
