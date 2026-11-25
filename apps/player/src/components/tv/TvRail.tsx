// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, type ElementType, type KeyboardEvent, type Ref } from "react";
import {
	CalendarClock,
	Clapperboard,
	Heart,
	MonitorPlay,
	RotateCcwClock,
	Search,
	Settings as SettingsIcon,
	TvMinimal,
} from "lucide-react";
import { useChanged } from "@/hooks/useChanged";
import { cn } from "@/lib/utils";
import { TvList } from "./TvList";
import { useTvNav, type TvSection } from "./tv-nav";
// The bundled app icon itself, as on the start screen.
import appIcon from "../../../src-tauri/icons/128x128@2x.png";

export type TvRailItem = TvSection | "settings";

const ITEMS: readonly { id: TvRailItem; label: string; icon: ElementType }[] = [
	{ id: "search", label: "Search", icon: Search },
	{ id: "live", label: "Live TV", icon: TvMinimal },
	{ id: "guide", label: "Guide", icon: CalendarClock },
	{ id: "movie", label: "Movies", icon: Clapperboard },
	{ id: "series", label: "Series", icon: MonitorPlay },
	{ id: "favorites", label: "Favorites", icon: Heart },
	{ id: "history", label: "History", icon: RotateCcwClock },
	{ id: "settings", label: "Settings", icon: SettingsIcon },
];

const ROW_HEIGHT = 3;

/** Which rail item a page belongs to. */
export const currentRailItem = (pathname: string, section: TvSection): TvRailItem => {
	if (pathname === "/settings") return "settings";
	return section;
};

const indexOf = (id: TvRailItem): number => ITEMS.findIndex((item) => item.id === id);

/**
 * The sections, as icons down the left edge. It opens over the page while it
 * has the focus, so the labels only take room when they're being read. A
 * section opens on OK or Right, not on passing over it, so going past Movies
 * on the way to Settings doesn't load Movies.
 */
export const TvRail = ({ current, ref }: { current: TvRailItem; ref?: Ref<HTMLElement> }) => {
	const { openSection } = useTvNav();
	const [cursor, setCursor] = useState(() => indexOf(current));
	if (useChanged(current)) setCursor(indexOf(current));

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "ArrowRight" && !e.defaultPrevented) {
			e.preventDefault();
			openSection(ITEMS[cursor].id);
		}
	};

	return (
		<nav
			ref={ref}
			aria-label="Sections"
			className="group/rail peer/rail absolute inset-y-0 left-0 z-20 flex w-[4rem] flex-col justify-center border-r border-border bg-card focus-within:w-[11rem]"
			onKeyDown={onKeyDown}
			onBlur={(e) => {
				// Leaving the rail puts its cursor back on the open section.
				if (!e.currentTarget.contains(e.relatedTarget)) setCursor(indexOf(current));
			}}
		>
			{/* Lined up with the icons and labels below. It isn't a row, so the cursor passes it by. */}
			<div className="absolute top-[1.25rem] left-[1.375rem] flex items-center gap-[0.5rem] text-lg font-bold">
				<img src={appIcon} alt="" className="size-[2.25rem] rounded-[0.5rem]" />
				<span className="hidden group-focus-within/rail:inline">Cinette</span>
			</div>
			<TvList
				items={ITEMS}
				label="Sections"
				itemKey={(item) => item.id}
				active={cursor}
				onActiveChange={setCursor}
				onSelect={(item) => openSection(item.id)}
				rowHeight={ROW_HEIGHT}
				height={ITEMS.length * ROW_HEIGHT}
				renderItem={(item) => {
					const isCurrent = item.id === current;
					const Icon = item.icon;
					return (
						<div
							className={cn(
								"flex h-full items-center gap-[0.875rem] pl-[1.75rem] text-base font-medium whitespace-nowrap",
								isCurrent && "text-primary"
							)}
						>
							<Icon aria-hidden className="size-[1.5rem] shrink-0" />
							<span className="hidden group-focus-within/rail:inline">
								{item.label}
							</span>
						</div>
					);
				}}
			/>
		</nav>
	);
};
