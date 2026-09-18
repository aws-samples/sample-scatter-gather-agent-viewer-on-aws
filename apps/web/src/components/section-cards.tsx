import type { AgentCoreStat, AgentCoreSummary } from "@repo/api/router";
import { TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardAction,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatCount(value: number) {
	return value >= 10_000 ? compact.format(value) : Math.round(value).toString();
}

function formatLatency(ms: number) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatHours(value: number) {
	if (value === 0) return "0";
	return value < 10 ? value.toFixed(2) : compact.format(value);
}

/**
 * Percent change against the previous window. Returns null when there's no
 * baseline to compare against, so the card can omit the badge instead of
 * claiming a misleading +100%.
 */
function percentChange({ current, previous }: AgentCoreStat) {
	if (previous === 0) return null;
	return ((current - previous) / previous) * 100;
}

function TrendBadge({ stat }: { stat: AgentCoreStat }) {
	const change = percentChange(stat);
	if (change === null) return null;

	const rising = change >= 0;
	const Icon = rising ? TrendingUpIcon : TrendingDownIcon;

	return (
		<Badge variant="outline">
			<Icon />
			{`${rising ? "+" : ""}${change.toFixed(1)}%`}
		</Badge>
	);
}

function trendLabel(stat: AgentCoreStat, lowerIsBetter = false) {
	const change = percentChange(stat);
	if (change === null) {
		return stat.current > 0 ? "No prior activity to compare" : "No activity";
	}
	if (Math.abs(change) < 1) return "Flat versus previous period";

	const rising = change >= 0;
	const good = lowerIsBetter ? !rising : rising;
	const direction = rising ? "Up" : "Down";
	return `${direction} ${Math.abs(change).toFixed(1)}% — ${good ? "improving" : "worth a look"}`;
}

function MetricCard({
	label,
	value,
	stat,
	detail,
	lowerIsBetter = false,
}: {
	label: string;
	value: string;
	stat: AgentCoreStat;
	detail: string;
	lowerIsBetter?: boolean;
}) {
	const change = percentChange(stat);
	const rising = (change ?? 0) >= 0;
	const Icon = rising ? TrendingUpIcon : TrendingDownIcon;

	return (
		<Card className="@container/card">
			<CardHeader>
				<CardDescription>{label}</CardDescription>
				<CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
					{value}
				</CardTitle>
				<CardAction>
					<TrendBadge stat={stat} />
				</CardAction>
			</CardHeader>
			<CardFooter className="flex-col items-start gap-1.5 text-sm">
				<div className="line-clamp-1 flex gap-2 font-medium">
					{trendLabel(stat, lowerIsBetter)}
					{change !== null && <Icon className="size-4" />}
				</div>
				<div className="text-muted-foreground">{detail}</div>
			</CardFooter>
		</Card>
	);
}

export function SectionCards({ summary }: { summary: AgentCoreSummary }) {
	const window = `Last ${summary.days} days`;

	return (
		<div className="grid grid-cols-1 gap-4 px-2 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
			<MetricCard
				label="Runtime invocations"
				value={formatCount(summary.invocations.current)}
				stat={summary.invocations}
				detail={`InvokeAgentRuntime calls · ${window}`}
			/>
			<MetricCard
				label="Agent sessions"
				value={formatCount(summary.sessions.current)}
				stat={summary.sessions}
				detail={`New sessions created · ${window}`}
			/>
			<MetricCard
				label="Avg invocation latency"
				value={formatLatency(summary.latencyMs.current)}
				stat={summary.latencyMs}
				lowerIsBetter
				detail={
					summary.errors.current > 0
						? `${formatCount(summary.errors.current)} error(s) in this window`
						: `No errors · ${window}`
				}
			/>
			<MetricCard
				label="Memory consumed"
				value={`${formatHours(summary.gbHours.current)} GB-hr`}
				stat={summary.gbHours}
				detail={`${formatHours(summary.vcpuHours.current)} vCPU-hours · may lag up to 1h`}
			/>
		</div>
	);
}
