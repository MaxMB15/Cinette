// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef } from "react";
import type { SubtitleCue } from "@/lib/types";

interface SubtitleOverlayProps {
	cues: SubtitleCue[];
	position: number; // current MPV playback position in seconds
	delay?: number; // seconds; positive = show future cues, negative = show past cues
	fontSize?: number; // px, default 18
	fontFamily?: string; // CSS font-family string, default system-ui
	posX?: number; // 0 to 100 %, default 50
	posY?: number; // 0 to 100 %, default 88
	editMode?: boolean; // enables drag + shows dashed border
	onPositionChange?: (x: number, y: number) => void;
}

export const SubtitleOverlay = ({
	cues,
	position,
	delay = 0,
	fontSize = 18,
	fontFamily = "system-ui, sans-serif",
	posX = 50,
	posY = 88,
	editMode = false,
	onPositionChange,
}: SubtitleOverlayProps) => {
	const ref = useRef<HTMLDivElement>(null);
	const lookupPos = position + delay;
	const active = cues.find((c) => lookupPos >= c.start && lookupPos <= c.end);

	if (!active && !editMode) return null;
	if (cues.length === 0 && !editMode) return null;

	const displayText = active?.text ?? "Sample subtitle text";

	const handleMouseDown = (e: React.MouseEvent) => {
		if (!editMode || !onPositionChange) return;
		e.preventDefault();
		const parent = ref.current?.parentElement;
		if (!parent) return;

		const rect = parent.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const startPosX = posX;
		const startPosY = posY;

		const handleMove = (me: MouseEvent) => {
			const newX = Math.min(
				95,
				Math.max(5, startPosX + ((me.clientX - startX) / rect.width) * 100)
			);
			const newY = Math.min(
				97,
				Math.max(3, startPosY + ((me.clientY - startY) / rect.height) * 100)
			);
			onPositionChange(newX, newY);
		};

		const handleUp = () => {
			document.removeEventListener("mousemove", handleMove);
			document.removeEventListener("mouseup", handleUp);
		};

		document.addEventListener("mousemove", handleMove);
		document.addEventListener("mouseup", handleUp);
	};

	return (
		<div
			ref={ref}
			onMouseDown={handleMouseDown}
			style={{
				position: "absolute",
				left: `${posX}%`,
				top: `${posY}%`,
				transform: "translate(-50%, -50%)",
				pointerEvents: editMode ? "auto" : "none",
				zIndex: 30,
				cursor: editMode ? "grab" : "default",
				maxWidth: "80%",
				userSelect: "none",
			}}
		>
			<div
				style={{
					fontSize: `${fontSize}px`,
					fontFamily,
					backgroundColor: "rgba(0,0,0,0.65)",
					color: "white",
					padding: "6px 16px",
					borderRadius: "4px",
					textAlign: "center",
					lineHeight: 1.4,
					textShadow: "0 1px 3px rgba(0,0,0,0.9)",
					border: editMode ? "2px dashed rgba(255,255,255,0.6)" : "none",
					opacity: !active && editMode ? 0.5 : 1,
				}}
			>
				{displayText.split("\n").map((line, i, arr) => (
					<span key={i}>
						{line}
						{i < arr.length - 1 && <br />}
					</span>
				))}
			</div>
		</div>
	);
};
