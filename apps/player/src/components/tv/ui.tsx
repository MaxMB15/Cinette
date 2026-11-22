// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ComponentProps, ReactNode } from "react";
import { Heart } from "lucide-react";
import { ChannelLogo } from "@/components/channels/ChannelLogo";
import { useNow } from "@/hooks/useNow";
import { formatHHMM } from "@/lib/epg-window";
import type { Channel } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The screen's height in rem, from `html.tv` in globals.css. */
export const SCREEN_HEIGHT = 36;
/** The header's share of the screen's height, above the columns. */
export const HEADER_HEIGHT = 3.5;
/** The height left for a screen's columns, with a margin below them. */
export const COLUMN_HEIGHT = SCREEN_HEIGHT - HEADER_HEIGHT - 0.5;

/** The time, as a screen's corner shows it. */
export const TvClock = () => {
	const now = useNow();
	return (
		<span className="shrink-0 text-base font-medium whitespace-nowrap tabular-nums opacity-70">
			{formatHHMM(now)}
		</span>
	);
};

/** A screen's title and the time. */
export const TvHeader = ({ title }: { title: string }) => (
	<header
		className="flex items-center justify-between px-[1.5rem]"
		style={{ height: `${HEADER_HEIGHT}rem` }}
	>
		<h1 className="text-[1.5rem] leading-[2rem] font-semibold">{title}</h1>
		<TvClock />
	</header>
);

/** A button with the D-pad's white cursor. */
export const TvButton = ({ className, children, ...props }: ComponentProps<"button">) => (
	<button
		type="button"
		className={cn(
			"tv-cursor flex h-[2.75rem] items-center gap-[0.75rem] rounded-[0.5rem] bg-white/10 px-[1rem] text-base font-medium whitespace-nowrap",
			className
		)}
		{...props}
	>
		{children}
	</button>
);

/**
 * A text field beside the letters on the screen, for the system's keyboard and
 * its microphone, or a real keyboard. A WebView opens the system's keyboard as a
 * field takes the focus, which would cover the letters each time the D-pad
 * crossed this one. So that only happens when OK is pressed on it, and that
 * keyboard's own Enter key closes it again.
 */
export const TvField = (props: ComponentProps<"input">) => (
	<input
		{...props}
		inputMode="none"
		enterKeyHint="done"
		onKeyDown={(e) => {
			if (e.key !== "Enter") return;
			const field = e.currentTarget;
			if (field.inputMode === "text") {
				field.inputMode = "none";
				return;
			}
			// The WebView only looks at inputMode as the field takes the focus.
			field.blur();
			field.inputMode = "text";
			field.focus();
		}}
		onBlur={(e) => {
			e.currentTarget.inputMode = "none";
		}}
	/>
);

/** A small logo on a dark tile, which keeps white logos readable on the white cursor. */
export const TvLogo = ({
	url,
	name,
	className,
}: {
	url?: string;
	name: string;
	className?: string;
}) => (
	<ChannelLogo
		url={url}
		className={cn(
			"size-[2.5rem] rounded-[0.375rem] bg-[hsl(220_14%_14%)] text-white",
			className
		)}
		imgClassName="object-contain p-[0.125rem]"
		fallback={<span className="text-base font-semibold">{name.charAt(0).toUpperCase()}</span>}
	/>
);

/** One row of a text list, with the count or the like at its end. */
export const TvTextRow = ({ label, end }: { label: string; end?: ReactNode }) => (
	<div className="flex h-full items-center gap-[0.5rem] rounded-[0.5rem] px-[0.75rem] text-base font-medium">
		<span className="tv-name min-w-0 flex-1 truncate">{label}</span>
		{end !== undefined && (
			<span className="text-[0.8rem] leading-[1rem] tabular-nums opacity-70">{end}</span>
		)}
	</div>
);

/** What a screen says when it has nothing in it, and how to change that. */
export const TvEmpty = ({ title, children }: { title: string; children?: ReactNode }) => (
	<div className="flex h-full flex-col items-start justify-center gap-[1rem] px-[1.5rem]">
		<p className="max-w-[32rem] text-[1.5rem] leading-[2rem] font-semibold">{title}</p>
		{children}
	</div>
);

/** One row of a channel, movie or show, with a line under its name. */
export const TvChannelRow = ({
	channel,
	line,
	end,
}: {
	channel: Pick<Channel, "name" | "logoUrl" | "isFavorite">;
	line?: string;
	end?: ReactNode;
}) => (
	<div className="flex h-full items-center gap-[0.75rem] rounded-[0.5rem] px-[0.5rem]">
		<TvLogo url={channel.logoUrl} name={channel.name} />
		<div className="min-w-0 flex-1">
			<p className="tv-name truncate text-base font-medium">{channel.name}</p>
			{line && <p className="truncate text-[0.8rem] leading-[1.1rem] opacity-70">{line}</p>}
		</div>
		{end !== undefined && (
			<span className="shrink-0 text-[0.8rem] leading-[1rem] opacity-70">{end}</span>
		)}
		{channel.isFavorite && (
			<Heart aria-label="Favorite" className="size-[1rem] shrink-0 fill-current" />
		)}
	</div>
);
