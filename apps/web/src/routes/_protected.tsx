import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { ApplicationShell } from "@/components/app-shell";
import { getSession } from "@/lib/auth.functions";
import { client } from "@/orpc/client";

export const Route = createFileRoute("/_protected")({
	beforeLoad: async () => {
		const session = await getSession();

		if (!session) {
			throw redirect({ to: "/login" });
		}

		return { user: session.user };
	},
	loader: () => client.journeys.list({}),
	component: ProtectedLayout,
});

function ProtectedLayout() {
	const { user } = Route.useRouteContext();
	const journeys = Route.useLoaderData();

	return (
		<ApplicationShell
			user={{
				name: user.name,
				email: user.email,
				avatar: user.image ?? "",
			}}
			journeys={journeys}
		>
			<Outlet />
		</ApplicationShell>
	);
}
