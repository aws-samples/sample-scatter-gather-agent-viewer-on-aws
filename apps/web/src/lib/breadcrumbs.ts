import { useMatches } from "@tanstack/react-router";

export type Crumb = {
	label: string;
	/**
	 * Resolved pathname to navigate to, e.g. `/journeys/2f9c-…`. Defaults to the
	 * matched route's own pathname, so most routes never need to set it.
	 *
	 * Deliberately a plain string rather than TanStack's `LinkOptions`: this type
	 * ends up inside `StaticDataRouteOption`, which is part of a route's options,
	 * and a router-derived type there creates a circular type reference
	 * (route options -> staticData -> LinkOptions -> router -> route tree ->
	 * route options) that degrades every route to `any`.
	 */
	href?: string;
};

export type CrumbContext = {
	params: Record<string, string | undefined>;
	/** The route's own loader data. Cast it to the route's loader return type. */
	loaderData: unknown;
	/** Already interpolated, e.g. `/journeys/2f9c-…`. */
	pathname: string;
};

/**
 * A route's breadcrumb contribution. A bare string is the common case; return an
 * array to contribute a whole chain, or a function when the label depends on
 * loader data. Returning null contributes nothing.
 */
export type CrumbOption =
	| string
	| Crumb
	| Array<string | Crumb>
	| ((
			ctx: CrumbContext,
	  ) => string | Crumb | Array<string | Crumb> | null | undefined);

declare module "@tanstack/react-router" {
	// This member MUST stay optional. TanStack flips `staticData` from an
	// optional route option to a required one the moment this interface has a
	// required member, which would force every route in the app to declare it.
	interface StaticDataRouteOption {
		crumb?: CrumbOption;
	}
}

/**
 * Ancestor crumbs for routes whose parent isn't part of their match chain. The
 * route tree here is flat — `journeys/index.tsx` and `journeys/$journeyId.tsx`
 * are siblings rather than parent and child — so a child route names its
 * ancestors explicitly. Adding `journeys/route.tsx` and `agents/route.tsx`
 * layout routes would let these be inferred from the match chain instead.
 */
export const JOURNEYS_CRUMB: Crumb = { label: "Journeys", href: "/journeys" };
export const AGENTS_CRUMB: Crumb = { label: "Agents", href: "/agents" };

function toCrumb(value: string | Crumb): Crumb {
	return typeof value === "string" ? { label: value } : value;
}

/** The slice of a route match the resolver needs. */
type CrumbMatch = {
	params: unknown;
	loaderData?: unknown;
	pathname: string;
	staticData: { crumb?: CrumbOption };
};

/**
 * Builds the breadcrumb trail from whatever the matched routes declare. This
 * knows nothing about specific routes: a route opts in by setting
 * `staticData.crumb` and opts out by omitting it.
 */
export function resolveCrumbs(matches: readonly CrumbMatch[]): Crumb[] {
	return matches.flatMap((match): Crumb[] => {
		const crumb = match.staticData.crumb;
		if (!crumb) return [];

		const resolved =
			typeof crumb === "function"
				? crumb({
						params: match.params as Record<string, string | undefined>,
						loaderData: match.loaderData,
						pathname: match.pathname,
					})
				: crumb;

		if (resolved === null || resolved === undefined) return [];

		const entries = (Array.isArray(resolved) ? resolved : [resolved]).map(
			toCrumb,
		);

		return entries.map((entry, index) => {
			// The final entry stands in for this match, so it links to the match's own
			// pathname. Earlier entries are declared ancestors carrying their own href.
			const isSelf = index === entries.length - 1;
			if (entry.href || !isSelf) return entry;
			return { ...entry, href: match.pathname };
		});
	});
}

export function useBreadcrumbs(): Crumb[] {
	return resolveCrumbs(useMatches());
}
