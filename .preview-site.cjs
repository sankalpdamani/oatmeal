// Tiny static server for the landing page preview (dev only).
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "site");
const port = process.env.PORT || 8920;

http
  .createServer((req, res) => {
    const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = path.join(root, path.normalize(url));
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`oatmeal site on http://localhost:${port}`));
