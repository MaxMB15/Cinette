// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";
import { useChannels } from "@/hooks/useChannels";
import { useTauriEvent } from "@/hooks/useRemoteTarget";
import type { Link } from "@/lib/remote-control";
import { formatCode, secondsLeft } from "@/lib/remote-devices";
import {
	isLocalFile,
	nextSendState,
	providerResultText,
	type SendState,
} from "@/lib/remote-transfer";
import { remoteCancelTransfer, remoteSendProviders, type RemoteTransferNotice } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const BUTTON = cn(
	"px-3 py-1.5 text-sm rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
);

/**
 * "Send providers to [device]": the user picks providers, the other device
 * asks its own user, and only then do their logins go. The result says
 * which were added, which it had already, and which didn't load there.
 */
export const SendProvidersDialog = ({ link, onClose }: { link: Link; onClose: () => void }) => {
	const { providers } = useChannels();
	const titleId = useId();
	const [picked, setPicked] = useState<string[]>([]);
	const [state, setState] = useState<SendState>({ step: "choosing" });
	const [now, setNow] = useState(() => performance.now());
	useTauriEvent<RemoteTransferNotice>("remote://transfer", (notice) => {
		if (notice.link !== link.id) return;
		const at = performance.now();
		// The countdown starts from now, not from when it last ticked.
		setNow(at);
		setState((current) => nextSendState(current, notice, link.name, at));
	});
	const waiting = state.step === "waiting";
	useEffect(() => {
		// Stryker disable next-line ConditionalExpression: an interval while not waiting only sets the same time again, which shows nothing.
		if (!waiting) return;
		const timer = setInterval(() => setNow(performance.now()), 250);
		return () => clearInterval(timer);
	}, [waiting]);

	const running = state.step === "asking" || waiting || state.step === "saving";
	const close = () => {
		// Closing while it runs stops it; nothing is saved on the other device.
		if (running) void remoteCancelTransfer(link.id).catch(() => {});
		onClose();
	};
	const toggle = (id: string) =>
		setPicked((list) => (list.includes(id) ? list.filter((p) => p !== id) : [...list, id]));
	const send = () => {
		setState({ step: "asking" });
		remoteSendProviders(link.id, picked).catch((e: unknown) =>
			setState({ step: "failed", message: String(e) })
		);
	};
	const nameOf = (name: string) => <bdi className="font-medium">{name}</bdi>;

	return createPortal(
		<Dialog
			onClose={close}
			labelledBy={titleId}
			overlayClassName="z-10000"
			className="bg-card border border-border rounded-lg p-5 w-[380px] max-w-[calc(100vw-2rem)] shadow-xl"
		>
			<h2 id={titleId} className="text-base font-semibold mb-2 break-words">
				Send providers to {nameOf(link.name)}
			</h2>
			{state.step === "choosing" && (
				<>
					<p className="text-xs text-muted-foreground mb-3">
						Each one you pick, with its login, is saved on {nameOf(link.name)} as its
						own, once you allow it there. API keys aren't sent.
					</p>
					{providers.length === 0 ? (
						<p className="text-sm mb-4">This device has no providers to send.</p>
					) : (
						<ul className="mb-4 space-y-1 max-h-64 overflow-y-auto">
							{providers.map((p) => {
								const local = isLocalFile(p);
								return (
									<li key={p.id}>
										<label
											className={cn(
												"flex items-center gap-2 text-sm",
												local && "text-muted-foreground"
											)}
										>
											<input
												type="checkbox"
												disabled={local}
												checked={picked.includes(p.id)}
												onChange={() => toggle(p.id)}
											/>
											<bdi className="truncate">{p.name}</bdi>
											{local && (
												<span className="text-xs shrink-0">
													A file on this device
												</span>
											)}
										</label>
									</li>
								);
							})}
						</ul>
					)}
					<div className="flex justify-end gap-2">
						<button
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={close}
						>
							Cancel
						</button>
						<button
							type="button"
							disabled={picked.length === 0}
							className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50`}
							onClick={send}
						>
							Send
						</button>
					</div>
				</>
			)}
			{(state.step === "asking" || waiting || state.step === "saving") && (
				<>
					<p className="text-sm mb-3" role="status">
						{state.step === "saving" ? (
							<>Saving on {nameOf(link.name)}…</>
						) : (
							<>Waiting for {nameOf(link.name)} to allow it</>
						)}
					</p>
					{state.step !== "saving" && link.code && (
						<>
							<p className="text-xs text-muted-foreground mb-2">
								Check that this code matches the one on that device.
							</p>
							<p className="text-3xl font-mono font-semibold tracking-widest text-center mb-1">
								<span aria-hidden>{formatCode(link.code)}</span>
								<span className="sr-only">
									Code {link.code.split("").join(" ")}
								</span>
							</p>
						</>
					)}
					{waiting && (
						<p className="text-xs text-muted-foreground text-center mb-3">
							Expires in {secondsLeft(state.expiresAt, now)} s
						</p>
					)}
					<div className="flex justify-end">
						<button
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={close}
						>
							Cancel
						</button>
					</div>
				</>
			)}
			{state.step === "done" && (
				<>
					<ul className="mb-4 space-y-1 text-sm" aria-label="Results">
						{state.results.map((r, i) => (
							<li key={`${i}-${r.name}`} className="flex justify-between gap-3">
								<bdi className="truncate">{r.name}</bdi>
								<span
									className={cn(
										"shrink-0 text-right",
										r.outcome === "failed"
											? "text-destructive"
											: "text-muted-foreground"
									)}
								>
									{providerResultText(r, link.name)}
								</span>
							</li>
						))}
					</ul>
					<div className="flex justify-end">
						<button
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={onClose}
						>
							Done
						</button>
					</div>
				</>
			)}
			{state.step === "failed" && (
				<>
					<p className="text-sm mb-4" role="alert">
						{state.message}
					</p>
					<div className="flex justify-end">
						<button
							type="button"
							className={`${BUTTON} hover:bg-accent`}
							onClick={onClose}
						>
							Close
						</button>
					</div>
				</>
			)}
		</Dialog>,
		document.body
	);
};
