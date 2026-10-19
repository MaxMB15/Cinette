// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type InvokeListener = (cmd: string) => void;

let listener: InvokeListener | null = null;

/**
 * Sets the function a dev build calls with the name of each command that
 * `invoke` sends, or clears it with null. src/dev/perf.tsx counts backend
 * calls with it. A production build never calls it.
 */
export const setInvokeListener = (next: InvokeListener | null): void => {
	listener = next;
};

/**
 * Sends a command to the backend through @tauri-apps/api, and tells the dev
 * listener first. Tauri defines `window.__TAURI_INTERNALS__.invoke` as
 * read-only, so calls are counted here instead of by wrapping it.
 */
export const invoke = <T>(...call: Parameters<typeof tauriInvoke>): Promise<T> => {
	if (import.meta.env.DEV) listener?.(call[0]);
	return tauriInvoke<T>(...call);
};
