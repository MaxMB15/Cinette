// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";

interface Task {
	busy: boolean;
	message: string | null;
	failed: boolean;
}

/**
 * Actions started from a screen's rows, by a key for each row, and how the last
 * run of each went. An action's answer, or what it threw, is its message.
 */
export const useTvTasks = () => {
	const [tasks, setTasks] = useState<Record<string, Task>>({});
	const settle = (key: string, task: Task) => setTasks((now) => ({ ...now, [key]: task }));

	const run = (key: string, action: () => Promise<string | void>) => {
		if (tasks[key]?.busy) return;
		settle(key, { busy: true, message: null, failed: false });
		action().then(
			(message) => settle(key, { busy: false, message: message ?? null, failed: false }),
			(e: unknown) => settle(key, { busy: false, message: String(e), failed: true })
		);
	};

	return {
		run,
		busy: (key: string): boolean => tasks[key]?.busy === true,
		message: (key: string): string | null => tasks[key]?.message ?? null,
		/** The last run threw, until the row runs again. */
		failed: (key: string): boolean => tasks[key]?.failed === true,
	};
};
