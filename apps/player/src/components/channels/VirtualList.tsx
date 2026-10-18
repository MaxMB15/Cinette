// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

interface VirtualListProps {
	/** How many rows the list has. */
	count: number;
	/** Each row's height in pixels. */
	rowHeight: number;
	/** Draws one row. Only the rows on screen, and a few either side, are drawn. */
	renderRow: (index: number) => ReactNode;
	/** Drawn behind the rows, across the list's whole height. */
	background?: ReactNode;
	/** Shown in place of the rows when set, such as when nothing matches. */
	placeholder?: ReactNode;
	className?: string;
}

/**
 * A scrolling list that only draws the rows in view.
 *
 * Scrolling re-renders this component and nothing above it, so the page
 * around the list stays as it is.
 */
export const VirtualList = ({
	count,
	rowHeight,
	renderRow,
	background,
	placeholder,
	className,
}: VirtualListProps) => {
	// The compiler can't memoize what TanStack Virtual returns, and would skip
	// this component anyway. Saying so keeps that from failing the build.
	"use no memo";
	const scrollRef = useRef<HTMLDivElement>(null);
	// eslint-disable-next-line react-hooks/incompatible-library -- see above
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => rowHeight,
		overscan: 4,
	});

	// The virtualizer keeps row sizes until told otherwise, and the height
	// changes with the window width and layout.
	useEffect(() => {
		virtualizer.measure();
	}, [rowHeight, virtualizer]);

	return (
		<div ref={scrollRef} className={cn("overflow-auto", className)}>
			{placeholder ?? (
				<div
					style={{
						height: `${virtualizer.getTotalSize()}px`,
						width: "100%",
						position: "relative",
					}}
				>
					{background}
					{virtualizer.getVirtualItems().map((virtualRow) => (
						<div
							key={virtualRow.key}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								height: `${virtualRow.size}px`,
								transform: `translateY(${virtualRow.start}px)`,
							}}
						>
							{renderRow(virtualRow.index)}
						</div>
					))}
				</div>
			)}
		</div>
	);
};
