import { Button } from "@/components/ui/button";
import { Field, FieldGroup } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export function LoginForm({
	className,
	...props
}: React.ComponentProps<"form">) {
	return (
		<form className={cn("flex flex-col gap-6", className)} {...props}>
			<FieldGroup>
				<div className="flex flex-col items-center gap-1 text-center">
					<h1 className="text-2xl font-bold">Scatter Gather Agent Viewer</h1>
				</div>
				<Field>
					<Button
						variant="outline"
						type="button"
						onClick={() => {
							void authClient.signIn.social({
								provider: "cognito",
								callbackURL: window.location.origin,
							});
						}}
					>
						Login with Cognito
					</Button>
				</Field>
			</FieldGroup>
		</form>
	);
}
