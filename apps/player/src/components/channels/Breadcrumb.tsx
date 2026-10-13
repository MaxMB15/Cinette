// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { ChevronLeft } from "lucide-react";

interface BreadcrumbProps {
	path: { label: string; onClick?: () => void }[];
}

export const Breadcrumb = ({ path }: BreadcrumbProps) => (
	<div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border text-sm">
		{path.map((segment, i) => {
			const isLast = i === path.length - 1;
			return (
				<span key={i} className="flex items-center gap-1.5">
					{i === 0 && segment.onClick && (
						<ChevronLeft className="h-3.5 w-3.5 text-primary" />
					)}
					{isLast ? (
						<span className="text-foreground font-medium">{segment.label}</span>
					) : (
						<button onClick={segment.onClick} className="text-primary hover:underline">
							{segment.label}
						</button>
					)}
					{!isLast && <span className="text-muted-foreground">/</span>}
				</span>
			);
		})}
	</div>
);
