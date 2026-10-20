import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import os from 'os';
import { createServer as createViteServer } from 'vite';

import { CONFIG, getCampaign } from './src/config.js';
import webhookRouter from './src/webhook.js';
import { pregenerateStaticLines, synthesizeSpeech } from './src/tts.js';
import {
  getGlobalLatencyMetrics,
  getAllSessions,
  getOrCreateSession,
  getSession,
  deleteSession
} from './src/session.js';
import { getProviderCounters } from './src/llm.js';
import { transcribeAudio } from './src/asr.js';
import { processTurn } from './src/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Structured JSON Logger Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const callId = req.body?.call_id || req.headers['x-call-id'] || 'system';
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api') && req.path !== '/api/health') {
      console.log(
        JSON.stringify({
          level: 'info',
          timestamp: new Date().toISOString(),
          call_id: callId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: duration
        })
      );
    }
  });
  next();
});

// 1. Healthcheck endpoints
const getHealthPayload = () => {
  const latency = getGlobalLatencyMetrics();
  const providers = getProviderCounters();
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: CONFIG.PORT,
    version: '1.0.0',
    providers: {
      gemini_active: Boolean(CONFIG.GEMINI_API_KEY),
      groq_active: Boolean(CONFIG.GROQ_API_KEY && CONFIG.GROQ_API_KEY.startsWith('gsk_')),
      metrics: providers
    },
    latency: {
      target_ms: CONFIG.TIMEOUTS.TOTAL_BUDGET,
      p50_ms: latency.p50,
      p95_ms: latency.p95,
      samples: latency.sample_count
    },
    active_sessions: getAllSessions().filter((s: any) => s.status === 'connected').length
  };
};

app.get('/health', (_req: Request, res: Response) => res.json(getHealthPayload()));
app.get('/api/health', (_req: Request, res: Response) => res.json(getHealthPayload()));

// 2. Telephony Webhook Contract Router
app.use('/api/webhook', webhookRouter);

// 3. PBX / Dialer Routes
app.get('/api/dialer/extensions', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    count: CONFIG.EXTENSIONS.length,
    extensions: CONFIG.EXTENSIONS
  });
});

app.get('/api/dialer/calls', (_req: Request, res: Response) => {
  const sessions = getAllSessions().map((s: any) => {
    const metrics = s.getMetrics ? s.getMetrics() : { duration_seconds: 0 };
    return {
      callId: s.callId,
      direction: s.direction,
      callerId: s.callerId,
      customerName: s.customerName || s.callerId,
      status: s.status,
      disposition: s.disposition,
      campaign: s.campaignId,
      turns: s.turns,
      startTime: s.startTime,
      endTime: s.endTime,
      duration_seconds: metrics.duration_seconds,
      transferredTo: s.transferredTo
    };
  });
  // Sort latest first
  sessions.sort((a: any, b: any) => (b.startTime || 0) - (a.startTime || 0));
  res.json({
    status: 'success',
    count: sessions.length,
    calls: sessions
  });
});

app.post('/api/dialer/call/start', async (req: Request, res: Response) => {
  const callId = req.body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const direction = req.body.direction === 'outbound' ? 'outbound' : 'inbound';
  const callerId = req.body.caller_id || req.body.From || 'Anonymous';
  const customerName = req.body.customer_name || '';
  const campaignId = req.body.campaign || (direction === 'outbound' ? 'sales' : 'support');
  const chosenVoice = req.body.voice || CONFIG.AUDIO.DEFAULT_VOICE;

  const session = getOrCreateSession(callId, {
    direction,
    callerId,
    campaignId
  });
  if (customerName) {
    (session as any).customerName = customerName;
  }

  const campaign = getCampaign(campaignId);
  const greeting = req.body.custom_greeting || campaign.greeting;
  session.recordTurn('assistant', greeting);

  console.log(`[Dialer][${callId}] Synthesizing greeting with voice: ${chosenVoice}`);
  const ttsRes = await synthesizeSpeech(greeting, {
    isStatic: !req.body.custom_greeting,
    voice: chosenVoice,
    callId
  });
  console.log(`[Dialer][${callId}] TTS Result:`, ttsRes);

  res.json({
    status: 'success',
    call_id: callId,
    direction,
    call_status: 'connected',
    greeting,
    audio_url: ttsRes.audio_url,
    available_extensions: CONFIG.EXTENSIONS,
    session: {
      callId,
      direction,
      status: session.status,
      campaign: campaign.name
    }
  });
});

