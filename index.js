"use strict";

const http = require("http");
const crypto = require("crypto");

// =======================
// ENV
// =======================
const PORT = process.env.PORT || 3000;
const PUBLIC_KEY = process.env.PUBLIC_KEY;

if (!PUBLIC_KEY) {
  console.error("❌ Missing PUBLIC_KEY env var");
  process.exit(1);
}

// =======================
// DISCORD SIGNATURE VERIFY
// =======================
function publicKeyToPem(hex) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = Buffer.from(hex, "hex");
  const der = Buffer.concat([prefix, key]);
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

const PUBLIC_KEY_PEM = publicKeyToPem(PUBLIC_KEY);

function verifyRequest(signature, timestamp, body) {
  const message = Buffer.from(timestamp + body);
  const sig = Buffer.from(signature, "hex");
  const key = crypto.createPublicKey(PUBLIC_KEY_PEM);
  return crypto.verify(null, message, key, sig);
}

// =======================
// RESPONSE HELPER
// =======================
function respond(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// =======================
// HTTP SERVER
// =======================
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    return res.end("✅ Bot is running.");
  }

  // Discord interactions
  if (req.method !== "POST" || req.url !== "/interactions") {
    res.writeHead(404);
    return res.end("Not found");
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    // Verify request
    const isValid = verifyRequest(signature, timestamp, body);
    if (!isValid) {
      res.writeHead(401);
      return res.end("Invalid request signature");
    }

    const interaction = JSON.parse(body);

    // Discord ping
    if (interaction.type === 1) {
      return respond(res, { type: 1 });
    }

    // /serverinfo command
    if (interaction.data?.name === "serverinfo") {
      return respond(res, {
        type: 4,
        data: {
          content: "✅ Server info command received. Bot is online and working!"
        }
      });
    }

    // Default reply
    return respond(res, {
      type: 4,
      data: {
        content: "Command received."
      }
    });
  });
});

// =======================
// START SERVER (Railway compatible)
// =======================
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running on port", PORT);
});
