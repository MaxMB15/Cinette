import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";

const PRESETS = {
	"Apple HLS (H.264)":
		"https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8",
};

const App = () => {
	const [url, setUrl] = useState<string>(PRESETS["Apple HLS (H.264)"]);
	const [status, setStatus] = useState<string>("Pick an engine to play the URL below");
	const os = platform();

	const callEngine = async (command: "play_url" | "play_url_mpv", label: string) => {
		setStatus(`Calling ${label}…`);
		try {
			const result = await invoke<string>(command, { url });
			setStatus(`Queued: ${result}`);
		} catch (err) {
			setStatus(`ERR (${label}) — ${String(err)}`);
		}
	};

	return (
		<main className="container">
			<header>
				<h1>MVP iOS POC</h1>
				<span className="pill">platform: {os}</span>
			</header>
			<p className="subtitle">Stage 2 — engine comparison</p>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 8,
					width: "100%",
					maxWidth: 420,
				}}
			>
				<label htmlFor="stream-url" style={{ fontSize: 12, opacity: 0.7 }}>
					Stream URL
				</label>
				<input
					id="stream-url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https:// or http:// URL"
					style={{ padding: 8, fontSize: 13, fontFamily: "monospace" }}
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
				/>
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
					{Object.entries(PRESETS).map(([name, value]) => (
						<button
							key={name}
							onClick={() => setUrl(value)}
							style={{ fontSize: 11, padding: "4px 8px" }}
						>
							{name}
						</button>
					))}
				</div>
				<button onClick={() => callEngine("play_url", "AVPlayer")}>
					Play with AVPlayer
				</button>
				<button onClick={() => callEngine("play_url_mpv", "libmpv")}>
					Play with libmpv
				</button>
			</div>
			<pre className="status">{status}</pre>
		</main>
	);
};

export default App;
