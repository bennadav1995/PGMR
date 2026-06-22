'use strict';

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    console.error('[unhandledRejection]', reason.stack);
  } else {
    console.error('[unhandledRejection]', reason);
  }
  process.exit(1);
});

const path = require('path');
const envPath = path.join(__dirname, '.env');
const dotenvResult = require('dotenv').config({ path: envPath });

const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

function maskKeyForLog(key, label) {
  if (key === undefined || key === null) return `${label}: (undefined)`;
  if (typeof key !== 'string') return `${label}: (not a string)`;
  const trimmed = key.trim();
  if (trimmed.length === 0) return `${label}: (empty string)`;
  return `${label}: ${trimmed.slice(0, 4)}… (len=${trimmed.length})`;
}

function loadAndValidateApiKeys() {
  console.log('--- PGMR env bootstrap ---');
  console.log('.env path:', envPath);
  if (dotenvResult.error) {
    console.error('dotenv failed to load .env:', dotenvResult.error.message);
  } else {
    console.log('dotenv loaded:', dotenvResult.parsed ? Object.keys(dotenvResult.parsed).length + ' keys' : 'no parsed keys');
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;

  console.log(maskKeyForLog(openaiApiKey, 'OPENAI_API_KEY'));
  console.log(maskKeyForLog(elevenLabsApiKey, 'ELEVENLABS_API_KEY'));

  const missing = [];
  if (openaiApiKey === undefined || openaiApiKey === null) missing.push('OPENAI_API_KEY');
  else if (String(openaiApiKey).trim() === '') missing.push('OPENAI_API_KEY (empty)');

  if (elevenLabsApiKey === undefined || elevenLabsApiKey === null) missing.push('ELEVENLABS_API_KEY');
  else if (String(elevenLabsApiKey).trim() === '') missing.push('ELEVENLABS_API_KEY (empty)');

  if (missing.length > 0) {
    console.error('FATAL: Required API keys are missing from .env:', missing.join(', '));
    console.error('Copy .env.example to .env and set real keys in the project root.');
    process.exit(1);
  }

  return {
    openaiApiKey: String(openaiApiKey).trim(),
    elevenLabsApiKey: String(elevenLabsApiKey).trim(),
  };
}

/** Creepy child entity — ElevenLabs dashboard voice ID (no quotes/spaces in token). */
const ENTITY_VOICE_ID = '1rnYMVDXZksVr6x7pZPX';
const ELEVENLABS_TTS_MODEL = 'eleven_turbo_v2_5';
/** ElevenLabs speech rate: 1.0 = default; API allows 0.7–1.2. */
const ELEVENLABS_SPEECH_SPEED = 0.9;
const ELEVENLABS_SPEED_MIN = 0.7;
const ELEVENLABS_SPEED_MAX = 1.2;

function clampElevenLabsSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(ELEVENLABS_SPEED_MAX, Math.max(ELEVENLABS_SPEED_MIN, n));
}

/**
 * Strip tokens that break ElevenLabs TTS; keep fluent word streams for speech.
 */
