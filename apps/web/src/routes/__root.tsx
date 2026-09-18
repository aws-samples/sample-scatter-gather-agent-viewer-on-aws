import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";

import globalsCss from "../styles/globals.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Scatter Gather Agent Viewer" },
			{
				name: "description",
				content:
					"Sample console for running scatter-gather migration assessments with Amazon Bedrock AgentCore agents",
			},
		],
		links: [
			{ rel: "stylesheet", href: globalsCss },
			{ rel: "icon", href: "/logo.svg", type: "image/svg+xml" },
			{ rel: "alternate icon", href: "/favicon.ico" },
		],
	}),
	notFoundComponent: () => <p>Page not found</p>,
	component: RootComponent,
});

function RootComponent() {
	return (
		<RootDocument>
			<Outlet />
		</RootDocument>
	);
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				<ThemeProvider defaultTheme="system" storageKey="theme">
					{children}
				</ThemeProvider>
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