app.post('/api/dialer/call/interact', upload.single('audio'), async (req: Request, res: Response) => {
  const callId = req.body.call_id || 'demo-call';
  const session = getOrCreateSession(callId);
  const tempPath = req.file?.path;
  let userText = (req.body.text || '').trim();

  try {
    if (tempPath && !userText) {
      const audioBuffer = fs.readFileSync(tempPath);
      const asr = await transcribeAudio(audioBuffer, { callId, language: session.language });
      userText = asr.text;
    }

    // If caller did not speak or audio was silence/background noise, stay listening quietly
    if (!userText) {
      return res.json({
        call_id: callId,
        action: 'listen',
        call_status: session.status,
        transcription: '',
        response: '',
        audio_url: null,
        is_silence: true,
        session: {
          turns: session.turns,
          status: session.status,
          disposition: session.disposition
        }
      });
    }

    const engineResult = await processTurn(session, userText);
    const chosenVoice = req.body.voice || CONFIG.AUDIO.DEFAULT_VOICE;
    const ttsResult = await synthesizeSpeech(engineResult.reply, {
      voice: chosenVoice,
      callId
    });

    res.json({
      call_id: callId,
      action: engineResult.action === 'transfer' ? 'transfer' : (engineResult.action === 'hangup' ? 'hangup' : 'continue'),
      call_status: session.status,
      transcription: userText,
      response: engineResult.reply,
      audio_url: ttsResult.audio_url,
      disposition: engineResult.disposition,
      transfer: engineResult.transfer ? {
        extension: engineResult.transfer.id,
        name: engineResult.transfer.name,
        department: engineResult.transfer.dept,
        sip_uri: engineResult.transfer.sip,
        phone_number: engineResult.transfer.phone,
        warm_transfer_notes: engineResult.reply
      } : null,
      session: {
        turns: session.turns,
        status: session.status,
        disposition: session.disposition
      }
    });
  } catch (err: any) {
    console.error(`[Dialer][${callId}] Error:`, err);
    res.status(500).json({ error: err.message || 'Failed to interact' });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
});

app.post('/api/dialer/call/transfer', async (req: Request, res: Response) => {
  const callId = req.body.call_id || 'demo-call';
  const extId = req.body.extension_id;
  const session = getOrCreateSession(callId);

  const ext = CONFIG.EXTENSIONS.find((e: any) => e.id === extId) || CONFIG.EXTENSIONS[0];
  session.status = 'transferred';
  session.disposition = 'manual_transfer';
  (session as any).transferredTo = ext;

  const transferMessage = `Certainly! I am transferring your call directly to ${ext.name} on extension ${ext.id}. Please stay on the line.`;
  session.recordTurn('assistant', transferMessage);

  const ttsRes = await synthesizeSpeech(transferMessage, {
    isStatic: true,
    callId
  });

  res.json({
    status: 'transferred',
    call_id: callId,
    transfer_message: transferMessage,
    audio_url: ttsRes.audio_url,
    transfer: {
      extension: ext.id,
      name: ext.name,
      department: ext.dept,
      sip_uri: ext.sip,
      phone_number: ext.phone
    }
  });
});

app.post('/api/dialer/call/end', (req: Request, res: Response) => {
  const callId = req.body.call_id;
  const session = getSession(callId);
  if (session) {
    session.end(req.body.disposition || 'caller_ended');
  }
  res.json({ status: 'ended', call_id: callId });
});

app.post('/api/reset/:id', (req: Request, res: Response) => {
  const callId = req.params.id;
  deleteSession(callId);
  res.json({ status: 'reset', call_id: callId });
});

// 4. Serve generated / cached audio files
app.get('/api/audio/:filename', (req: Request, res: Response) => {
  const rawParam = req.params.filename;
  const filename = Array.isArray(rawParam) ? rawParam[0] : (rawParam || '');
  const safeFilename = path.basename(filename);
  const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, safeFilename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file not found');
  }
  const ext = path.extname(safeFilename).toLowerCase();
  const mimeType = ext === '.wav' ? 'audio/wav' : (ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg');
  res.setHeader('Content-Type', mimeType);
  res.sendFile(filePath);
});

// 5. Mount Vite SPA in Dev or serve build in Prod
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`🚀 AI Call Assistant & Telephony Engine running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
    pregenerateStaticLines().catch((err: any) => console.warn('Pregeneration notice:', err.message));
  });
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
