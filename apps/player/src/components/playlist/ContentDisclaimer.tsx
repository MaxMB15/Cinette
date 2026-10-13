// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Info } from "lucide-react";
import { openUrl } from "@/lib/openUrl";

export const DISCLAIMER_URL = "https://github.com/MaxMB15/MaxVideoPlayer#disclaimer";

export const ContentDisclaimer = () => (
	<div className="flex gap-2 text-xs text-muted-foreground">
		<Info className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
		<p>
			Max Video Player doesn't include any channels or content. Only add playlists and
			accounts you have the legal right to use. You're responsible for what you watch with it,
			and it comes as is, without warranty.{" "}
			<button
				type="button"
				onClick={() => openUrl(DISCLAIMER_URL)}
				className="text-primary hover:underline"
			>
				Read the full disclaimer
			</button>
		</p>
	</div>
);
