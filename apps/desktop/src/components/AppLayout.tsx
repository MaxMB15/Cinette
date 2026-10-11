// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Outlet, NavLink, useLocation } from "react-router-dom";
import { usePlatform } from "@/hooks/usePlatform";
import { cn } from "@/lib/utils";
import { useEffect } from "react";
import { mpvSetVisible } from "@/lib/tauri";
import { useFullscreen } from "@/lib/fullscreen-context";
import { Tv, List, FolderOpen, Settings as SettingsIcon } from "lucide-react";

const navItems = [
	{ to: "/", label: "Channels", icon: Tv },
	{ to: "/player", label: "Player", icon: List },
	{ to: "/playlists", label: "Playlists", icon: FolderOpen },
	{ to: "/settings", label: "Settings", icon: SettingsIcon },
];

export const AppLayout = () => {
	const { layoutMode } = usePlatform();

	if (layoutMode === "tv") {
		return <TvLayout />;
	}

	// iPads in portrait use the sidebar layout for now.
	return <MainLayout compact={layoutMode === "mobile"} />;
};

/**
 * The sidebar layout, or the phone layout with a tab bar when `compact` is
 * set. The page sits at the same place in the tree in both, so an iPad that
 * rotates or resizes across a breakpoint keeps it mounted. Separate layout
 * components remounted the player, which restarted the stream.
 */
const MainLayout = ({ compact }: { compact: boolean }) => {
	const { pathname } = useLocation();
	const isPlayer = pathname === "/player";
	const { isFullscreen } = useFullscreen();

	// Hide the native video view when not on the player route so it doesn't
	// bleed through transparent areas on other pages.
	useEffect(() => {
		mpvSetVisible(isPlayer).catch(() => {});
	}, [isPlayer]);

	// On a phone the player fills the screen and brings its own back button,
	// so the tab bar and the insets go away there.
	return (
		<div
			className={cn(
				"flex h-screen overflow-hidden",
				compact ? "flex-col" : "pt-safe pb-safe pr-safe",
				!compact && isPlayer && "safe-insets-black"
			)}
		>
			{!compact && <Sidebar hidden={isFullscreen} />}
			<main
				className={cn(
					"flex-1 overflow-hidden",
					compact && "min-h-0",
					compact && !isPlayer && "pt-safe pl-safe pr-safe"
				)}
			>
				<Outlet />
			</main>
			{compact && <TabBar hidden={isPlayer} />}
		</div>
	);
};

const Sidebar = ({ hidden }: { hidden: boolean }) => (
	<aside
		className={cn(
			"w-16 flex flex-col items-center py-3 gap-0.5 border-r border-border bg-card shrink-0 box-content pl-safe",
			hidden && "hidden"
		)}
	>
		{navItems.map(({ to, label, icon: Icon }) => (
			<NavLink
				key={to}
				to={to}
				className={({ isActive }) =>
					cn(
						"relative flex flex-col items-center justify-center w-full py-3 gap-1 text-muted-foreground transition-colors",
						isActive ? "text-primary" : "hover:text-foreground"
					)
				}
				title={label}
			>
				{({ isActive }) => (
					<>
						{isActive && (
							<span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-primary" />
						)}
						<Icon className="h-5 w-5" />
						<span className="text-[9px] font-medium leading-none">{label}</span>
					</>
				)}
			</NavLink>
		))}
	</aside>
);

const TabBar = ({ hidden }: { hidden: boolean }) => (
	<nav
		className={cn(
			"flex items-center justify-around border-t border-border bg-card/80 backdrop-blur-sm pb-safe pl-safe pr-safe shrink-0",
			hidden && "hidden"
		)}
	>
		{navItems.map(({ to, label, icon: Icon }) => (
			<NavLink
				key={to}
				to={to}
				className={({ isActive }) =>
					cn(
						"flex flex-col items-center justify-center min-h-[49px] min-w-[64px] py-1.5 px-3 text-muted-foreground transition-colors",
						isActive ? "text-primary" : ""
					)
				}
			>
				<Icon className="h-5 w-5" />
				<span className="text-[10px] mt-0.5">{label}</span>
			</NavLink>
		))}
	</nav>
);

const TvLayout = () => {
	return (
		<div className="flex h-screen overflow-hidden">
			<aside className="w-20 flex flex-col items-center py-6 gap-2 border-r border-border bg-card/50">
				{navItems.map(({ to, label, icon: Icon }) => (
					<NavLink
						key={to}
						to={to}
						className={({ isActive }) =>
							cn(
								"flex flex-col items-center justify-center w-16 h-16 rounded-xl text-muted-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
								isActive
									? "bg-primary/10 text-primary"
									: "hover:bg-accent hover:text-accent-foreground"
							)
						}
						tabIndex={0}
					>
						<Icon className="h-6 w-6" />
						<span className="text-xs mt-1">{label}</span>
					</NavLink>
				))}
			</aside>
			<main className="flex-1 overflow-hidden">
				<Outlet />
			</main>
		</div>
	);
};
