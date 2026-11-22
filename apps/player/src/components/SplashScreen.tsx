// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { SplashScreenState, SplashStep, StepStatus } from "@/hooks/useSplashScreen";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import { openUrl } from "@/lib/openUrl";
import { getPlatform, isMobilePlatform } from "@/lib/platform";
// The bundled app icon itself, so the start screen can never drift from it.
import appIcon from "../../src-tauri/icons/128x128@2x.png";
import bmcQr from "@/assets/bmc-qr.png";

const BMC_URL = "https://buymeacoffee.com/MaxMB15";

/** The least a TV shows this screen, so the QR code doesn't flash past on a quick start. */
export const TV_SPLASH_HOLD_MS = 4000;

interface SplashScreenProps {
	splash: SplashScreenState;
	updateState: UpdateState;
}

export const SplashScreen = ({ splash, updateState }: SplashScreenProps) => {
	const { steps, allDone, progress, update, hasProviders, dismiss } = splash;
	const tv = getPlatform() === "tv";
	// App Store rules don't allow a donation link, so the phone and tablet apps
	// leave out the support panel.
	const showSupport = tv || !isMobilePlatform();
	const trapRef = useRef<HTMLDivElement>(null);
	// A TV has nothing to do here and every press is a chore, so it moves on by
	// itself. The app store updates it, so there's no update to offer. The trap
	// keeps the remote's presses from reaching the page behind.
	useFocusTrap(trapRef);
	const [held, setHeld] = useState(false);
	useEffect(
		() => {
			if (!tv) return;
			const timer = setTimeout(() => setHeld(true), TV_SPLASH_HOLD_MS);
			return () => clearTimeout(timer);
		},
		// Stryker disable next-line ArrayDeclaration: the platform never changes, so the effect runs once with or without it.
		[tv]
	);
	const moveOn = tv && allDone && held;
	useEffect(() => {
		if (moveOn) dismiss();
	}, [moveOn, dismiss]);

	return (
		<div
			ref={tv ? trapRef : undefined}
			tabIndex={tv ? -1 : undefined}
			className="fixed inset-0 z-50 flex bg-background pt-safe pb-safe pl-safe pr-safe focus:outline-hidden"
		>
			<LeftPanel
				steps={steps}
				allDone={allDone}
				progress={progress}
				update={update}
				hasProviders={hasProviders}
				onDismiss={dismiss}
				updateState={updateState}
			/>
			{showSupport && <RightPanel pressable={!tv} />}
		</div>
	);
};

// ── Left panel ──────────────────────────────────────────────────────────────

interface LeftPanelProps {
	steps: SplashStep[];
	allDone: boolean;
	progress: number;
	update: UpdateState["update"];
	hasProviders: boolean;
	onDismiss: () => void;
	updateState: UpdateState;
}

