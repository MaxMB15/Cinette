// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { Trash2, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/downloads/ConfirmDialog";
import { AddProvider } from "./AddProvider";
import { ProviderSettingsModal } from "./ProviderSettingsModal";
import { useChannels } from "@/hooks/useChannels";
import type { Provider } from "@/lib/types";
import { cn } from "@/lib/utils";

const displayUrl = (url: string): string => {
	if (url.startsWith("file://")) {
		const path = url.slice(7);
		return path.split("/").pop() || path;
	}
	return url;
};

export const PlaylistManager = () => {
	const {
		providers,
		loadM3u,
		loadM3uFile,
		loadXtream,
		removeProvider,
		refreshProvider,
		updateProvider,
	} = useChannels();

	const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
	const [settingsProvider, setSettingsProvider] = useState<Provider | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<Provider | null>(null);
	const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});

	const handleAddM3u = async (name: string, url: string) => {
		await loadM3u(name, url);
	};

	const handleAddM3uFile = async (name: string, path: string) => {
		await loadM3uFile(name, path);
	};

	const handleAddXtream = async (
		name: string,
		url: string,
		username: string,
		password: string
	) => {
		await loadXtream(name, url, username, password);
	};

	const refreshNow = async (id: string) => {
		setRefreshingIds((s) => new Set(s).add(id));
		setRefreshErrors((errors) => {
			const next = { ...errors };
			delete next[id];
			return next;
		});
		try {
			await refreshProvider(id);
		} catch (e) {
			setRefreshErrors((errors) => ({ ...errors, [id]: String(e) }));
			// Rethrown so the settings modal can show the error next to its own button.
			throw e;
		} finally {
			setRefreshingIds((s) => {
				const next = new Set(s);
				next.delete(id);
				return next;
			});
		}
	};

	// The card already shows the error, so the click has nothing left to handle.
	const handleRefresh = (id: string) => refreshNow(id).catch(() => {});

	return (
		<div className="flex flex-col gap-6 p-4 max-w-2xl mx-auto h-full overflow-y-auto">
			<h1 className="text-2xl font-bold">Playlists</h1>

			<AddProvider
				onAddM3u={handleAddM3u}
				onAddM3uFile={handleAddM3uFile}
				onAddXtream={handleAddXtream}
			/>

			{providers.length > 0 && (
				<div className="flex flex-col gap-3">
					<h2 className="text-lg font-semibold">Your Providers</h2>
					{providers.map((p) => {
						const isRefreshing = refreshingIds.has(p.id);
						const isFile = p.url.startsWith("file://");
						return (
							<Card key={p.id}>
								<CardHeader className="py-4">
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2 min-w-0">
											<CardTitle className="text-base truncate">
												{p.name}
											</CardTitle>
											<Badge
												variant="secondary"
												className="text-[10px] shrink-0"
											>
												{p.type}
											</Badge>
										</div>
										<div className="flex items-center gap-1 shrink-0 ml-2">
											<Button
												variant="ghost"
												size="icon"
												className="h-8 w-8"
												title="Settings"
												onClick={() => setSettingsProvider(p)}
											>
												<Settings2 className="h-3.5 w-3.5" />
											</Button>
											{!isFile && (
												<Button
													variant="ghost"
													size="icon"
													className="h-8 w-8"
													title="Refresh"
													disabled={isRefreshing}
													onClick={() => handleRefresh(p.id)}
												>
													<RefreshCw
														className={cn(
															"h-3.5 w-3.5",
															isRefreshing && "animate-spin"
														)}
													/>
												</Button>
											)}
											<Button
												variant="ghost"
												size="icon"
												className="h-8 w-8 text-destructive hover:text-destructive"
												title="Remove"
												onClick={() => setPendingRemoval(p)}
											>
												<Trash2 className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
								</CardHeader>
								<CardContent className="pt-0 pb-4">
									<p className="text-xs text-muted-foreground truncate">
										{displayUrl(p.url)}
									</p>
									<p className="text-xs text-muted-foreground mt-1">
										{p.channelCount.toLocaleString()} channels
										{p.lastUpdated &&
											` \u00b7 Updated ${new Date(p.lastUpdated).toLocaleString()}`}
									</p>
									{refreshErrors[p.id] && (
										<p className="text-xs text-destructive mt-1">
											{refreshErrors[p.id]}
										</p>
									)}
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}

			{settingsProvider && (
				<ProviderSettingsModal
					provider={settingsProvider}
					onClose={() => setSettingsProvider(null)}
					onRefreshNow={refreshNow}
					onUpdateProvider={updateProvider}
				/>
			)}

			<ConfirmDialog
				open={pendingRemoval !== null}
				title="Remove provider?"
				message={`Remove "${pendingRemoval?.name ?? ""}"? Its channels and favorites are removed too.`}
				confirmLabel="Remove"
				onConfirm={() => {
					if (pendingRemoval) removeProvider(pendingRemoval.id);
					setPendingRemoval(null);
				}}
				onCancel={() => setPendingRemoval(null)}
			/>
		</div>
	);
};
