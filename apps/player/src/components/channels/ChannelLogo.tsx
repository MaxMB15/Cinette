// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Logo URLs that failed to load. It lives at module level because the virtual
 * lists remount cards while scrolling, and each remount would retry a dead URL.
 */
const brokenImageUrls = new Set<string>();

/**
 * Whether the image at url has failed before, and a callback for its onError.
 * The answer follows url, so a card that is given a new logo tries it rather
 * than keeping the old one's failure.
 */
export const useImageFailed = (url?: string): [boolean, () => void] => {
	// Only re-renders after a failure. The set is the record of what failed
	// before this card mounted. The state covers a failure since, which the
	// React Compiler sees change, where it can't see the set change.
	const [failedUrl, setFailedUrl] = useState<string>();
	const failed = !!url && (failedUrl === url || brokenImageUrls.has(url));
	const markFailed = () => {
		if (!url) return;
		brokenImageUrls.add(url);
		setFailedUrl(url);
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
