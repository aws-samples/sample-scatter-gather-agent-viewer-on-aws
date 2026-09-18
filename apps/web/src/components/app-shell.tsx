import type { Journey } from "@repo/api/router";
import {
	Link,
	type LinkOptions,
	linkOptions,
	useMatchRoute,
} from "@tanstack/react-router";
import {
	Briefcase,
	Check,
	ChevronRight,
	ChevronsUpDown,
	FileText,
	LayoutDashboard,
	LogOut,
	Monitor,
	Moon,
	Route,
	Settings,
	Sun,
	Users,
} from "lucide-react";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { useBreadcrumbs } from "@/lib/breadcrumbs";
import { cn } from "@/lib/utils";

// Base nav item - used by simple sidebars
type NavItem = {
	label: string;
	icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
	link: LinkOptions;
	// Optional children for submenus (Sidebar3+)
	children?: NavItem[];
};

// Nav group with optional collapsible state
type NavGroup = {
	title: string;
	items: NavItem[];
	// Optional: default collapsed state (Sidebar2+)
	defaultOpen?: boolean;
};

// User data for footer (Sidebar6+)
export type UserData = {
	name: string;
	email: string;
	avatar: string;
};

// Complete sidebar data structure
type SidebarData = {
	// Logo/branding
	logo: {
		src: string;
		alt: string;
		title: string;
		description: string;
	};
	// Main navigation groups
	navGroups: NavGroup[];
};

// Shared sidebar data - works with all sidebar variations
const sidebarData: SidebarData = {
	logo: {
		src: "/logo.svg",
		alt: "Scatter Gather Agent Viewer logo",
		title: "Scatter Gather Agent Viewer",
		description: "Migration assessments",
	},
	navGroups: [
		{
			title: "Overview",
			defaultOpen: true,
			items: [
				{
					label: "Dashboard",
					icon: LayoutDashboard,
					link: linkOptions({ to: "/" }),
				},
				{
					label: "Journeys",
					icon: Route,
					link: linkOptions({ to: "/journeys" }),
				},
			],
		},
		{
			title: "Team",
			defaultOpen: false,
			items: [
				{ label: "Agents", icon: Users, link: linkOptions({ to: "/agents" }) },
			],
		},
	],
};

// Journeys come from the API, so this group is built at render time
const buildJourneysGroup = (journeys: Journey[]): NavGroup => ({
	title: "Journeys",
	defaultOpen: true,
	items: [
		{
			label: "Active Journeys",
			icon: Briefcase,
			link: linkOptions({ to: "/journeys" }),
			children: journeys.map((journey) => ({
				label: journey.name,
				icon: FileText,
				link: linkOptions({
					to: "/journeys/$journeyId",
					params: { journeyId: journey.id },
				}),
			})),
		},
	],
});

const SidebarLogo = ({ logo }: { logo: SidebarData["logo"] }) => {
	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<SidebarMenuButton size="lg">
					<div className="flex aspect-square size-8 items-center justify-center rounded-sm bg-primary">
						<img
							src={logo.src}
							alt={logo.alt}
							className="size-6 text-primary-foreground invert dark:invert-0"
						/>
					</div>
					<div className="flex flex-col gap-0.5 leading-none">
						<span className="font-medium">{logo.title}</span>
						<span className="text-xs text-muted-foreground">
							{logo.description}
						</span>
					</div>
				</SidebarMenuButton>
			</SidebarMenuItem>
		</SidebarMenu>
	);
};

const NavMenuItem = ({ item }: { item: NavItem }) => {
	const Icon = item.icon;
	const hasChildren = item.children && item.children.length > 0;
	const matchRoute = useMatchRoute();
	const isItemActive = (navItem: NavItem) =>
		Boolean(matchRoute({ to: navItem.link.to, params: navItem.link.params }));

	if (!hasChildren) {
		return (
			<SidebarMenuItem>
				<SidebarMenuButton
					isActive={isItemActive(item)}
					render={<Link {...item.link} />}
				>
					<Icon className="size-4" />
					<span>{item.label}</span>
				</SidebarMenuButton>
			</SidebarMenuItem>
		);
	}

	return (
		<Collapsible
			defaultOpen
			className="group/collapsible"
			render={<SidebarMenuItem />}
		>
			<CollapsibleTrigger
				render={<SidebarMenuButton isActive={isItemActive(item)} />}
			>
				<Icon className="size-4" />
				<span>{item.label}</span>
				<ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<SidebarMenuSub>
					{item.children!.map((child) => (
						<SidebarMenuSubItem key={child.label}>
							<SidebarMenuSubButton
								isActive={isItemActive(child)}
								render={<Link {...child.link} />}
							>
								{child.label}
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					))}
				</SidebarMenuSub>
			</CollapsibleContent>
		</Collapsible>
	);
};

const themeOptions = [
	{ value: "light", label: "Light", icon: Sun },
	{ value: "dark", label: "Dark", icon: Moon },
	{ value: "system", label: "System", icon: Monitor },
] as const;

