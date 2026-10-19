// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { QueryClient } from "@tanstack/react-query";

/**
 * The cache for the app's backend queries.
 *
 * The data lives on this device and only changes when the app changes it, and
 * each change loads again what it touched. So nothing goes stale on a timer
 * or when the window gets focus, and a failed call isn't tried again, since a
 * local call that failed once would fail the same way. The backend is on this
 * device too, so calls go out whether or not the computer is online. In
 * TanStack's default network mode, they would wait for a connection.
 */
export const createQueryClient = (): QueryClient =>
	new QueryClient({
		defaultOptions: {
			queries: {
				networkMode: "always",
				staleTime: Infinity,
				retry: false,
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
			},
			mutations: { networkMode: "always", retry: false },
		},
	});
