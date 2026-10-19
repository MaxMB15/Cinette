// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { withPerfCounters } from "./dev/perf";
import "./styles/globals.css";

const container = document.getElementById("root")!;
const app = (
	<React.StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</React.StrictMode>
);

// A dev build can count renders and backend calls. See src/dev/perf.tsx.
ReactDOM.createRoot(container).render(import.meta.env.DEV ? withPerfCounters(app, container) : app);
