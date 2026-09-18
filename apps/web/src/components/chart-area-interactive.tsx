import type { TokenUsage } from "@repo/api/router";
import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";

export const description = "Daily Bedrock token consumption";

const chartConfig = {
	tokens: {
		label: "Tokens",
	},
	input: {
		label: "Input tokens",
		color: "var(--primary)",
	},
	output: {
		label: "Output tokens",
		color: "var(--primary)",
	},
} satisfies ChartConfig;

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

export function ChartAreaInteractive({ usage }: { usage: TokenUsage }) {
	const isMobile = useIsMobile();
	const [timeRange, setTimeRange] = React.useState("90d");

	React.useEffect(() => {
		if (isMobile) {
			setTimeRange("7d");
		}
	}, [isMobile]);

	// The loader fetches the full 90-day window, so narrowing the range is a
	// client-side slice rather than another CloudWatch round trip.
	const filteredData = React.useMemo(() => {
		const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 90;
		return usage.points.slice(-days);
	}, [usage.points, timeRange]);

	const totals = React.useMemo(
		() =>
			filteredData.reduce(
				(acc, point) => ({
					input: acc.input + point.input,
					output: acc.output + point.output,
				}),
				{ input: 0, output: 0 },
			),
		[filteredData],
	);

	return (
		<Card className="@container/card">
			<CardHeader>
				<CardTitle>Bedrock token usage</CardTitle>
				<CardDescription>
					<span className="hidden @[540px]/card:block">
						{`${compact.format(totals.input)} input · ${compact.format(totals.output)} output tokens`}
					</span>
					<span className="@[540px]/card:hidden">
						{`${compact.format(totals.input + totals.output)} tokens`}
					</span>
				</CardDescription>
				<CardAction>
					<ToggleGroup
						multiple={false}
						value={timeRange ? [timeRange] : []}
						onValueChange={(value) => {
							setTimeRange(value[0] ?? "90d");
						}}
						variant="outline"
						className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
					>
						<ToggleGroupItem value="90d">Last 3 months</ToggleGroupItem>
						<ToggleGroupItem value="30d">Last 30 days</ToggleGroupItem>
						<ToggleGroupItem value="7d">Last 7 days</ToggleGroupItem>
					</ToggleGroup>
					<Select
						value={timeRange}
						onValueChange={(value) => {
							if (value !== null) {
								setTimeRange(value);
							}
						}}
					>
						<SelectTrigger
							className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
							size="sm"
							aria-label="Select a value"
						>
							<SelectValue placeholder="Last 3 months" />
						</SelectTrigger>
						<SelectContent className="rounded-xl">
							<SelectItem value="90d" className="rounded-lg">
								Last 3 months
							</SelectItem>
							<SelectItem value="30d" className="rounded-lg">
								Last 30 days
							</SelectItem>
							<SelectItem value="7d" className="rounded-lg">
								Last 7 days
							</SelectItem>
						</SelectContent>
					</Select>
				</CardAction>
			</CardHeader>
			<CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
				<ChartContainer
					config={chartConfig}
					className="aspect-auto h-[250px] w-full"
				>
					<AreaChart data={filteredData}>
						<defs>
							<linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="5%"
									stopColor="var(--color-input)"
									stopOpacity={1.0}
								/>
								<stop
									offset="95%"
									stopColor="var(--color-input)"
									stopOpacity={0.1}
								/>
							</linearGradient>
							<linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="5%"
									stopColor="var(--color-output)"
									stopOpacity={0.8}
								/>
								<stop
									offset="95%"
									stopColor="var(--color-output)"
									stopOpacity={0.1}
								/>
							</linearGradient>
						</defs>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="date"
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							minTickGap={32}
							tickFormatter={(value) => {
								const date = new Date(value);
								return date.toLocaleDateString("en-US", {
									month: "short",
									day: "numeric",
									timeZone: "UTC",
								});
							}}
						/>
						<ChartTooltip
							cursor={false}
							content={
								<ChartTooltipContent
									labelFormatter={(value) => {
										return new Date(String(value)).toLocaleDateString("en-US", {
											month: "short",
											day: "numeric",
											timeZone: "UTC",
										});
									}}
									indicator="dot"
								/>
							}
						/>
						<Area
							dataKey="output"
							type="natural"
							fill="url(#fillOutput)"
							stroke="var(--color-output)"
							stackId="a"
						/>
						<Area
							dataKey="input"
							type="natural"
							fill="url(#fillInput)"
							stroke="var(--color-input)"
							stackId="a"
						/>
					</AreaChart>
				</ChartContainer>
			</CardContent>
		</Card>
	);
}
