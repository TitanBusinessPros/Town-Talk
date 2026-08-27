// serveOutreachAdmin.js
//
// Minimal static file server for the townfuss-outreach-admin repo, used
// only by the outreach-admin Playwright spec(s). That repo is a
// completely separate Firebase Hosting site from this one (see
// project_sales_outreach_agent memory) — the Town-Talk repo's own
// `firebase emulators:start` only serves ITS hosting dir on :5000, so the
// outreach admin's static files need their own tiny server. Auth/
// Firestore/Functions still all point at the SAME local emulator suite
// (127.0.0.1:9099/8080/5001) via the connectXEmulator() calls added to
// index.html/replies.html — only the plain HTML/JS/CSS is served from
// here, on its own port so it doesn't collide with the main app's :5000.
//
// Run with: node testing/serveOutreachAdmin.js
// (leave running in its own terminal alongside `firebase emulators:start`)
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", "townfuss-outreach-admin");
const PORT = 5050;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(ROOT, reqPath);
  // Basic traversal guard — this only ever serves local test files, but
  // no reason to be sloppy about it.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}`);
});
