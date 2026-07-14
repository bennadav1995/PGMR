'use strict';

/**
 * PGMR — ESP-NOW USB Serial → WebSocket bridge
 *
 * Serial in:  /dev/cu.usbserial-0001 @ 115200
 *   ID:5|NAME:Shenkar Devices|RSSI:-95|DIST:177.83
 *
 * WebSocket:  ws://localhost:8081/ws/sensors  (falls back to 8080)
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const SERIAL_PATH = process.env.SERIAL_PATH || '/dev/cu.usbserial-0001';
const BAUD_RATE = Number(process.env.SERIAL_BAUD) || 115200;
const WS_PORTS = [8081, 8080];

const clients = new Set();

/**
 * Parse a raw ESP32 serial line into the frontend sensor JSON payload.
 * Example: ID:5|NAME:Shenkar Devices|RSSI:-95|DIST:177.83
 */
function parseSensorLine(line) {
  const text = String(line).replace(/\r/g, '').trim();
  if (!text || !text.includes('ID:')) return null;

  const fields = {};
  for (const segment of text.split('|')) {
    const idx = segment.indexOf(':');
    if (idx === -1) continue;
    const key = segment.slice(0, idx).trim().toUpperCase();
    const value = segment.slice(idx + 1).trim();
    fields[key] = value;
  }

  if (fields.ID == null || fields.RSSI == null) return null;

  const idNum = Number(fields.ID);
  if (!Number.isFinite(idNum)) return null;

  const rssi = Number(fields.RSSI);
  const distance = Number(fields.DIST ?? fields.DISTANCE);
  const name = fields.NAME || fields.SSID || 'UNKNOWN';
  const sensor = String(Math.trunc(idNum)).padStart(2, '0');

  return {
    sensor,
    sensor_id: Math.trunc(idNum),
    ssid: name,
    device: name,
    rssi: Number.isFinite(rssi) ? rssi : -70,
    distance: Number.isFinite(distance) ? distance : 50,
    distance_m: Number.isFinite(distance) ? distance : 50,
  };
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (err) {
        console.warn('[bridge] WS send failed:', err.message);
      }
    }
  }
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/', (_req, res) => {
    res.type('text').send(
      [
        'PGMR ESP-NOW USB Serial bridge',
        `serial: ${SERIAL_PATH} @ ${BAUD_RATE}`,
        'ws path: /ws/sensors',
        `clients: ${clients.size}`,
      ].join('\n')
    );
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      serialPath: SERIAL_PATH,
      baudRate: BAUD_RATE,
      clients: clients.size,
    });
  });

  return app;
}

function listenWithFallback(app) {
  return new Promise((resolve, reject) => {
    const tryPort = (index) => {
      if (index >= WS_PORTS.length) {
        reject(new Error(`No free port among ${WS_PORTS.join(', ')}`));
        return;
      }

      const port = WS_PORTS[index];
      const server = http.createServer(app);

      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          console.warn(`[bridge] Port ${port} is in use (EADDRINUSE) — falling back…`);
          server.close(() => tryPort(index + 1));
          return;
        }
        reject(err);
      };

      const onListening = () => {
        server.off('error', onError);

        const wss = new WebSocketServer({ server, path: '/ws/sensors' });
        wss.on('connection', (socket, req) => {
          clients.add(socket);
          console.log(
            `[bridge] WS client connected ${req.socket.remoteAddress} (${clients.size} total)`
          );
          socket.on('close', () => {
            clients.delete(socket);
            console.log(`[bridge] WS client disconnected (${clients.size} total)`);
          });
          socket.on('error', () => {
            clients.delete(socket);
          });
        });

        console.log(`[bridge] ACTIVE PORT: ${port}`);
        console.log(`[bridge] HTTP   → http://localhost:${port}/`);
        console.log(`[bridge] WS     → ws://localhost:${port}/ws/sensors`);
        resolve({ server, wss, port });
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    };

    tryPort(0);
  });
}

function startSerial() {
  console.log(`[bridge] Opening serial ${SERIAL_PATH} @ ${BAUD_RATE}`);

  const port = new SerialPort({
    path: SERIAL_PATH,
    baudRate: BAUD_RATE,
    autoOpen: true,
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    console.log('[bridge] Serial open — streaming ESP-NOW lines');
  });

  port.on('error', (err) => {
    console.error(`[bridge] Serial error: ${err.message}`);
    console.error('[bridge] Close Arduino Serial Monitor, then check: ls /dev/cu.usb*');
  });

  parser.on('data', (line) => {
    const packet = parseSensorLine(line);
    if (!packet) {
      const preview = String(line).replace(/\r/g, '').trim();
      if (preview) console.log(`[bridge] skip: ${preview}`);
      return;
    }

    broadcast(packet);
    console.log(
      `[bridge] ${packet.sensor} ${packet.ssid} rssi=${packet.rssi} dist=${packet.distance_m} → ${clients.size} client(s)`
    );
  });

  return port;
}

async function main() {
  const app = createApp();
  const { server, wss, port } = await listenWithFallback(app);
  startSerial();

  console.log('[bridge] ESP-NOW USB Serial → WebSocket bridge is live');
  console.log(`[bridge] Frontend SOURCE:SENSORS → ws://localhost:${port}/ws/sensors`);

  const shutdown = () => {
    console.log('\n[bridge] Shutting down…');
    try {
      wss.close();
    } catch (_) {}
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[bridge] Fatal:', err.stack || err);
  process.exit(1);
});