const LeftPanel = ({
	steps,
	allDone,
	progress,
	update,
	hasProviders,
	onDismiss,
	updateState,
}: LeftPanelProps) => {
	const { installing, progress: installProgress, error, install: handleInstall } = updateState;

	return (
		<div className="flex-1 flex flex-col items-center justify-center gap-10 px-6 sm:px-16">
			{/* Logo + branding */}
			<div className="flex flex-col items-center gap-4 text-center">
				<img
					src={appIcon}
					alt=""
					width={64}
					height={64}
					className="w-16 h-16 rounded-2xl shadow-lg ring-1 ring-white/10"
				/>
				<div>
					<h1 className="text-2xl font-bold tracking-tight">Cinette</h1>
					<p className="text-sm text-muted-foreground mt-0.5">IPTV Player</p>
				</div>
			</div>

			{/* Content area */}
			<div className="w-full max-w-sm flex flex-col gap-6">
				{/* A TV moves on by itself, to a page that says what to do next. */}
				{!hasProviders ? (
					<div className="text-center space-y-2 tv:hidden">
						<p className="text-base font-semibold">Welcome to Cinette</p>
						<p className="text-sm text-muted-foreground leading-relaxed">
							Add a playlist in the Playlists tab to get started.
						</p>
					</div>
				) : (
					<>
						{/* Progress bar */}
						<div className="space-y-3">
							<div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
								<div
									className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
									style={{ width: `${Math.round(progress * 100)}%` }}
								/>
							</div>
						</div>

						{/* Step list */}
						<div className="space-y-3">
							{steps.map((step) => (
								<StepRow key={step.id} step={step} />
							))}
						</div>
					</>
				)}

				{/* No-providers: show update step */}
				{!hasProviders && steps.length > 0 && (
					<div className="space-y-3">
						{steps.map((step) => (
							<StepRow key={step.id} step={step} />
						))}
					</div>
				)}

				{/* Update card */}
				{allDone && update && (
					<div className="rounded-xl bg-primary/10 border border-primary/25 px-5 py-4 space-y-1.5">
						<p className="text-sm font-semibold text-primary">
							Update available — v{update.version}
						</p>
						<p className="text-xs text-muted-foreground leading-relaxed">
							{update.body ?? "A new version is ready to install."}
						</p>
						{installing && installProgress !== null && (
							<div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
								<div
									className="h-full bg-primary transition-all duration-200"
									style={{ width: `${installProgress}%` }}
								/>
							</div>
						)}
						{error && <p className="text-xs text-destructive">{error}</p>}
					</div>
				)}

				{/* Action row */}
				<div className="flex items-center justify-center gap-3 pt-2 tv:hidden">
					{allDone && update ? (
						<>
							<button
								type="button"
								onClick={handleInstall}
								disabled={installing}
								className="flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-2.5 rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-60"
							>
								{installing ? (
									<RefreshCw className="h-4 w-4 animate-spin" />
								) : (
									<Download className="h-4 w-4" />
								)}
								{installing
									? installProgress !== null
										? `Downloading… ${installProgress}%`
										: "Installing…"
									: "Install Update"}
							</button>
							<button
								type="button"
								onClick={onDismiss}
								className="text-sm text-muted-foreground underline hover:text-foreground transition-colors"
							>
								Skip for now →
							</button>
						</>
					) : (
						<button
							type="button"
							onClick={onDismiss}
							disabled={!allDone}
							className="text-sm font-semibold bg-primary text-primary-foreground px-6 py-2.5 rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							Get Started →
						</button>
					)}
				</div>
			</div>
		</div>
	);
};

// ── Step row ──────────────────────────────────────────────────────────────

const StepRow = ({ step }: { step: SplashStep }) => {
	return (
		<div className="flex items-center gap-3 text-sm">
			<StepIcon status={step.status} />
			<span
				className={
					step.status === "done"
						? "text-foreground"
						: step.status === "error"
							? "text-amber-500"
							: step.status === "active"
								? "text-primary font-medium"
								: "text-muted-foreground"
				}
			>
				{step.label}
			</span>
		</div>
	);
};

const StepIcon = ({ status }: { status: StepStatus }) => {
	if (status === "done") {
		return (
			<span className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shrink-0">
				<svg viewBox="0 0 12 12" fill="none" className="w-3 h-3">
					<path
						d="M2 6l3 3 5-5"
						stroke="white"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</span>
		);
	}
	if (status === "error") {
		return (
			<span className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center shrink-0">
				<svg viewBox="0 0 12 12" fill="none" className="w-3 h-3">
					<path
						d="M6 3v4M6 8.5v.5"
						stroke="white"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
			</span>
		);
	}
	if (status === "active") {
		return <RefreshCw className="w-5 h-5 text-primary animate-spin shrink-0" />;
	}
	return <span className="w-5 h-5 rounded-full border-2 border-border shrink-0" />;
};

// ── Right panel ───────────────────────────────────────────────────────────

/**
 * On a TV the panel looks the same but has nothing to press: a TV may have no
 * browser to open, and this screen moves on by itself, so the QR code is the way in.
 */
const RightPanel = ({ pressable }: { pressable: boolean }) => {
	return (
		<div className="w-80 flex flex-col items-center justify-center gap-5 px-8 bg-card border-l border-border">
			{/* Header */}
			<div className="flex flex-col items-center gap-2 text-center">
				<span className="text-4xl">☕</span>
				<h2 className="text-lg font-bold">Support Cinette</h2>
				<p className="text-xs text-muted-foreground">No account needed · takes 2 seconds</p>
			</div>

			{/* QR code */}
			<button
				type="button"
				disabled={!pressable}
				onClick={() => openUrl(BMC_URL)}
				className="w-40 rounded-xl overflow-hidden border border-border hover:border-primary transition-colors"
				aria-label="Scan to donate via Buy Me a Coffee"
			>
				<img src={bmcQr} alt="Buy Me a Coffee QR code" className="w-full h-auto" />
			</button>

			{/* Support button */}
			<button
				type="button"
				disabled={!pressable}
				onClick={() => openUrl(BMC_URL)}
				className="w-full bg-[#5F7FFF] hover:bg-[#4a6cf0] text-white font-semibold py-3 rounded-xl transition-colors text-sm"
			>
				Buy me a coffee
			</button>
		</div>
	);
};
