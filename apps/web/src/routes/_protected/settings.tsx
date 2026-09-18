import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_protected/settings")({
	staticData: { crumb: "Settings" },
	component: SettingsPage,
});

function SettingsPage() {
	return (
		<div className="flex flex-col gap-2">
			<h1 className="text-2xl font-semibold">Settings</h1>
			<p className="text-muted-foreground">
				Configure your Scatter Gather Agent Viewer experience.
			</p>
		</div>
	);
}
