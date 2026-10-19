// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Logo URLs that failed to load. It lives at module level because the virtual
 * lists remount cards while scrolling, and each remount would retry a dead URL.
 */
const brokenImageUrls = new Set<string>();
const brokenListeners = new Set<() => void>();

/** Calls the listener each time a logo fails, and returns a function that stops it. */
export const subscribeToBroken = (listener: () => void) => {
	brokenListeners.add(listener);
	return () => {
		brokenListeners.delete(listener);
	};
};

/**
 * Whether the image at url has failed before, and a callback for its onError.
 * The answer follows url, so a card that is given a new logo tries it rather
 * than keeping the old one's failure. Every card showing a logo that fails
 * switches to its fallback.
 */
export const useImageFailed = (url?: string): [boolean, () => void] => {
	const failed = useSyncExternalStore(subscribeToBroken, () => !!url && brokenImageUrls.has(url));
	const markFailed = () => {
		if (!url) return;
		brokenImageUrls.add(url);
		for (const listener of brokenListeners) listener();
	};
	return [failed, markFailed];
};

interface ChannelLogoProps {
	url?: string;
	/** Size, shape and background of the logo box. */
	className?: string;
	/** Shown when there is no URL or the image failed to load. */
	fallback: ReactNode;
	imgClassName?: string;
	alt?: string;
}

export const ChannelLogo = ({
	url,
	className,
	fallback,
	imgClassName = "object-contain",
	alt = "",
}: ChannelLogoProps) => {
	const [failed, markFailed] = useImageFailed(url);
	return (
		<div
			className={cn(
				"relative bg-secondary flex items-center justify-center overflow-hidden shrink-0",
				className
			)}
		>
			{url && !failed ? (
				<img
					src={url}
					alt={alt}
					className={cn("h-full w-full", imgClassName)}
					loading="lazy"
					onError={markFailed}
				/>
			) : (
				fallback
			)}
		</div>
	);
};
