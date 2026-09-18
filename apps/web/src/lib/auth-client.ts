import { createAuthClient } from "better-auth/react";

import { SERVICE_URL } from "@/lib/config";

export const authClient = createAuthClient({
	baseURL: SERVICE_URL,
});