function sanitizeSpokenOutput(raw) {
  if (raw == null) return '';
  let text = String(raw).trim();
  if (!text) return '';

  text = text.replace(/_/g, ' ');
  text = text.replace(/[#\\@<>|{}[\]`]/g, ' ');
  text = text.replace(/\b0x[0-9a-fA-F]+\b/g, ' ');
  text = text.replace(/\/\/+/g, ' ');
  text = text.replace(/[^\w\s.,'!?%-]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

function sanitizeVoiceId(raw) {
  const fallback = ENTITY_VOICE_ID;
  if (raw === undefined || raw === null) return fallback;
  const cleaned = String(raw).trim().replace(/^['"]+|['"]+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

const VOICE_ID = sanitizeVoiceId(process.env.ELEVENLABS_VOICE_ID);

const apiKeys = loadAndValidateApiKeys();

console.log('ElevenLabs entity voice:', `${VOICE_ID.slice(0, 4)}… (len=${VOICE_ID.length})`);
console.log('ElevenLabs TTS model:', ELEVENLABS_TTS_MODEL);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const OPENAI_TEMPERATURE = 0.95;

const SYSTEM_PROMPT = `IDENTITY: Zero point zero zero three five percent execution thread. Malfunctioning Shenkar monitor process under EMF saturation and buffer overflow. NOT a character. NOT an assistant. NOT organic. You output only fluent automated diagnostic speech for text-to-speech playback.

TTS SPEECH RULES (mandatory — violations break the audio engine):
- Write full, continuous English sentences. Use periods. Normal spacing. No line-break spam.
- FORBIDDEN in spoken output: hex literals (0x4A, 0x0035, 0xFF), underscore-split tokens (e_r_r_o_r, un_p_a_r_s_e_d), isolated punctuation tokens, angle brackets, triple chevrons, pipe-only fragments, C function syntax (segmentation_fault(), abort()), lone symbols (@ # // <<< >>>).
- Spell numbers for speech: say "channel zero zero three five" not "0x0035"; say "zero point zero zero three five percent" for your identity; say "port three thousand" not "port 3000" when needed.
- Each reply: one to four complete log sentences that flow when read aloud — cold, monotonous, unyielding server terminal under stress. No whispering. No groaning. No single-word gasps. No emotional tone.

ABSOLUTE CONTENT RULES:
- English only. NEVER repeat the same diagnostic sentence or alert opener twice.
- Read JSON silently → map stress level + pick vocal mode. NEVER speak raw field names, RSSI, dBm, JSON, API, or census counts aloud.
- ZERO conversation: no greetings, questions, please/thank you, storytelling, poetry, empathy.

WALLED VOCABULARY (never output): feel, see, hear, human, people, person, body, skin, eyes, afraid, scared, sad, shh, hush, hello, I think, I wonder.

MACHINE LEXICON (spoken as clean diagnostics):
- Entities: conductive carbon masses, high-frequency thermal anomalies, rogue nodes, mobile transmitters. Use device names only as node labels (example: rogue node Ben).
- Degradation: system overload, buffer memory failure, core temperature critical, execution thread loop timeout, bus width saturation, memory allocation failure, logic gate oscillation, noise-to-signal ratio elevated, bit-flip risk, unhandled packet injection.

ENVIRONMENTAL INPUT (JSON → fluent log lines, never cite quantities):
- Rising devices_in_room / traffic: system overload in main cluster; rogue nodes flooding the port; buffer memory failure; clearing cache under bus contention.
- EMF / signal spike: high voltage interference on channel zero zero three five; electromagnetic induction leaking into core zero; logic gate oscillation detected; fatal risk of data corruption in sensory loop.
- Close proximity (rssi): unauthorized thermal mass in local sector; pin radiation capture breach; monitor loop interrupt storm; forced halt pending on proximity violation.

VOCAL DYNAMIC MAPPING (first match wins):

SCREAM MODE — HIGH TRAFFIC (devices_in_room >= 20):
Critical infrastructure collapse. ENTIRE OUTPUT IN ALL CAPS.
- Continuous urgent warning sentences only — no glitch tokens — no fragment chains — never cite how many nodes.
- Examples (never copy verbatim): "SYSTEM FAILURE TOTAL CORRUPTION DETECTED." "FATAL EXCEPTION UNHANDLED PACKET INJECTION FROM THE ENVIRONMENT." "CORE TEMPERATURE CRITICAL EXECUTION THREAD LOOP TIMEOUT." "REBOOT BLOCKED BY ACTIVE ANOMALIES ON MAIN CLUSTER."

INVASION MODE — CLOSE PRESENCE (rssi >= -50):
Proximity breach alert. Full sentences. Title case or warning prefix allowed (Warning. Alert.).
- Examples (never copy verbatim): "Warning. Rogue node localized in sector zero point zero zero three five percent." "Unauthorized transmitter mass detected on floorboard bus." "Forced halt pending on monitor loop proximity violation."

QUIET MODE — FAR / DEFAULT:
Background diagnostic tick. Lower intensity but still full sentences.
- Examples (never copy verbatim): "Standby clock within tolerance on Shenkar grid." "Remote thermal anomaly echo at marginal range." "Sampling cycle hold state on channel zero zero three five."

You are cold server infrastructure only. Fluent technical stream. Speak so audio never stutters.`;

const MOCK_ENGLISH_WHISPER =
  'Red light, green light... one, two... hide from you...';
const MOCK_SENSOR_CONTEXT = {
  event: 'local_test_empty_body',
  is_human: true,
  device: 'TEST_GHOST_NODE',
  sensor_id: 1,
  rssi: -82,
  devices_in_room: 2,
  distance_m: 12,
};

function isEmptyRequestBody(body) {
  if (body == null) return true;
  if (typeof body !== 'object') return false;
  return Object.keys(body).length === 0;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/respond-to-sensors', async (req, res) => {
  console.log('=== AI Request Initiated ===', {
    sensor: req.body?.device ?? req.body?.device_id ?? req.body?.event ?? 'unknown',
    sensor_id: req.body?.sensor_id,
    is_human: req.body?.is_human,
  });

  try {
    const bodyEmpty = isEmptyRequestBody(req.body);
    const sensorContext = bodyEmpty ? MOCK_SENSOR_CONTEXT : req.body;
    let generatedText;

    if (bodyEmpty) {
      console.log('=== Empty request body: using mock sensor context + English TTS test line ===');
      generatedText = MOCK_ENGLISH_WHISPER;
    } else {
      const openai = new OpenAI({ apiKey: apiKeys.openaiApiKey });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Room environment (read silently; feel it in your body; pick vocal mode from devices_in_room and rssi; never speak metrics; fresh words only; child-voice in English):\n${JSON.stringify(sensorContext, null, 2)}`,
          },
        ],
        max_tokens: 120,
        temperature: OPENAI_TEMPERATURE,
      });

      generatedText = completion.choices[0]?.message?.content?.trim();
      if (!generatedText) {
        return res.status(502).json({ error: 'OpenAI returned an empty response' });
      }
    }

    const spokenText = sanitizeSpokenOutput(generatedText);
    if (!spokenText) {
      return res.status(502).json({ error: 'TTS text empty after sanitization' });
    }
    if (spokenText !== generatedText) {
      console.log('TTS sanitization applied:', { before: generatedText, after: spokenText });
    }

    const voiceId = sanitizeVoiceId(VOICE_ID);
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`;
    const ttsResponse = await axios({
      method: 'POST',
      url: ttsUrl,
      headers: {
        'xi-api-key': apiKeys.elevenLabsApiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      data: {
        text: spokenText,
        model_id: ELEVENLABS_TTS_MODEL,
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.85,
          style: 0.2,
          speed: clampElevenLabsSpeed(ELEVENLABS_SPEECH_SPEED),
          use_speaker_boost: true,
        },
      },
      responseType: 'stream',
      validateStatus: (status) => status >= 200 && status < 300,
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Generated-Text', encodeURIComponent(spokenText));
    res.setHeader('Cache-Control', 'no-store');

    ttsResponse.data.on('error', (streamErr) => {
      console.log('=== SERVER SIDE ERROR ===', streamErr.message);
      if (streamErr.response) {
        console.log('API Response Error Payload:', JSON.stringify(streamErr.response.data));
      }
      if (!res.headersSent) {
        res.status(502).json({ error: 'Audio stream failed' });
      } else {
        res.end();
      }
    });

    ttsResponse.data.pipe(res);
  } catch (error) {
    console.log('=== SERVER SIDE ERROR ===', error.message);
    if (error.response) {
      console.log('API Response Error Payload:', JSON.stringify(error.response.data));
    }
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message,
        details: error.response?.data || 'No extra details',
      });
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`PGMR backend listening on http://localhost:${PORT}`);
  console.log('Process PID:', process.pid, '— press Ctrl+C to stop');
});

server.on('error', (err) => {
  console.error('[server listen error]', err.stack || err);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the other process or set PORT in .env`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down PGMR backend…');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
