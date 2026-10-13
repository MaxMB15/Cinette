// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { openUrl } from "@/lib/openUrl";

export const REPO_URL = "https://github.com/MaxMB15/MaxVideoPlayer";

// Each release is tagged, so the tag holds the exact source and license files
// of the running build. Without a version, the links fall back to main.
export const sourceUrl = (version?: string): string =>
	version ? `${REPO_URL}/tree/v${version}` : REPO_URL;

export const fileUrl = (file: string, version?: string): string =>
	`${REPO_URL}/blob/${version ? `v${version}` : "main"}/${file}`;

interface LegalNoticesProps {
	version?: string;
}

// The Appropriate Legal Notices that GPLv3 asks interactive programs to show.
// The "Created by" line is the attribution that NOTICE term 1 protects.
export const LegalNotices = ({ version }: LegalNoticesProps) => {
	const links = [
		{ label: "License", url: fileUrl("LICENSE", version) },
		{ label: "Additional terms", url: fileUrl("NOTICE", version) },
		{ label: "Source code", url: sourceUrl(version) },
		{ label: "Third-party notices", url: fileUrl("THIRD_PARTY_NOTICES.md", version) },
		// The policy can change after a release, so this always opens the current one.
		{ label: "Privacy policy", url: fileUrl("docs/privacy.md") },
	];

	return (
		<div className="space-y-2 text-xs text-muted-foreground">
			<p className="text-sm text-foreground">Created by Max Boksem</p>
			<p>Copyright © 2026 Max Boksem</p>
			<p>
				Max Video Player is free software. You can share and change it under the GNU General
				Public License version 3, with additional terms. It comes with no warranty.
			</p>
			<div className="flex flex-wrap gap-x-3 gap-y-1">
				{links.map(({ label, url }) => (
					<button
						key={label}
						type="button"
						onClick={() => openUrl(url)}
						className="text-primary hover:underline"
					>
						{label}
					</button>
				))}
			</div>
		</div>
	);
};
