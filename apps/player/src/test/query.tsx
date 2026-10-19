// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "@/lib/query-client";

/**
 * A new query cache for one test, with the app's settings, which already
 * leave retries off. Pass `wrapperFor(client)` to render or renderHook.
 */
export const createTestQueryClient = (): QueryClient => createQueryClient();

/** Wraps what a test renders in `client`, or in a new client. */
export const wrapperFor = (client: QueryClient = createTestQueryClient()) => {
	const QueryWrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return QueryWrapper;
};
