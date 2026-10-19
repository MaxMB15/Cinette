// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Every TanStack Query the app makes, with its key and the backend call that
// answers it. Each key starts with where the data comes from, so another
// device can later answer the same queries when the remote control browses
// its catalog.

import { queryOptions } from "@tanstack/react-query";
import { getAllChannels, getProviders } from "./tauri";

/** Where a query's data comes from. Only this device for now. */
export type Source = "local";

export const LOCAL: Source = "local";

/** The user's providers, with their settings and channel counts. */
export const providersQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "providers"] as const,
		queryFn: () => getProviders(),
	});

/** Every channel, movie and series of every provider. */
export const channelsQuery = (source: Source = LOCAL) =>
	queryOptions({
		queryKey: [source, "channels"] as const,
		queryFn: () => getAllChannels(),
	});
