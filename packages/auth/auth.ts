import { db } from "@repo/database"; // your drizzle instance
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

// Comma-separated in deployed environments (set from the CloudFront domain);
// falls back to the local web dev server.
const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "http://localhost:3000")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

export const auth = betterAuth({
	trustedOrigins,
	database: drizzleAdapter(db, {
		provider: "pg",
	}),
	socialProviders: {
		cognito: {
			clientId: process.env.COGNITO_CLIENT_ID!,
			clientSecret: process.env.COGNITO_CLIENT_SECRET!,
			domain: process.env.COGNITO_DOMAIN!, // e.g. "your-app.auth.us-east-1.amazoncognito.com"
			region: process.env.COGNITO_REGION!, // e.g. "us-east-1"
			userPoolId: process.env.COGNITO_USERPOOL_ID!,
		},
	},
});
