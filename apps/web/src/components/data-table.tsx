import type { RuntimeMetricRow } from "@repo/api/router";
import {
	type ColumnFiltersState,
	type ColumnVisibilityState,
	columnFilteringFeature,
	columnVisibilityFeature,
	createColumnHelper,
	createFilteredRowModel,
	createPaginatedRowModel,
	createSortedRowModel,
	FlexRender,
	rowPaginationFeature,
	rowSelectionFeature,
	rowSortingFeature,
	type SortingState,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import {
	ArrowUpDown,
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronsLeftIcon,
	ChevronsRightIcon,
	CircleCheckIcon,
	Columns3Icon,
	LoaderIcon,
	TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerDescription,
	DrawerFooter,
	DrawerHeader,
	DrawerTitle,
	DrawerTrigger,
} from "@/components/ui/drawer";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";

// New in v9: declare the features this table uses — anything you don't
// register is tree-shaken out of the bundle.
const features = tableFeatures({
	columnFilteringFeature,
	columnVisibilityFeature,
	rowPaginationFeature,
	rowSelectionFeature,
	rowSortingFeature,
	filteredRowModel: createFilteredRowModel(),
	paginatedRowModel: createPaginatedRowModel(),
	sortedRowModel: createSortedRowModel(),
});

const columnHelper = createColumnHelper<typeof features, RuntimeMetricRow>();

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatLatency(ms: number) {
	if (ms === 0) return "—";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatHours(value: number) {
	if (value === 0) return "—";
	return value < 10 ? value.toFixed(2) : compact.format(value);
}

function formatDate(date: string | null) {
	if (!date) return "—";
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

/** Mirrors the status colouring used on the agents index page. */
function statusVariant(status: string) {
	if (status === "READY") return "text-green-500";
	if (status.endsWith("_FAILED") || status === "DELETING")
		return "text-destructive";
	return "text-orange-500";
}

function SortableHeader({
	column,
	label,
	align = "right",
}: {
	// The column object from the table instance; typed loosely because the
	// generic column type isn't exported in a usable form.
	column: {
		getIsSorted: () => false | "asc" | "desc";
		toggleSorting: (desc?: boolean) => void;
	};
	label: string;
	align?: "left" | "right";
}) {
	const sorted = column.getIsSorted();
	return (
		<Button
			variant="ghost"
			size="sm"
			className={`-mx-2 h-8 gap-1 font-medium ${align === "right" ? "ml-auto" : ""}`}
			onClick={() => column.toggleSorting(sorted === "asc")}
		>
			{label}
			<ArrowUpDown className="size-3.5" />
		</Button>
	);
}

const columns = columnHelper.columns([
	columnHelper.display({
		id: "select",
		header: ({ table }) => (
			<div className="flex items-center justify-center">
				<Checkbox
					checked={
						table.getIsAllPageRowsSelected()
							? true
							: table.getIsSomePageRowsSelected()
								? "indeterminate"
								: false
					}
					onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
					aria-label="Select all"
				/>
			</div>
		),
		cell: ({ row }) => (
			<div className="flex items-center justify-center">
				<Checkbox
					checked={row.getIsSelected()}
					onCheckedChange={(value) => row.toggleSelected(!!value)}
					aria-label={`Select ${row.original.agentRuntimeName}`}
				/>
			</div>
		),
		enableSorting: false,
		enableHiding: false,
	}),
	columnHelper.accessor("agentRuntimeName", {
		header: "Runtime",
		cell: ({ row }) => <RuntimeDetailViewer runtime={row.original} />,
		enableHiding: false,
	}),
	columnHelper.accessor("status", {
		header: "Status",
		cell: ({ row }) => (
			<Badge variant="outline" className="px-1.5 text-muted-foreground">
				{row.original.status === "READY" ? (
					<CircleCheckIcon className={statusVariant(row.original.status)} />
				) : (
					<LoaderIcon className={statusVariant(row.original.status)} />
				)}
				{row.original.status}
			</Badge>
		),
	}),
	columnHelper.accessor("invocations", {
		header: ({ column }) => (
			<SortableHeader column={column} label="Invocations" />
		),
		cell: ({ row }) => (
			<div className="text-right tabular-nums">
				{row.original.invocations === 0
					? "—"
					: integer.format(row.original.invocations)}
			</div>
		),
	}),
	columnHelper.accessor("sessions", {
		header: ({ column }) => <SortableHeader column={column} label="Sessions" />,
		cell: ({ row }) => (
			<div className="text-right tabular-nums">
				{row.original.sessions === 0
					? "—"
					: integer.format(row.original.sessions)}
			</div>
		),
	}),
	columnHelper.accessor("latencyMs", {
		header: ({ column }) => (
			<SortableHeader column={column} label="Avg latency" />
		),
		cell: ({ row }) => (
			<div className="text-right tabular-nums">
				{formatLatency(row.original.latencyMs)}
			</div>
		),
	}),
	columnHelper.accessor("errors", {
		header: ({ column }) => <SortableHeader column={column} label="Errors" />,
		cell: ({ row }) =>
			row.original.errors === 0 ? (
				<div className="text-right text-muted-foreground tabular-nums">—</div>
			) : (
				<div className="flex justify-end">
					<Badge variant="outline" className="px-1.5">
						<TriangleAlertIcon className="text-destructive" />
						{integer.format(row.original.errors)}
					</Badge>
				</div>
			),
	}),
	columnHelper.accessor("gbHours", {
		header: ({ column }) => <SortableHeader column={column} label="GB-hours" />,
		cell: ({ row }) => (
			<div className="text-right tabular-nums">
				{formatHours(row.original.gbHours)}
			</div>
		),
	}),
	columnHelper.accessor("lastActivity", {
		header: ({ column }) => (
			<SortableHeader column={column} label="Last active" />
		),
		cell: ({ row }) => (
			<div className="text-right whitespace-nowrap text-muted-foreground">
				{formatDate(row.original.lastActivity)}
			</div>
		),
	}),
]);

export function DataTable({
	data,
	days,
}: {
	data: RuntimeMetricRow[];
	days: number;
}) {
	const [rowSelection, setRowSelection] = React.useState({});
	const [columnVisibility, setColumnVisibility] =
		React.useState<ColumnVisibilityState>({});
	const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
		[],
	);
	const [sorting, setSorting] = React.useState<SortingState>([]);
	const [pagination, setPagination] = React.useState({
		pageIndex: 0,
		pageSize: 10,
	});

	const table = useTable({
		features,
		data,
		columns,
		state: {
			sorting,
			columnVisibility,
			rowSelection,
			columnFilters,
			pagination,
		},
		getRowId: (row) => row.agentRuntimeId,
		enableRowSelection: true,
		onRowSelectionChange: setRowSelection,
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		onColumnVisibilityChange: setColumnVisibility,
		onPaginationChange: setPagination,
	});

	const nameFilter = table.getColumn("agentRuntimeName");

	return (
		<div className="flex w-full flex-col justify-start gap-4">
			<div className="flex items-center justify-between gap-2 px-2 lg:px-3">
				<div>
					<h2 className="font-medium">Agent runtimes</h2>
					<p className="text-muted-foreground text-sm">
						AgentCore usage per runtime over the last {days} days
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Label htmlFor="runtime-filter" className="sr-only">
						Filter runtimes
					</Label>
					<Input
						id="runtime-filter"
						placeholder="Filter runtimes..."
						className="h-8 w-40 lg:w-56"
						value={(nameFilter?.getFilterValue() as string) ?? ""}
						onChange={(event) => nameFilter?.setFilterValue(event.target.value)}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={<Button variant="outline" size="sm" />}
						>
							<Columns3Icon data-icon="inline-start" />
							<span className="hidden lg:inline">Columns</span>
							<ChevronDownIcon data-icon="inline-end" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							{table
								.getAllColumns()
								.filter(
									(column) =>
										typeof column.accessorFn !== "undefined" &&
										column.getCanHide(),
								)
								.map((column) => (
									<DropdownMenuCheckboxItem
										key={column.id}
										className="capitalize"
										checked={column.getIsVisible()}
										onCheckedChange={(value) =>
											column.toggleVisibility(!!value)
										}
									>
										{column.id}
									</DropdownMenuCheckboxItem>
								))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<div className="relative flex flex-col gap-4 overflow-auto px-2 lg:px-3">
				<div className="overflow-hidden rounded-lg border">
					<Table>
						<TableHeader className="sticky top-0 z-10 bg-muted">
							{table.getHeaderGroups().map((headerGroup) => (
								<TableRow key={headerGroup.id}>
									{headerGroup.headers.map((header) => (
										<TableHead key={header.id} colSpan={header.colSpan}>
											{header.isPlaceholder ? null : (
												<FlexRender header={header} />
											)}
										</TableHead>
									))}
								</TableRow>
							))}
						</TableHeader>
						<TableBody className="**:data-[slot=table-cell]:first:w-8">
							{table.getRowModel().rows?.length ? (
								table.getRowModel().rows.map((row) => (
									<TableRow
										key={row.id}
										data-state={row.getIsSelected() && "selected"}
									>
										{row.getVisibleCells().map((cell) => (
											<TableCell key={cell.id}>
												<FlexRender cell={cell} />
											</TableCell>
										))}
									</TableRow>
								))
							) : (
								<TableRow>
									<TableCell
										colSpan={columns.length}
										className="h-24 text-center"
									>
										No agent runtimes found.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
				<div className="flex items-center justify-between px-2">
					<div className="hidden flex-1 text-sm text-muted-foreground lg:flex">
						{table.getFilteredSelectedRowModel().rows.length} of{" "}
						{table.getFilteredRowModel().rows.length} row(s) selected.
					</div>
					<div className="flex w-full items-center gap-8 lg:w-fit">
						<div className="hidden items-center gap-2 lg:flex">
							<Label htmlFor="rows-per-page" className="text-sm font-medium">
								Rows per page
							</Label>
							<Select
								value={`${table.state.pagination.pageSize}`}
								onValueChange={(value) => {
									table.setPageSize(Number(value));
								}}
								items={[10, 20, 30, 40, 50].map((pageSize) => ({
									label: `${pageSize}`,
									value: `${pageSize}`,
								}))}
							>
								<SelectTrigger size="sm" className="w-20" id="rows-per-page">
									<SelectValue placeholder={table.state.pagination.pageSize} />
								</SelectTrigger>
								<SelectContent side="top">
									<SelectGroup>
										{[10, 20, 30, 40, 50].map((pageSize) => (
											<SelectItem key={pageSize} value={`${pageSize}`}>
												{pageSize}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>
						<div className="flex w-fit items-center justify-center text-sm font-medium">
							Page {table.state.pagination.pageIndex + 1} of{" "}
							{table.getPageCount()}
						</div>
						<div className="ml-auto flex items-center gap-2 lg:ml-0">
							<Button
								variant="outline"
								className="hidden h-8 w-8 p-0 lg:flex"
								onClick={() => table.setPageIndex(0)}
								disabled={!table.getCanPreviousPage()}
							>
								<span className="sr-only">Go to first page</span>
								<ChevronsLeftIcon />
							</Button>
							<Button
								variant="outline"
								className="size-8"
								size="icon"
								onClick={() => table.previousPage()}
								disabled={!table.getCanPreviousPage()}
							>
								<span className="sr-only">Go to previous page</span>
								<ChevronLeftIcon />
							</Button>
							<Button
								variant="outline"
								className="size-8"
								size="icon"
								onClick={() => table.nextPage()}
								disabled={!table.getCanNextPage()}
							>
								<span className="sr-only">Go to next page</span>
								<ChevronRightIcon />
							</Button>
							<Button
								variant="outline"
								className="hidden size-8 lg:flex"
								size="icon"
								onClick={() => table.setPageIndex(table.getPageCount() - 1)}
								disabled={!table.getCanNextPage()}
							>
								<span className="sr-only">Go to last page</span>
								<ChevronsRightIcon />
							</Button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

const chartConfig = {
	invocations: {
		label: "Invocations",
		color: "var(--primary)",
	},
} satisfies ChartConfig;

function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-1 sm:flex-row sm:items-baseline">
			<dt className="w-40 shrink-0 text-muted-foreground text-sm font-medium">
				{label}
			</dt>
			<dd className="min-w-0 text-sm break-all">{value}</dd>
		</div>
	);
}

function RuntimeDetailViewer({ runtime }: { runtime: RuntimeMetricRow }) {
	const isMobile = useIsMobile();
	const hasActivity = runtime.trend.some((point) => point.invocations > 0);

	return (
		<Drawer swipeDirection={isMobile ? "down" : "right"}>
			<DrawerTrigger
				render={
					<Button
						variant="link"
						className="h-auto w-fit flex-col items-start gap-0 px-0 py-0 text-left text-foreground"
					/>
				}
			>
				<span className="font-medium">{runtime.agentRuntimeName}</span>
				<span className="text-muted-foreground text-xs">
					{runtime.agentRuntimeId}
				</span>
			</DrawerTrigger>
			<DrawerContent>
				<DrawerHeader className="gap-1">
					<DrawerTitle className="break-all">
						{runtime.agentRuntimeName}
					</DrawerTitle>
					<DrawerDescription>
						{hasActivity
							? `${integer.format(runtime.invocations)} invocations across ${runtime.trend.length} days`
							: "No invocations recorded in this window"}
					</DrawerDescription>
				</DrawerHeader>
				<div className="flex flex-col gap-4 overflow-y-auto px-4 text-sm">
					{!isMobile && hasActivity && (
						<>
							<ChartContainer config={chartConfig}>
								<AreaChart
									accessibilityLayer
									data={runtime.trend}
									margin={{ left: 0, right: 10 }}
								>
									<CartesianGrid vertical={false} />
									<XAxis
										dataKey="date"
										tickLine={false}
										axisLine={false}
										tickMargin={8}
										minTickGap={24}
										tickFormatter={(value) =>
											new Date(value).toLocaleDateString("en-US", {
												month: "short",
												day: "numeric",
												timeZone: "UTC",
											})
										}
									/>
									<ChartTooltip
										cursor={false}
										content={
											<ChartTooltipContent
												indicator="dot"
												labelFormatter={(value) =>
													new Date(String(value)).toLocaleDateString("en-US", {
														month: "short",
														day: "numeric",
														timeZone: "UTC",
													})
												}
											/>
										}
									/>
									<Area
										dataKey="invocations"
										type="natural"
										fill="var(--color-invocations)"
										fillOpacity={0.4}
										stroke="var(--color-invocations)"
									/>
								</AreaChart>
							</ChartContainer>
							<Separator />
						</>
					)}
					<dl className="grid gap-3">
						<DetailRow label="Status" value={runtime.status} />
						<DetailRow label="Version" value={runtime.version ?? "—"} />
						<DetailRow
							label="Sessions"
							value={
								runtime.sessions === 0 ? "—" : integer.format(runtime.sessions)
							}
						/>
						<DetailRow
							label="Avg latency"
							value={formatLatency(runtime.latencyMs)}
						/>
						<DetailRow
							label="Errors"
							value={
								runtime.errors === 0 ? "None" : integer.format(runtime.errors)
							}
						/>
						<DetailRow
							label="Memory"
							value={`${formatHours(runtime.gbHours)} GB-hours`}
						/>
						<DetailRow
							label="vCPU"
							value={`${formatHours(runtime.vcpuHours)} vCPU-hours`}
						/>
						<DetailRow
							label="Last active"
							value={formatDate(runtime.lastActivity)}
						/>
						<DetailRow
							label="Last updated"
							value={
								runtime.lastUpdatedAt
									? new Date(runtime.lastUpdatedAt).toLocaleString()
									: "—"
							}
						/>
						<DetailRow label="Runtime ARN" value={runtime.agentRuntimeArn} />
						{runtime.description && (
							<DetailRow label="Description" value={runtime.description} />
						)}
					</dl>
				</div>
				<DrawerFooter>
					<DrawerClose render={<Button variant="outline" />}>Close</DrawerClose>
				</DrawerFooter>
			</DrawerContent>
		</Drawer>
	);
}
