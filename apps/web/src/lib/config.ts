/**
 * Base URL for the API that serves /rpc.
 *
 *  - local dev: VITE_API_URL (see scripts/setup-env.sh), i.e. the API dev server
 *  - production browser: same origin, so /rpc must be routed to the API at the
 *    edge — the API is private and not reachable directly from a browser
 *  - production server (in-cluster): the private Cloud Map address that
 *    ApiStack registers, passed through as API_URL
 */
export function getServiceUrl(): string {
	if (import.meta.env.DEV) {
		return import.meta.env.VITE_API_URL ?? "http://localhost:4000";
	}

	return typeof window !== "undefined"
		? window.location.origin
		: (process.env.API_URL ?? "http://localhost:4000");
}

export const SERVICE_URL = getServiceUrl();
