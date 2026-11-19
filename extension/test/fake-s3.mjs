// Enough of S3 for the extension's tests: path-style objects with ETags (HEAD too),
// conditional PUTs (If-Match / If-None-Match), DELETE and ListObjectsV2.
// Requests must be signed (an AWS4-HMAC-SHA256 Authorization header), but
// signatures aren't checked.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

export function startFakeS3() {
  const objects = new Map(); // "bucket/key" → { body, etag }
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url, "http://x");
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const full = `${bucket}/${key}`;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (status, body = "", headers = {}) => {
        res.writeHead(status, { "content-type": "application/xml", ...headers });
        res.end(body);
      };
      if (!String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256 ")) return send(403, "<Error><Code>AccessDenied</Code></Error>");
      const body = Buffer.concat(chunks);
      if (req.method === "GET" && !key) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).sort();
        const xml = keys
          .map((k) => `<Contents><Key>${k.slice(bucket.length + 1)}</Key><LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>${objects.get(k).etag.replaceAll('"', "&quot;")}</ETag></Contents>`)
          .join("");
        return send(200, `<ListBucketResult>${xml}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      if (req.method === "HEAD") {
        const o = objects.get(full);
        return o ? send(200, "", { etag: o.etag }) : send(404);
      }
      if (req.method === "GET") {
        const o = objects.get(full);
        return o ? send(200, o.body, { etag: o.etag, "content-type": "application/octet-stream" }) : send(404, "<Error><Code>NoSuchKey</Code></Error>");
      }
      if (req.method === "PUT") {
        const cur = objects.get(full);
        if (req.headers["if-none-match"] === "*" && cur) return send(412, "<Error><Code>PreconditionFailed</Code></Error>");
        const m = req.headers["if-match"];
        if (m && !cur) return send(404, "<Error><Code>NoSuchKey</Code></Error>");
        if (m && cur.etag !== m) return send(412, "<Error><Code>PreconditionFailed</Code></Error>");
        const etag = `"${createHash("md5").update(body).update(String(Date.now() + Math.random())).digest("hex")}"`;
        objects.set(full, { body, etag });
        return send(200, "", { etag });
      }
      if (req.method === "DELETE") {
        objects.delete(full);
        return send(204);
      }
      send(405);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, objects, port: server.address().port, requests: () => requests })),
  );
}