const NavUser = ({ user }: { user: UserData }) => {
	const { theme, setTheme } = useTheme();
	const handleLogout = async () => {
		await authClient.signOut();
		// Full reload so the router re-runs beforeLoad with the cleared session
		window.location.href = "/login";
	};

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<SidebarMenuButton
								size="lg"
								className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
							/>
						}
					>
						<Avatar className="size-8 rounded-lg">
							<AvatarImage src={user.avatar} alt={user.name} />
							<AvatarFallback className="rounded-lg">
								{user.name
									.split(" ")
									.map((n) => n[0])
									.join("")}
							</AvatarFallback>
						</Avatar>
						<div className="grid flex-1 text-left text-sm leading-tight">
							<span className="truncate font-medium">{user.name}</span>
							<span className="truncate text-xs text-muted-foreground">
								{user.email}
							</span>
						</div>
						<ChevronsUpDown className="ml-auto size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--anchor-width) min-w-56 rounded-lg"
						side="bottom"
						align="end"
						sideOffset={4}
					>
						<DropdownMenuGroup>
							<DropdownMenuLabel className="p-0 font-normal">
								<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
									<Avatar className="size-8 rounded-lg">
										<AvatarImage src={user.avatar} alt={user.name} />
										<AvatarFallback className="rounded-lg">
											{user.name
												.split(" ")
												.map((n) => n[0])
												.join("")}
										</AvatarFallback>
									</Avatar>
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">{user.name}</span>
										<span className="truncate text-xs text-muted-foreground">
											{user.email}
										</span>
									</div>
								</div>
							</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />

						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<span className="relative mr-2 flex size-4 items-center justify-center">
									<Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
									<Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
								</span>
								Theme
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{themeOptions.map((option) => (
									<DropdownMenuItem
										key={option.value}
										onClick={() => setTheme(option.value)}
									>
										<option.icon className="mr-2 size-4" />
										{option.label}
										{theme === option.value && (
											<Check className="ml-auto size-4" />
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem render={<Link to="/settings" />}>
							<Settings className="mr-2 size-4" />
							Settings
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => void handleLogout()}>
							<LogOut className="mr-2 size-4" />
							Log out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
};

const AppSidebar = ({
	user,
	journeys = [],
	...props
}: React.ComponentProps<typeof Sidebar> & {
	user?: UserData;
	journeys?: Journey[];
}) => {
	const navGroups = [...sidebarData.navGroups, buildJourneysGroup(journeys)];

	return (
		<Sidebar {...props}>
			<SidebarHeader>
				<SidebarLogo logo={sidebarData.logo} />
			</SidebarHeader>
			<SidebarContent className="overflow-hidden">
				<ScrollArea className="min-h-0 flex-1">
					{navGroups.map((group) => (
						<SidebarGroup key={group.title}>
							<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu>
									{group.items.map((item) => (
										<NavMenuItem key={item.label} item={item} />
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}
				</ScrollArea>
			</SidebarContent>
			<SidebarFooter>{user && <NavUser user={user} />}</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
};

/**
 * `Link`'s `to` is typed as a union of route patterns, but breadcrumb hrefs are
 * already-resolved pathnames handed to us by the router (or literal paths for
 * declared ancestors). This narrow alias keeps that one escape hatch contained.
 */
const PathLink = Link as unknown as React.ComponentType<{
	to: string;
	activeOptions?: { exact?: boolean };
	children?: React.ReactNode;
}>;

function AppBreadcrumbs() {
	const crumbs = useBreadcrumbs();

	if (crumbs.length === 0) return null;

	return (
		<Breadcrumb className="hidden md:block">
			<BreadcrumbList>
				{crumbs.map((crumb, index) => {
					const isLast = index === crumbs.length - 1;

					return (
						<React.Fragment key={`${crumb.label}-${index}`}>
							<BreadcrumbItem>
								{isLast || !crumb.href ? (
									<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
								) : (
									<BreadcrumbLink
										render={
											<PathLink
												to={crumb.href}
												activeOptions={{ exact: true }}
											/>
										}
									>
										{crumb.label}
									</BreadcrumbLink>
								)}
							</BreadcrumbItem>
							{!isLast && <BreadcrumbSeparator />}
						</React.Fragment>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}

interface ApplicationShellProps {
	className?: string;
	children?: React.ReactNode;
	user?: UserData;
	journeys?: Journey[];
}

export function ApplicationShell({
	className,
	children,
	user,
	journeys,
}: ApplicationShellProps) {
	return (
		<SidebarProvider className={cn(className)}>
			<AppSidebar user={user} journeys={journeys} />
			<SidebarInset>
				<header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger className="-ml-1" />
					<Separator
						orientation="vertical"
						className="mr-2 hidden data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center md:block"
					/>
					<Link to="/" className="flex items-center gap-2 md:hidden">
						<div className="flex aspect-square size-8 items-center justify-center rounded-sm bg-primary">
							<img
								src={sidebarData.logo.src}
								alt={sidebarData.logo.alt}
								className="size-6 text-primary-foreground invert dark:invert-0"
							/>
						</div>
						<span className="font-semibold">{sidebarData.logo.title}</span>
					</Link>
					<AppBreadcrumbs />
				</header>
				<div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
