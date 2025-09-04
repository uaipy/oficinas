/**
 * Node.js script (Windows-friendly) that reads JSON lines from an Arduino serial port
 * and forwards each JSON object to a local FastAPI endpoint.
 *
 * Run:
 *   npm i serialport @serialport/parser-readline axios
 *   node serial-to-fastapi.js
 *
 * Configure via ENV or edit the CONFIG below:
 *   SERIAL_PORT=COM3 (or "auto" to auto-detect Arduino)
 *   SERIAL_BAUD=115200
 *   API_URL=http://api.uaipy.com.br/ingest
 */

const axios = require("axios");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

// ====== CONFIG ======
const CONFIG = {
  SERIAL_PORT: process.env.SERIAL_PORT || "auto", // "auto" tries to find Arduino; or set to "COM3", "COM4", etc.
  SERIAL_BAUD: parseInt(process.env.SERIAL_BAUD || "115200", 10),
  API_URL: process.env.API_URL || "http://127.0.0.1:8000/telemetry",
  LINE_DELIMITER: "\n", // Arduino should print each JSON object with println()
  CONNECT_RETRY_MS: 3000,
  POST_TIMEOUT_MS: 5000,
  MAX_POST_RETRIES: 3,
};
// =====================

let port = null;
let parser = null;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function autoDetectPort() {
  try {
    const ports = await SerialPort.list();
    // Prefer devices that look like Arduino
    const preferred = ports.find(
      (p) =>
        /arduino|wch|usb/i.test(`${p.manufacturer || ""} ${p.friendlyName || ""} ${p.path || ""}`)
    );
    if (preferred) return preferred.path;
    // Fallback: pick first COM* device
    const com = ports.find((p) => /^COM\d+$/i.test(p.path || ""));
    if (com) return com.path;
  } catch (err) {
    // ignore and fallback below
  }
  // Last resort common Windows default
  return "COM3";
}

async function openPort() {
  const path = CONFIG.SERIAL_PORT === "auto" ? await autoDetectPort() : CONFIG.SERIAL_PORT;

  return new Promise((resolve, reject) => {
    const sp = new SerialPort(
      {
        path,
        baudRate: CONFIG.SERIAL_BAUD,
        autoOpen: false,
      },
      (err) => {
        if (err) console.error("[serial] ctor error:", err.message);
      }
    );

    sp.open((err) => {
      if (err) {
        console.error(`[serial] Failed to open ${path}:`, err.message);
        reject(err);
        return;
      }
      console.log(`[serial] Opened ${path} @ ${CONFIG.SERIAL_BAUD} baud`);
      resolve(sp);
    });
  });
}

async function ensureOpen() {
  while (true) {
    try {
      port = await openPort();
      parser = port.pipe(new ReadlineParser({ delimiter: CONFIG.LINE_DELIMITER }));
      wireHandlers();
      break;
    } catch {
      console.log(`[serial] Retry opening in ${CONFIG.CONNECT_RETRY_MS} ms...`);
      await sleep(CONFIG.CONNECT_RETRY_MS);
    }
  }
}

function wireHandlers() {
  port.on("close", async () => {
    console.error("[serial] Port closed. Reconnecting...");
    await sleep(CONFIG.CONNECT_RETRY_MS);
    ensureOpen().catch((e) => console.error("[serial] Reconnect failed:", e.message));
  });

  port.on("error", async (err) => {
    console.error("[serial] Error:", err.message);
    try {
      port.close();
    } catch {}
  });

  parser.on("data", async (line) => {
    const trimmed = (line || "").toString().trim();
    if (!trimmed) return;

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (e) {
      console.error("[parse] Invalid JSON line, skipping:", trimmed);
      return;
    }

    // Enrich with server-side timestamp if needed
    const enriched = {
      ...payload,
      _ingested_at: new Date().toISOString(),
      _source: "arduino-serial",
    };

    try {
      await postWithRetries(enriched, CONFIG.MAX_POST_RETRIES);
      // console.log("[post] OK"); // optional
    } catch (e) {
      console.error("[post] Failed after retries:", e.message);
    }
  });
}

async function postWithRetries(data, retriesLeft) {
  try {
    await axios.post(CONFIG.API_URL, data, {
      timeout: CONFIG.POST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (err) {
    if (retriesLeft > 0) {
      const wait = CONFIG.POST_TIMEOUT_MS * (CONFIG.MAX_POST_RETRIES - retriesLeft + 1);
      console.warn(
        `[post] Error (${err.code || err.message}). Retrying in ${wait} ms... (${retriesLeft} left)`
      );
      await sleep(wait);
      return postWithRetries(data, retriesLeft - 1);
    }
    throw err;
  }
}

process.on("SIGINT", async () => {
  console.log("\n[sys] Caught SIGINT. Closing...");
  try {
    if (port && port.isOpen) {
      await new Promise((res) => port.close(res));
    }
  } catch {}
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  console.error("[sys] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[sys] Uncaught exception:", err);
});

(async function main() {
  console.log("[sys] Starting serial → FastAPI forwarder");
  console.log(`[cfg] API_URL=${CONFIG.API_URL}`);
  console.log(
    `[cfg] SERIAL_PORT=${CONFIG.SERIAL_PORT} (auto-detect will pick Arduino/COM*), BAUD=${CONFIG.SERIAL_BAUD}`
  );
  await ensureOpen();
})();
