import { GoogleGenAI } from '@google/genai';
import { CONFIG } from './config.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Memory and file cache for static audio lines
const audioCache = new Map();

// Ensure audio cache directory exists
if (!fs.existsSync(CONFIG.AUDIO.CACHE_DIR)) {
  fs.mkdirSync(CONFIG.AUDIO.CACHE_DIR, { recursive: true });
}

// Populate audioCache from disk on startup
try {
  const files = fs.readdirSync(CONFIG.AUDIO.CACHE_DIR);
  for (const f of files) {
    if (f.endsWith('.wav') || f.endsWith('.mp3')) {
      audioCache.set(f, f);
    }
  }
} catch (e) {}

/**
 * Map voice name to Gemini TTS prebuilt voice
 * Gemini prebuilt voices: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
 */
export function mapToGeminiVoice(voiceName) {
  if (!voiceName) return 'Kore';
  const v = voiceName.toLowerCase();
  if (v.includes('guy') || v.includes('male') || v.includes('david')) return 'Puck';
  if (v.includes('charon') || v.includes('deep')) return 'Charon';
  if (v.includes('fenrir')) return 'Fenrir';
  if (v.includes('aria') || v.includes('zephyr')) return 'Zephyr';
  if (v.includes('jenny')) return 'Kore';
  return 'Kore';
}

/**
 * Generate a SHA256 cache key for static lines
 */
function getCacheKey(text, voice, format = 'wav') {
  return crypto.createHash('sha256').update(`${text}_${voice}_${format}`).digest('hex');
}

/**
 * Clean text for spoken TTS
 */
function cleanSpokenText(text) {
  if (!text) return '';
  return text
    .replace(/[*_#`~[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pre-generate static lines (e.g. greetings) in the background so inbound calls connect with 0ms audio latency
 */
export async function pregenerateStaticLines() {
  try {
    const greeting = 'Thank you for calling Customer Support. I am Alex, your automated AI voice agent. What can I help you with today?';
    await synthesizeSpeech(greeting, { isStatic: true, callId: 'pregen' });
  } catch (e) {
    // Non-blocking
  }
}

/**
 * Synthesize speech audio with Gemini 3.8 Flash TTS
 */
export async function synthesizeSpeech(text, options = {}) {
  const t0 = Date.now();
  const {
    voice = CONFIG.AUDIO.DEFAULT_VOICE,
    format = 'wav',
    isStatic = false,
    callId = 'tts'
  } = options;

  const clean = cleanSpokenText(text);
  if (!clean) {
    return { audio_url: null, audio_buffer: null, latency_ms: 0, cached: false, format: 'wav' };
  }

  const cacheKey = getCacheKey(clean, voice, format);
  const staticFilename = `static-${cacheKey.slice(0, 16)}.wav`;
  const staticPath = path.join(CONFIG.AUDIO.CACHE_DIR, staticFilename);

  // Instant disk cache check
  if (fs.existsSync(staticPath)) {
    return {
      audio_url: `/api/audio/${staticFilename}`,
      audio_buffer: fs.readFileSync(staticPath),
      latency_ms: Date.now() - t0,
      cached: true,
      format: 'wav'
    };
  }

  // Gemini TTS Models Chain: 'gemini-3.8-flash-tts' then 'gemini-3.8-flash-lite-tts'
  const ttsModels = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
  const geminiKey = CONFIG.GEMINI_API_KEY;

  // If we know TTS quota is currently exhausted, don't stall for seconds
  if (global.__ttsQuotaExhaustedUntil && Date.now() < global.__ttsQuotaExhaustedUntil) {
    return {
      audio_url: null,
      audio_buffer: null,
      latency_ms: Date.now() - t0,
      cached: false,
      fallback_tts: 'client'
    };
  }

  if (geminiKey) {
    const geminiVoice = mapToGeminiVoice(voice);
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });

    for (const model of ttsModels) {
      try {
        const ttsPromise = ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [{ text: clean }]
            }
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: geminiVoice }
              }
            }
          }
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${model} timeout (3s)`)), 3000)
        );

        const response = await Promise.race([ttsPromise, timeoutPromise]);
        const base64Audio = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (base64Audio) {
          const wavBuffer = Buffer.from(base64Audio, 'base64');
          const filename = isStatic
            ? `static-${cacheKey.slice(0, 16)}.wav`
            : `reply-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.wav`;
          const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, filename);
          fs.writeFileSync(filePath, wavBuffer);

          audioCache.set(cacheKey, filename);

          const latency_ms = Date.now() - t0;
          console.log(`[TTS][${callId}] Generated audio via ${model} (${geminiVoice}) in ${latency_ms}ms, size: ${wavBuffer.length} bytes`);
          return {
            audio_url: `/api/audio/${filename}`,
            audio_buffer: wavBuffer,
            latency_ms,
            cached: false,
            format: 'wav'
          };
        }
      } catch (modelErr) {
        console.warn(`[TTS][${callId}] Model ${model} failed (${Date.now() - t0}ms):`, modelErr.message?.slice(0, 120));
        if (modelErr.message?.includes('429') || modelErr.message?.includes('quota') || modelErr.message?.includes('RESOURCE_EXHAUSTED')) {
          global.__ttsQuotaExhaustedUntil = Date.now() + 60000; // back off 60s
        }
      }
    }
  }

  // Return graceful response if speech API unavailable
  return {
    audio_url: null,
    audio_buffer: null,
    latency_ms: Date.now() - t0,
    cached: false,
    format: 'wav'
  };
}
