import React from "react";
import ReactDOM from "react-dom/client";

import "./theme/tokens.css";
import "./theme/graphite.css";
import "./theme/midnight.css";
import "./theme/paper.css";
import "./theme/coral.css";
import "./theme/linen.css";
import "./theme/mist.css";
import "./theme/parchment.css";
import "./theme/terminal.css";
import "./theme/sunrise.css";
import "./theme/slate.css";
import "./theme/calm.css";
import "./theme/daltonic.css";
import App from "./App";
import {
  applyAccentOverride,
  applyTextScale,
  applyTheme,
  readAccentOverride,
  readTextScale,
  readTheme,
} from "./theme/registry";

// Apply persisted theme + text scale + accent override before React
// mounts so the user never sees a flash of the wrong palette,
// wrong-size copy, or wrong accent on cold start.
applyTheme(readTheme());
applyTextScale(readTextScale());
applyAccentOverride(readAccentOverride());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
