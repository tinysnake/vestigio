// Mock OpenAI-completions endpoint. Records every request body as one JSON line.
// Usage: node mock-server.mjs <port> <logfile>
// Env: MOCK_DELAY_MS delays the response so a client can steer mid-stream.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.argv[2] ?? 8799);
const logfile = process.argv[3] ?? "/tmp/vestigio-probe/requests.jsonl";
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fs.appendFileSync(
      logfile,
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        url: req.url,
        body: safeParse(body),
      }) + "\n",
    );

    if (req.url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
      return;
    }

    let stream = false;
    try {
      stream = JSON.parse(body)?.stream === true;
    } catch {}

    const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    const created = () => Math.floor(Date.now() / 1000);

    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = () => {
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: created(), model: "mock-1", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: created(), model: "mock-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      };
      delay ? setTimeout(send, delay) : send();
      return;
    }

    const sendJson = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: created(),
          model: "mock-1",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage,
        }),
      );
    };
    delay ? setTimeout(sendJson, delay) : sendJson();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-server listening on ${port}, log=${logfile}, delay=${delay}`);
});

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { _unparsed: true };
  }
}
