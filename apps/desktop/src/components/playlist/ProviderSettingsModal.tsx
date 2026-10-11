// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, useState } from "react";
import { X } from "lucide-react";
import { BusyButton } from "@/components/ui/busy-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { fileUrlFromPath, isFileUrl, pathFromFileUrl } from "@/lib/file-url";
import type { Provider } from "@/lib/types";
import {
	type ProviderSettings,
	loadProviderSettings,
	saveProviderSettings,
} from "@/hooks/useChannels";
import { refreshEpg, setEpgUrl, detectEpgUrl } from "@/lib/tauri";
import { XtreamFields } from "./XtreamFields";

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

const OFF_ON: SegmentedOption<boolean>[] = [
	{ value: false, label: "Off" },
	{ value: true, label: "On" },
];

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
	<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
		{children}
	</p>
);

interface IntervalSelectProps {
	id: string;
	value: number;
	onChange: (hours: number) => void;
	options: { label: string; hours: number }[];
}

const IntervalSelect = ({ id, value, onChange, options }: IntervalSelectProps) => (
	<select
		id={id}
		value={value}
		onChange={(e) => onChange(Number(e.target.value))}
		className="w-full bg-secondary text-sm rounded-lg px-3 py-2 border border-transparent focus:outline-none focus:border-primary appearance-none cursor-pointer"
	>
		{options.map((opt) => (
			<option key={opt.hours} value={opt.hours}>
				{opt.label}
			</option>
		))}
	</select>
);

/**
 * Each button in the modal runs one action and shows how its last run went
 * right under it, independent of the other buttons.
 */
const useAction = () => {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setMessage(null);
		try {
			await action();
		} catch (e) {
			setMessage(String(e));
		} finally {
			setBusy(false);
		}
	};

	return { busy, message, setMessage, run };
};

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

	const refresh = useAction();
	const detect = useAction();
	const epgRefresh = useAction();
	const save = useAction();

	const handleRefreshNow = () => refresh.run(() => onRefreshNow(provider.id));

	const handleDetectEpgUrl = () =>
		detect.run(async () => {
			const detected = await detectEpgUrl(provider.id);
			if (detected) {
				setEpgUrlState(detected);
			} else {
				detect.setMessage("No EPG URL detected");
			}
		});

	const handleEpgRefreshNow = () => epgRefresh.run(() => refreshEpg(provider.id));

	const handleSave = () =>
		save.run(async () => {
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
		});

	return (
		<Dialog
			// Closing mid-save would drop a save error, so the modal stays until it's done.
			onClose={save.busy ? () => {} : onClose}
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

			{/* Scrollable body */}
			<div className="px-5 py-4 space-y-5 overflow-y-auto">
				{/* Details section */}
				<div>
					<SectionLabel>Details</SectionLabel>
					<div className="space-y-2">
						<Field label="Name">
							{(id) => (
								<Input
									id={id}
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Provider name"
									className="h-8 text-sm"
								/>
							)}
						</Field>

						{isFile ? (
							<div>
								{/* Not a label, since the path can't be edited here. */}
								<p className="text-xs text-muted-foreground mb-1">File path</p>
								<p className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 truncate">
									{url}
								</p>
							</div>
						) : isXtream ? (
							<XtreamFields
								variant="edit"
								url={url}
								username={username}
								password={password}
								onUrlChange={setUrl}
								onUsernameChange={setUsername}
								onPasswordChange={setPassword}
							/>
						) : (
							<Field label="Playlist URL">
								{(id) => (
									<Input
										id={id}
										value={url}
										onChange={(e) => setUrl(e.target.value)}
										placeholder="https://example.com/playlist.m3u"
										className="h-8 text-sm"
									/>
								)}
							</Field>
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
								<SegmentedControl
									aria-label="Auto-refresh"
									value={autoRefresh}
									onChange={setAutoRefresh}
									options={OFF_ON}
									className="ml-3 shrink-0"
								/>
							</div>

							{autoRefresh && (
								<Field label="Refresh interval">
									{(id) => (
										<IntervalSelect
											id={id}
											value={intervalHours}
											onChange={setIntervalHours}
											options={INTERVAL_OPTIONS}
										/>
									)}
								</Field>
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
							<BusyButton
								busy={refresh.busy}
								busyLabel="Refreshing…"
								onClick={handleRefreshNow}
								disabled={save.busy}
								className="shrink-0 ml-3"
							>
								Refresh now
							</BusyButton>
						</div>
						{refresh.message && (
							<p className="text-xs text-destructive mt-1">{refresh.message}</p>
						)}
					</div>
				)}

				{/* EPG Schedule section */}
				{!isFile && (
					<div>
						<SectionLabel>EPG Schedule</SectionLabel>
						<div className="space-y-3">
							{/* EPG URL */}
							<Field label="EPG URL">
								{(id) => (
									<>
										<div className="flex gap-2">
											<Input
												id={id}
												value={epgUrl}
												onChange={(e) => setEpgUrlState(e.target.value)}
												placeholder="https://example.com/epg.xml"
												className="h-8 text-sm"
											/>
											<BusyButton
												busy={detect.busy}
												busyLabel="Detecting…"
												onClick={handleDetectEpgUrl}
												disabled={save.busy}
												className="shrink-0"
											>
												Auto-detect
											</BusyButton>
										</div>
										{detect.message && (
											<p className="text-xs text-muted-foreground mt-1">
												{detect.message}
											</p>
										)}
									</>
								)}
							</Field>

							{/* EPG Auto-refresh toggle */}
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium">Auto-refresh EPG</p>
									<p className="text-xs text-muted-foreground">
										Automatically refresh the EPG schedule on a schedule
									</p>
								</div>
								<SegmentedControl
									aria-label="Auto-refresh EPG"
									value={epgAutoRefresh}
									onChange={setEpgAutoRefresh}
									options={OFF_ON}
									className="ml-3 shrink-0"
								/>
							</div>

							{/* EPG Refresh interval */}
							{epgAutoRefresh && (
								<Field label="EPG refresh interval">
									{(id) => (
										<IntervalSelect
											id={id}
											value={epgIntervalHours}
											onChange={setEpgIntervalHours}
											options={EPG_INTERVAL_OPTIONS}
										/>
									)}
								</Field>
							)}

							{/* EPG Refresh now */}
							<div className="flex items-center justify-between">
								<p className="text-xs text-muted-foreground">
									Fetch latest EPG data for this provider
								</p>
								<BusyButton
									busy={epgRefresh.busy}
									busyLabel="Refreshing…"
									onClick={handleEpgRefreshNow}
									disabled={save.busy}
									className="shrink-0 ml-3"
								>
									Refresh EPG
								</BusyButton>
							</div>
							{epgRefresh.message && (
								<p className="text-xs text-destructive">{epgRefresh.message}</p>
							)}
						</div>
					</div>
				)}

				{save.message && <p className="text-xs text-destructive">{save.message}</p>}
			</div>

			{/* Footer */}
			<div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
				<Button variant="ghost" size="sm" onClick={onClose} disabled={save.busy}>
					Cancel
				</Button>
				<Button size="sm" onClick={handleSave} disabled={save.busy}>
					{save.busy ? "Saving…" : "Save"}
				</Button>
			</div>
		</Dialog>
	);
};
