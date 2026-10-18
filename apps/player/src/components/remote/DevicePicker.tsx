// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Airplay, Cast, Check, Laptop, Loader2, MonitorSmartphone, Tv } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useLatestRef } from "@/hooks/useLatestRef";
import {
	groupEntries,
	isDisabled,
	keepWarning,
	statusText,
	type PickerEntry,
} from "@/lib/device-picker";
import { isTv } from "@/lib/remote-devices";
import { cn } from "@/lib/utils";

interface DevicePickerProps {
	open: boolean;
	onClose: () => void;
	/** Every place video can play, "This device" included. */
	entries: PickerEntry[];
	/** The entry that receives the player's commands now. */
	activeId: string;
	/** A row was chosen, after the confirm step for a converted route. */
	onSelect: (id: string) => void;
	/** A row marked `opens` was clicked, such as AirPlay's. */
	onOpenEntry?: (id: string) => void;
	/** The picker opened, so the routes for the current item can be checked. */
	onOpen?: () => void;
	/** A line above the rows, such as why no device can be found. */
	notice?: string | null;
}

const BUTTON = cn(
	"px-3 py-1.5 text-xs rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
);

const EntryIcon = ({ entry }: { entry: PickerEntry }) => {
	const className = cn("h-5 w-5 shrink-0");
	switch (entry.kind) {
		case "local":
			return <Laptop className={className} aria-hidden />;
		case "cinette":
			return entry.deviceType && isTv(entry.deviceType) ? (
				<Tv className={className} aria-hidden />
			) : (
				<MonitorSmartphone className={className} aria-hidden />
			);
		case "cast":
			return <Cast className={className} aria-hidden />;
		case "airplay":
			return <Airplay className={className} aria-hidden />;
	}
};

/**
 * Where to play: this device, other Cinette devices, Cast receivers and
 * AirPlay, each group under its own heading so app instances and receivers
 * are never mixed up. A row that can't be chosen stays listed, greyed out,
 * with the reason. Choosing a route this device has to convert asks first.
 */
export const DevicePicker = ({
	open,
	onClose,
	entries,
	activeId,
	onSelect,
	onOpenEntry,
	onOpen,
	notice,
}: DevicePickerProps) => {
	const titleId = useId();
	const [confirming, setConfirming] = useState<PickerEntry | null>(null);
	const onOpenRef = useLatestRef(onOpen);
	useEffect(() => {
		if (open) onOpenRef.current?.();
	}, [open, onOpenRef]);
	if (!open) return null;

	const choose = (entry: PickerEntry) => {
		if (entry.opens) {
			onOpenEntry?.(entry.id);
			return;
		}
		if (keepWarning(entry) !== null) {
			setConfirming(entry);
			return;
		}
		onSelect(entry.id);
	};

	const warning = confirming && keepWarning(confirming);
	return createPortal(
		<Dialog
			onClose={() => (confirming ? setConfirming(null) : onClose())}
			labelledBy={titleId}
			// Above the full screen player, which sits at z-9999.
			overlayClassName="z-10000"
			className="bg-card border border-border rounded-lg p-4 w-[360px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto shadow-xl"
		>
			<h2 id={titleId} className="text-sm font-semibold mb-3">
				{confirming ? `Play on ${confirming.name}?` : "Play on"}
			</h2>
			{confirming ? (
				<div>
					<p className="text-xs text-muted-foreground mb-4">{warning}</p>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={() => setConfirming(null)}
						>
							Cancel
						</button>
						<button
							type="button"
							className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
							onClick={() => {
								setConfirming(null);
								onSelect(confirming.id);
							}}
						>
							Confirm
						</button>
					</div>
				</div>
			) : (
				<div className="space-y-3">
					{notice && (
						<p role="status" className="text-xs text-muted-foreground">
							{notice}
						</p>
					)}
					{groupEntries(entries).map((group) => (
						<section key={group.kind} aria-label={group.heading ?? "This device"}>
							{group.heading && (
								<h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
									{group.heading}
								</h3>
							)}
							<ul>
								{group.entries.map((entry) => {
									const active = entry.id === activeId;
									const disabled = isDisabled(entry);
									const line = statusText(entry);
									return (
										<li key={entry.id}>
											<button
												type="button"
												disabled={disabled}
												aria-current={active ? "true" : undefined}
												onClick={() => choose(entry)}
												className={cn(
													"w-full flex items-center gap-3 rounded-md px-2 py-2 text-left",
													"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
													active ? "text-primary" : "hover:bg-accent",
													disabled &&
														"opacity-50 cursor-default hover:bg-transparent"
												)}
											>
												<EntryIcon entry={entry} />
												<span className="flex-1 min-w-0">
													<span className="block text-sm truncate">
														{entry.name}
													</span>
													{line && (
														<span className="block text-xs text-muted-foreground truncate">
															{line}
														</span>
													)}
												</span>
												{entry.status === "checking" && (
													<Loader2
														className="h-4 w-4 animate-spin text-muted-foreground"
														aria-hidden
													/>
												)}
												{active && (
													<Check
														className="h-4 w-4"
														aria-label="Playing here"
													/>
												)}
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					))}
				</div>
			)}
		</Dialog>,
		document.body
	);
};
