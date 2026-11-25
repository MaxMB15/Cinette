// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useId, useState } from "react";
import { Check, Circle, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeviceIcon } from "@/components/remote/DevicePicker";
import { TOUCH } from "@/components/remote/RemoteControls";
import { useTauriEvent } from "@/hooks/useRemoteTarget";
import { downloadPercent } from "@/lib/download-progress";
import type { Link } from "@/lib/remote-control";
import {
	LOAD_STEPS,
	loadStep,
	loadedText,
	stepState,
	type LibraryProgress,
} from "@/lib/remote-loading";
import { cn } from "@/lib/utils";

const ICONS = { done: Check, active: LoaderCircle, waiting: Circle };

/**
 * What shows while the other device's library loads, which takes a few
 * seconds for a big one: that device, the steps with the one the load is at,
 * how much of the library came, and a way to disconnect.
 */
export const RemoteLoading = ({ link, onLeave }: { link: Link; onLeave: () => void }) => {
	const titleId = useId();
	const [progress, setProgress] = useState<LibraryProgress | null>(null);
	useTauriEvent<LibraryProgress & { link: number }>(
		"remote://library-progress",
		({ link: id, received, total }) => {
			if (id === link.id) setProgress({ received, total });
		}
	);
	const connected = link.phase.phase === "connected";
	const at = loadStep(connected, progress);
	const labels = {
		link: connected ? "Connected" : "Reconnecting",
		get: "Getting its library",
		open: "Opening it",
	};
	const percent =
		progress &&
		downloadPercent({ downloadedBytes: progress.received, totalBytes: progress.total });
	return (
		<div className="flex h-full items-center justify-center p-6">
			<section
				aria-labelledby={titleId}
				aria-busy
				className="flex w-full max-w-xs flex-col gap-5 rounded-lg border border-border bg-card p-5"
			>
				<div className="flex items-center gap-3">
					<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
						<DeviceIcon deviceType={link.deviceType} className="h-5 w-5" />
					</span>
					<h2 id={titleId} className="min-w-0 break-words text-base font-semibold">
						<bdi>{link.name}</bdi>
					</h2>
				</div>
				<ol className="flex flex-col gap-3">
					{LOAD_STEPS.map((step) => {
						const state = stepState(step, at);
						const Icon = ICONS[state];
						return (
							<li
								key={step}
								aria-current={state === "active" ? "step" : undefined}
								className={cn(
									"flex gap-3 text-sm",
									state === "waiting" && "text-muted-foreground"
								)}
							>
								<Icon
									aria-hidden
									className={cn(
										"mt-0.5 h-4 w-4 shrink-0",
										state !== "waiting" && "text-primary",
										state === "active" &&
											"animate-spin motion-reduce:animate-none"
									)}
								/>
								<div className="min-w-0 flex-1">
									<p>
										{labels[step]}
										{state === "done" && (
											<span className="sr-only">, done</span>
										)}
									</p>
									{step === "get" && state === "active" && (
										<>
											<div
												role="progressbar"
												aria-label={`Library from ${link.name}`}
												aria-valuemin={0}
												aria-valuemax={100}
												aria-valuenow={percent ?? undefined}
												className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
											>
												<div
													className={cn(
														"h-full rounded-full bg-primary transition-[width]",
														percent === null &&
															"animate-pulse opacity-60 motion-reduce:animate-none"
													)}
													style={{ width: `${percent ?? 100}%` }}
												/>
											</div>
											{progress?.total != null && (
												<p className="mt-1 text-xs tabular-nums text-muted-foreground">
													{loadedText(progress.received, progress.total)}
												</p>
											)}
										</>
									)}
								</div>
							</li>
						);
					})}
				</ol>
				<Button
					variant="outline"
					size="sm"
					className={cn("self-end", TOUCH)}
					onClick={onLeave}
				>
					Disconnect
				</Button>
			</section>
		</div>
	);
};
