// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { downloadPercent } from "@/lib/download-progress";
import type { DownloadRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A thin bar for a download that is queued or running. A running download
 * whose size the server didn't give, such as an HLS stream, has nothing to
 * measure against, so the whole bar pulses instead.
 */
export const DownloadProgressBar = ({ download }: { download: DownloadRecord }) => {
	const percent = downloadPercent(download);
	const sizeUnknown = percent === null && download.status === "downloading";
	return (
		<div
			role="progressbar"
			aria-label="Download progress"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={sizeUnknown ? undefined : (percent ?? 0)}
			aria-valuetext={download.status === "queued" ? "Queued" : undefined}
			className="h-1 rounded-full bg-white/20 overflow-hidden"
		>
			<div
				className={cn(
					"h-full bg-blue-400",
					sizeUnknown && "opacity-60 animate-pulse motion-reduce:animate-none"
				)}
				style={{ width: `${sizeUnknown ? 100 : (percent ?? 0)}%` }}
			/>
		</div>
	);
};
