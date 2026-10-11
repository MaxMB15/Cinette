// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fileUrlFromPath, isFileUrl, pathFromFileUrl } from "@/lib/file-url";
import { cn } from "@/lib/utils";
import type { Provider } from "@/lib/types";
import {
	type ProviderSettings,
	loadProviderSettings,
	saveProviderSettings,
} from "@/hooks/useChannels";
import { refreshEpg, setEpgUrl, detectEpgUrl } from "@/lib/tauri";

interface ProviderSettingsModalProps {
	provider: Provider;
	onClose: () => void;
	onRefreshNow: (id: string) => Promise<void>;
	onUpdateProvider: (
		id: string,
		name: string,
		url: string,
		username?: string,
		password?: string
	) => Promise<void>;
}

const INTERVAL_OPTIONS = [
	{ label: "Every hour", hours: 1 },
	{ label: "Every 6 hours", hours: 6 },
	{ label: "Every 12 hours", hours: 12 },
	{ label: "Every day", hours: 24 },
	{ label: "Every 2 days", hours: 48 },
	{ label: "Every week", hours: 168 },
];

const EPG_INTERVAL_OPTIONS = [
	{ label: "Every 6 hours", hours: 6 },
	{ label: "Every 12 hours", hours: 12 },
	{ label: "Every day", hours: 24 },
	{ label: "Every 2 days", hours: 48 },
	{ label: "Every 3 days", hours: 72 },
];

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
	<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
		{children}
	</p>
);

