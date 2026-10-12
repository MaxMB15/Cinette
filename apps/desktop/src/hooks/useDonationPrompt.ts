// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useCallback, useEffect } from "react";
import { DONATION_LAST_SHOWN_KEY, readStorage, writeStorage } from "@/lib/storage";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface UseDonationPromptOptions {
	enabled: boolean;
}

interface DonationPromptState {
	shouldShow: boolean;
	dismiss: () => void;
}

const shouldShowNow = (): boolean => {
	const stored = readStorage(DONATION_LAST_SHOWN_KEY);
	if (!stored) return true;
	const lastShown = parseInt(stored, 10);
	return isNaN(lastShown) ? true : Date.now() - lastShown >= THIRTY_DAYS_MS;
};

export const useDonationPrompt = ({ enabled }: UseDonationPromptOptions): DonationPromptState => {
	const [shouldShow, setShouldShow] = useState(false);

	// Re-evaluate whenever enabled flips to true (i.e. splash just dismissed)
	useEffect(() => {
		if (enabled) setShouldShow(shouldShowNow());
	}, [enabled]);

	const dismiss = useCallback(() => {
		writeStorage(DONATION_LAST_SHOWN_KEY, String(Date.now()));
		setShouldShow(false);
	}, []);

	return { shouldShow, dismiss };
};
