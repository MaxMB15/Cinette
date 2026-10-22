// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";
import { useTauriEvent } from "@/hooks/useRemoteTarget";
import { saveProgressNow } from "@/lib/player-progress";
import type { Link } from "@/lib/remote-control";
import { formatCode, secondsLeft } from "@/lib/remote-devices";
import {
	countsText,
	historyPrivacy,
	nextHistoryState,
	reportLines,
	unmatchedLines,
	type HistoryState,
} from "@/lib/remote-transfer";
import {
	remoteAskHistory,
	remoteCancelTransfer,
	remoteHistoryCounts,
	remoteStartImport,
	type RemoteTransferNotice,
	type TransferCounts,
	type TransferWhat,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const BUTTON = cn(
	"px-3 py-1.5 text-sm rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
);
const PRIMARY = `${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50`;
const PLAIN = `${BUTTON} hover:bg-accent`;

const PARTS: { key: keyof TransferWhat; label: string }[] = [
	{ key: "history", label: "Watch history and saved places" },
	{ key: "favorites", label: "Favorites" },
	{ key: "pins", label: "Pinned groups" },
];

/** What the dialog says while the history moves or is written. */
const progressText = (state: HistoryState, sending: boolean): string => {
	switch (state.step) {
		case "saving":
			return "Saving…";
		case "moving":
			if (!sending) return "Receiving…";
			return state.total === null ? "Sending…" : `Sending… ${state.done} of ${state.total}`;
		default:
			// "starting" is an import's step.
			return "Receiving…";
	}
};

/**
 * "Transfer history and favorites": sends this device's history to the one
 * it controls, or imports that device's. The other device always asks its
 * own user first. An import shows what that device has before anything
 * comes. Nothing is deleted on either device.
 */
export const TransferHistoryDialog = ({ link, onClose }: { link: Link; onClose: () => void }) => {
	const titleId = useId();
	const [direction, setDirection] = useState<"send" | "import">("send");
	const [what, setWhat] = useState<TransferWhat>({ history: true, favorites: true, pins: true });
	const [counts, setCounts] = useState<TransferCounts | null>(null);
	const [state, setState] = useState<HistoryState>({ step: "choosing" });
	const [now, setNow] = useState(() => performance.now());
	useTauriEvent<RemoteTransferNotice>("remote://transfer", (notice) => {
		if (notice.link !== link.id) return;
		setState((current) => nextHistoryState(current, notice, link.name, performance.now()));
	});
	const sending = direction === "send";
	useEffect(() => {
		if (!sending) return;
		let current = true;
		remoteHistoryCounts(what)
			.then((c) => {
				if (current) setCounts(c);
			})
			.catch(() => {
				if (current) setCounts(null);
			});
		return () => {
			current = false;
		};
	}, [sending, what]);
	const waiting = state.step === "waiting";
	useEffect(() => {
		if (!waiting) return;
		const timer = setInterval(() => setNow(performance.now()), 250);
		return () => clearInterval(timer);
	}, [waiting]);

	// Set once the dialog is closed, so an ask still being set up then
	// doesn't go out after all. The effect sets it on mount.
	const closed = useRef<boolean | undefined>(undefined);
	useEffect(
		() => {
			closed.current = false;
			return () => {
				closed.current = true;
			};
		},
		// Stryker disable next-line ArrayDeclaration: any deps that never change run it only on mount and unmount.
		[]
	);

	const finished = state.step === "choosing" || state.step === "done" || state.step === "failed";
	const cancel = () => void remoteCancelTransfer(link.id).catch(() => {});
	// Once one side has it all and is writing it, a cancel can't stop it.
	const tooLate = state.step === "saving";
	const close = () => {
		closed.current = true;
		// Closing before that stops it, and nothing is written on either
		// device.
		if (!finished && !tooLate) cancel();
		onClose();
	};
	const nothing = !what.history && !what.favorites && !what.pins;
	const ask = () => {
		setState({ step: "asking" });
		// The other device gets where this one's player is now.
		const playing = sending ? saveProgressNow() : Promise.resolve(null);
		playing
			.then(async (open) => {
				if (closed.current) return;
				await remoteAskHistory(link.id, direction, what, open);
				// Closed while it was asked: the request is withdrawn.
				if (closed.current) cancel();
			})
			.catch((e: unknown) => setState({ step: "failed", message: String(e) }));
	};
	const start = (transfer: string) => {
		setState({ step: "starting" });
		remoteStartImport(link.id, transfer).catch((e: unknown) =>
			setState({ step: "failed", message: String(e) })
		);
	};
	const nameOf = <bdi className="font-medium">{link.name}</bdi>;

	return createPortal(
		<Dialog
			onClose={close}
			labelledBy={titleId}
			overlayClassName="z-10000"
			className="bg-card border border-border rounded-lg p-5 w-[400px] max-w-[calc(100vw-2rem)] shadow-xl"
		>
			<h2 id={titleId} className="text-base font-semibold mb-3 break-words">
				Transfer history and favorites
			</h2>
			{state.step === "choosing" && (
				<>
					<fieldset className="mb-3 space-y-1 text-sm">
						<legend className="sr-only">Direction</legend>
						<label className="flex items-center gap-2">
							<input
								type="radio"
								name="direction"
								checked={sending}
								onChange={() => setDirection("send")}
							/>
							<span>Send to {nameOf}</span>
						</label>
						<label className="flex items-center gap-2">
							<input
								type="radio"
								name="direction"
								checked={!sending}
								onChange={() => setDirection("import")}
							/>
							<span>Import from {nameOf}</span>
						</label>
					</fieldset>
					<fieldset className="mb-3 space-y-1 text-sm">
						<legend className="text-xs text-muted-foreground mb-1">What to copy</legend>
						{PARTS.map(({ key, label }) => (
							<label key={key} className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={what[key]}
									onChange={() => setWhat({ ...what, [key]: !what[key] })}
								/>
								<span>{label}</span>
							</label>
						))}
					</fieldset>
					<p className="text-sm mb-2" role="status">
						{nothing
							? "Pick something to copy."
							: sending
								? `This device has ${countsText(what, counts ?? undefined)}.`
								: `${link.name} shows what it has once you allow it there.`}
					</p>
					<p className="text-xs text-muted-foreground mb-4">
						{historyPrivacy(direction, link.name)}
					</p>
					<div className="flex justify-end gap-2">
						<button type="button" className={PLAIN} onClick={close}>
							Cancel
						</button>
						<button type="button" disabled={nothing} className={PRIMARY} onClick={ask}>
							{sending ? "Send" : "Ask"}
						</button>
					</div>
				</>
			)}
			{(state.step === "asking" || waiting) && (
				<>
					<p className="text-sm mb-3" role="status">
						Waiting for {nameOf} to allow it
					</p>
					{link.code && (
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
						<button type="button" className={PLAIN} onClick={close}>
							Cancel
						</button>
					</div>
				</>
			)}
			{state.step === "preview" && (
				<>
					<p className="text-sm mb-4" role="status">
						{link.name} has {countsText(what, state.counts)}. Import it to this device?
					</p>
					<div className="flex justify-end gap-2">
						<button type="button" className={PLAIN} onClick={close}>
							Cancel
						</button>
						<button
							type="button"
							className={PRIMARY}
							onClick={() => start(state.transfer)}
						>
							Import
						</button>
					</div>
				</>
			)}
			{(state.step === "starting" || state.step === "moving" || state.step === "saving") && (
				<>
					<p className="text-sm mb-3" role="status">
						{progressText(state, sending)}
					</p>
					{tooLate && (
						<p className="text-xs text-muted-foreground mb-3">
							It's too late to stop it now. Closing this doesn't undo it.
						</p>
					)}
					<div className="flex justify-end">
						<button type="button" className={PLAIN} onClick={close}>
							{tooLate ? "Close" : "Cancel"}
						</button>
					</div>
				</>
			)}
			{state.step === "done" && <Result report={state.report} onClose={onClose} />}
			{state.step === "failed" && (
				<>
					<p className="text-sm mb-4" role="alert">
						{state.message}
					</p>
					<div className="flex justify-end gap-2">
						<button type="button" className={PLAIN} onClick={onClose}>
							Close
						</button>
						<button
							type="button"
							className={PRIMARY}
							onClick={() => setState({ step: "choosing" })}
						>
							Try again
						</button>
					</div>
				</>
			)}
		</Dialog>,
		document.body
	);
};

const Result = ({
	report,
	onClose,
}: {
	report: Extract<HistoryState, { step: "done" }>["report"];
	onClose: () => void;
}) => {
	const { items, more } = unmatchedLines(report);
	return (
		<>
			<ul className="text-sm mb-3 space-y-0.5" aria-label="Copied">
				{reportLines(report).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			{items.length > 0 && (
				<>
					<p className="text-xs text-muted-foreground mb-1">
						These didn't match anything on the device they went to, so they weren't
						copied:
					</p>
					<ul
						className="text-xs mb-3 max-h-32 overflow-y-auto"
						aria-label="Couldn't match"
					>
						{items.map((item, i) => (
							<li key={`${i}-${item}`}>
								<bdi>{item}</bdi>
							</li>
						))}
						{more && <li className="text-muted-foreground">{more}</li>}
					</ul>
				</>
			)}
			<div className="flex justify-end">
				<button type="button" className={PLAIN} onClick={onClose}>
					Done
				</button>
			</div>
		</>
	);
};