export const ProviderSettingsModal = ({
	provider,
	onClose,
	onRefreshNow,
	onUpdateProvider,
}: ProviderSettingsModalProps) => {
	const titleId = useId();
	// Only seeds the form state below, so storage is read once and not on every keystroke.
	const [initial] = useState(() => loadProviderSettings(provider.id));
	const isFile = isFileUrl(provider.url);
	const isXtream = provider.type === "xtream";

	// Details fields
	const [name, setName] = useState(provider.name);
	const [url, setUrl] = useState(pathFromFileUrl(provider.url));
	const [username, setUsername] = useState(provider.username ?? "");
	const [password, setPassword] = useState(provider.password ?? "");

	// Auto-refresh settings
	const [autoRefresh, setAutoRefresh] = useState<ProviderSettings["autoRefresh"]>(
		initial.autoRefresh
	);
	const [intervalHours, setIntervalHours] = useState(initial.refreshIntervalHours);

	// EPG settings
	const [epgUrl, setEpgUrlState] = useState(provider.epgUrl ?? "");
	const [epgAutoRefresh, setEpgAutoRefresh] = useState(initial.epgAutoRefresh);
	const [epgIntervalHours, setEpgIntervalHours] = useState(initial.epgRefreshIntervalHours);

	// EPG refresh-now state
	const [epgRefreshing, setEpgRefreshing] = useState(false);
	const [epgRefreshError, setEpgRefreshError] = useState<string | null>(null);

	// EPG auto-detect state
	const [detecting, setDetecting] = useState(false);
	const [detectMessage, setDetectMessage] = useState<string | null>(null);

	// Refresh-now state
	const [refreshing, setRefreshing] = useState(false);
	const [refreshError, setRefreshError] = useState<string | null>(null);

	// Save state
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const handleRefreshNow = async () => {
		setRefreshing(true);
		setRefreshError(null);
		try {
			await onRefreshNow(provider.id);
		} catch (e) {
			setRefreshError(String(e));
		} finally {
			setRefreshing(false);
		}
	};

	const handleDetectEpgUrl = async () => {
		setDetecting(true);
		setDetectMessage(null);
		try {
			const detected = await detectEpgUrl(provider.id);
			if (detected) {
				setEpgUrlState(detected);
			} else {
				setDetectMessage("No EPG URL detected");
			}
		} catch (e) {
			setDetectMessage(String(e));
		} finally {
			setDetecting(false);
		}
	};

	const handleEpgRefreshNow = async () => {
		setEpgRefreshing(true);
		setEpgRefreshError(null);
		try {
			await refreshEpg(provider.id);
		} catch (e) {
			setEpgRefreshError(String(e));
		} finally {
			setEpgRefreshing(false);
		}
	};

	const handleSave = async () => {
		setSaving(true);
		setSaveError(null);
		try {
			// Update credentials if anything changed
			const storedUrl = isFile ? fileUrlFromPath(url) : url;
			const credentialsChanged =
				name !== provider.name ||
				storedUrl !== provider.url ||
				username !== (provider.username ?? "") ||
				password !== (provider.password ?? "");
			if (credentialsChanged) {
				await onUpdateProvider(
					provider.id,
					name,
					storedUrl,
					isXtream ? username : undefined,
					isXtream ? password : undefined
				);
			}
			// Persist EPG URL if it changed
			const currentEpgUrl = provider.epgUrl ?? "";
			if (epgUrl !== currentEpgUrl) {
				await setEpgUrl(provider.id, epgUrl || null);
			}
			// Persist auto-refresh settings (including EPG)
			saveProviderSettings(provider.id, {
				autoRefresh,
				refreshIntervalHours: intervalHours,
				epgAutoRefresh,
				epgRefreshIntervalHours: epgIntervalHours,
			});
			onClose();
		} catch (e) {
			setSaveError(String(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			onClose={onClose}
			labelledBy={titleId}
			overlayClassName="backdrop-blur-sm"
			className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[90vh]"
		>
			{/* Header */}
			<div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<h2 id={titleId} className="text-sm font-semibold truncate">
						Playlist Settings
					</h2>
					<span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-medium uppercase shrink-0">
						{provider.type}
					</span>
				</div>
				<button
					onClick={onClose}
					className="ml-3 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
					aria-label="Close"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			{/* Body — scrollable */}
			<div className="px-5 py-4 space-y-5 overflow-y-auto">
				{/* Details section */}
				<div>
					<SectionLabel>Details</SectionLabel>
					<div className="space-y-2">
						<div>
							<label className="text-xs text-muted-foreground mb-1 block">Name</label>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Provider name"
								className="h-8 text-sm"
							/>
						</div>

						{isFile ? (
							<div>
								<label className="text-xs text-muted-foreground mb-1 block">
									File path
								</label>
								<p className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 truncate">
									{url}
								</p>
							</div>
						) : isXtream ? (
							<>
								<div>
									<label className="text-xs text-muted-foreground mb-1 block">
										Server URL
									</label>
									<Input
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										placeholder="http://example.com:8080"
										className="h-8 text-sm"
									/>
								</div>
								<div>
									<label className="text-xs text-muted-foreground mb-1 block">
										Username
									</label>
									<Input
										value={username}
										onChange={(e) => setUsername(e.target.value)}
										placeholder="Username"
										className="h-8 text-sm"
									/>
								</div>
								<div>
									<label className="text-xs text-muted-foreground mb-1 block">
										Password
									</label>
									<Input
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										placeholder="Password"
										type="password"
										className="h-8 text-sm"
									/>
								</div>
							</>
						) : (
							<div>
								<label className="text-xs text-muted-foreground mb-1 block">
									Playlist URL
								</label>
								<Input
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									placeholder="https://example.com/playlist.m3u"
									className="h-8 text-sm"
								/>
							</div>
						)}
					</div>
				</div>

				{/* Auto-refresh section */}
				{!isFile && (
					<div>
						<SectionLabel>Auto-refresh</SectionLabel>
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium">Auto-refresh</p>
									<p className="text-xs text-muted-foreground">
										Refresh on launch if overdue, then repeat on schedule
									</p>
								</div>
								<div className="flex gap-0.5 p-0.5 bg-secondary rounded-lg ml-3 shrink-0">
									<button
										onClick={() => setAutoRefresh(false)}
										className={cn(
											"px-3 py-1 rounded-md text-xs font-medium transition-colors",
											!autoRefresh
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										Off
									</button>
									<button
										onClick={() => setAutoRefresh(true)}
										className={cn(
											"px-3 py-1 rounded-md text-xs font-medium transition-colors",
											autoRefresh
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										On
									</button>
								</div>
							</div>

							{autoRefresh && (
								<div>
									<label className="text-xs text-muted-foreground mb-1 block">
										Refresh interval
									</label>
									<select
										value={intervalHours}
										onChange={(e) => setIntervalHours(Number(e.target.value))}
										className="w-full bg-secondary text-sm rounded-lg px-3 py-2 border border-transparent focus:outline-none focus:border-primary appearance-none cursor-pointer"
									>
										{INTERVAL_OPTIONS.map((opt) => (
											<option key={opt.hours} value={opt.hours}>
												{opt.label}
											</option>
										))}
									</select>
								</div>
							)}
						</div>
					</div>
				)}

				{/* Manual refresh section */}
				{!isFile && (
					<div>
						<SectionLabel>Manual refresh</SectionLabel>
						<div className="flex items-center justify-between">
							<p className="text-xs text-muted-foreground">
								{provider.lastUpdated
									? `Last updated ${new Date(provider.lastUpdated).toLocaleString()}`
									: "Never refreshed"}
							</p>
							<Button
								variant="secondary"
								size="sm"
								onClick={handleRefreshNow}
								disabled={refreshing || saving}
								className="shrink-0 ml-3"
							>
								<RefreshCw
									className={cn(
										"h-3.5 w-3.5 mr-1.5",
										refreshing && "animate-spin"
									)}
								/>
								{refreshing ? "Refreshing…" : "Refresh now"}
							</Button>
						</div>
						{refreshError && (
							<p className="text-xs text-destructive mt-1">{refreshError}</p>
						)}
					</div>
				)}

				{/* EPG Schedule section */}
				{!isFile && (
					<div>
						<SectionLabel>EPG Schedule</SectionLabel>
						<div className="space-y-3">
							{/* EPG URL */}
							<div>
								<label className="text-xs text-muted-foreground mb-1 block">
									EPG URL
								</label>
								<div className="flex gap-2">
									<Input
										value={epgUrl}
										onChange={(e) => setEpgUrlState(e.target.value)}
										placeholder="https://example.com/epg.xml"
										className="h-8 text-sm"
									/>
									<Button
										variant="secondary"
										size="sm"
										onClick={handleDetectEpgUrl}
										disabled={detecting || saving}
										className="shrink-0"
									>
										<RefreshCw
											className={cn(
												"h-3.5 w-3.5 mr-1.5",
												detecting && "animate-spin"
											)}
										/>
										{detecting ? "Detecting…" : "Auto-detect"}
									</Button>
								</div>
								{detectMessage && (
									<p className="text-xs text-muted-foreground mt-1">
										{detectMessage}
									</p>
								)}
							</div>

							{/* EPG Auto-refresh toggle */}
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium">Auto-refresh EPG</p>
									<p className="text-xs text-muted-foreground">
										Automatically refresh the EPG schedule on a schedule
									</p>
								</div>
								<div className="flex gap-0.5 p-0.5 bg-secondary rounded-lg ml-3 shrink-0">
									<button
										onClick={() => setEpgAutoRefresh(false)}
										className={cn(
											"px-3 py-1 rounded-md text-xs font-medium transition-colors",
											!epgAutoRefresh
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										Off
									</button>
									<button
										onClick={() => setEpgAutoRefresh(true)}
										className={cn(
											"px-3 py-1 rounded-md text-xs font-medium transition-colors",
											epgAutoRefresh
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										On
									</button>
								</div>
							</div>

							{/* EPG Refresh interval */}
							{epgAutoRefresh && (
								<div>
									<label className="text-xs text-muted-foreground mb-1 block">
										EPG refresh interval
									</label>
									<select
										value={epgIntervalHours}
										onChange={(e) =>
											setEpgIntervalHours(Number(e.target.value))
										}
										className="w-full bg-secondary text-sm rounded-lg px-3 py-2 border border-transparent focus:outline-none focus:border-primary appearance-none cursor-pointer"
									>
										{EPG_INTERVAL_OPTIONS.map((opt) => (
											<option key={opt.hours} value={opt.hours}>
												{opt.label}
											</option>
										))}
									</select>
								</div>
							)}

							{/* EPG Refresh now */}
							<div className="flex items-center justify-between">
								<p className="text-xs text-muted-foreground">
									Fetch latest EPG data for this provider
								</p>
								<Button
									variant="secondary"
									size="sm"
									onClick={handleEpgRefreshNow}
									disabled={epgRefreshing || saving}
									className="shrink-0 ml-3"
								>
									<RefreshCw
										className={cn(
											"h-3.5 w-3.5 mr-1.5",
											epgRefreshing && "animate-spin"
										)}
									/>
									{epgRefreshing ? "Refreshing…" : "Refresh EPG"}
								</Button>
							</div>
							{epgRefreshError && (
								<p className="text-xs text-destructive">{epgRefreshError}</p>
							)}
						</div>
					</div>
				)}

				{saveError && <p className="text-xs text-destructive">{saveError}</p>}
			</div>

			{/* Footer */}
			<div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
				<Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
					Cancel
				</Button>
				<Button size="sm" onClick={handleSave} disabled={saving}>
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>
		</Dialog>
	);
};
