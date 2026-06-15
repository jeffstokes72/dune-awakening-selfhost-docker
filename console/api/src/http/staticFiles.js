import { existsSync, createReadStream } from "node:fs";
import { extname } from "node:path";
import { json, withSecurityHeaders } from "../auth.js";
import { safeStaticTarget } from "../httpSafety.js";

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"]
]);

export function contentTypeForPath(target) {
  return mime.get(extname(target)) || "application/octet-stream";
}

export function serveStatic(config, req, res) {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  const target = safeStaticTarget(config.staticDir, path);
  if (!existsSync(target)) {
    json(res, 200, { app: config.appName, message: "Frontend is not built yet. Run npm install && npm run build in console/web/." });
    return;
  }
  res.writeHead(200, withSecurityHeaders({ "content-type": contentTypeForPath(target) }));
  createReadStream(target).pipe(res);
}
