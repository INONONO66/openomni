const { appendFileSync } = require("node:fs");
const { app } = require("electron");

// Loaded before the production entry: no startup/preload error can precede these observers.
app.setPath("userData", process.env.DESKTOP_SMOKE_PROFILE);
app.on("web-contents-created", (_event, contents) => {
  const record = (kind, message) => {
    appendFileSync(process.env.DESKTOP_SMOKE_ERRORS, `${JSON.stringify({ kind, message })}\n`);
  };
  contents.on("console-message", ({ level, message }) => {
    if (level === "error") record("console", message);
  });
  contents.on("preload-error", (_event, path, error) => record("preload", `${path}: ${error.message}`));
  contents.on("did-fail-load", (_event, code, description, url) => {
    record("load", `${code}: ${description}: ${url}`);
  });
  contents.on("render-process-gone", (_event, details) => {
    record("renderer-exit", `${details.reason}: ${details.exitCode}`);
  });
});
