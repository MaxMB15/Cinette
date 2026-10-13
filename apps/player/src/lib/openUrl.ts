// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

export const openUrl = async (url: string): Promise<void> => {
	try {
		const opener = await import("@tauri-apps/plugin-opener");
		await opener.openUrl(url);
	} catch {
		window.open(url, "_blank");
	}
};
