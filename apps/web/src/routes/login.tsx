import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "@/components/login-form";

export const Route = createFileRoute("/login")({
	component: LoginPage,
});

function LoginPage() {
	return (
		<div className="grid min-h-svh lg:grid-cols-2">
			<div className="flex flex-col gap-4 p-6 md:p-10">
				<div className="flex flex-1 items-center justify-center">
					<div className="w-full max-w-xs">
						<LoginForm />
					</div>
				</div>
			</div>
			<div
				aria-hidden="true"
				className="relative hidden items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 lg:flex"
			>
				<div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(34,211,238,0.25),transparent_50%),radial-gradient(circle_at_70%_80%,rgba(167,139,250,0.25),transparent_50%)]" />
				<img
					src="/logo.svg"
					alt=""
					className="relative size-40 drop-shadow-2xl"
				/>
			</div>
		</div>
	);
}
