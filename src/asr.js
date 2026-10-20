import { GoogleGenAI } from '@google/genai';
import { CONFIG } from './config.js';
import { Groq, toFile } from 'groq-sdk';
import fs from 'fs';

// Known hallucinations produced by ASR models on low-energy or background noise
const HALLUCINATION_PATTERNS = [
  /^(thank you|thanks)(\s+(very\s+much|so\s+much|for\s+watching|for\s+listening))?[.!]?$/i,
  /^(you|so|hmm|um|uh|oh|ah|okay|ok|bye|goodbye|subscribe|like and subscribe)[.!]?$/i,
  /^subtitles\s+by/i,
  /^translated\s+by/i,
  /^amara\.org/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^\*.*\*$/,
  /^[\s\.\?!,_\-~:;]+$/
];

/**
 * Detect MIME type from buffer magic bytes
 */
export function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return 'audio/webm';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'audio/wav';
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'audio/ogg';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mp3';
  if (buffer.length >= 8 && buffer.slice(4, 8).toString() === 'ftyp') return 'audio/mp4';
  return 'audio/webm';
}

/**
 * Check if audio buffer is too tiny (< 400 bytes) or essentially silence
 */
export function isAudioTrivial(buffer) {
  if (!buffer || buffer.length < 350) return true;
  return false;
}

/**
 * Transcribe caller audio with Groq Whisper (ultra-fast <400ms) and Gemini Multimodal fallback
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const t0 = Date.now();
  const { mimeType: inputMime, language = 'en', callId = 'turn' } = options;

  if (isAudioTrivial(audioBuffer)) {
    return { text: '', latency_ms: Date.now() - t0, is_silence: true };
  }

  const mimeType = inputMime || detectMimeType(audioBuffer);
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'webm';

  // 1. Primary High-Speed ASR: Groq Whisper (whisper-large-v3-turbo)
  if (CONFIG.GROQ_API_KEY) {
    try {
      const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
      const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType });

      const transcriptionPromise = groq.audio.transcriptions.create({
        file,
        model: 'whisper-large-v3-turbo',
        response_format: 'json',
        language: language === 'en' ? 'en' : undefined,
        temperature: 0.0
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Groq Whisper timeout')), 5000)
      );

      const result = await Promise.race([transcriptionPromise, timeoutPromise]);
      let text = (result?.text || '').trim();

      if (text) {
        // Check hallucination filter on short audio clips
        const isHallucination = HALLUCINATION_PATTERNS.some(p => p.test(text));
        if (isHallucination && audioBuffer.length < 3500) {
          console.log(`[ASR][${callId}] Filtered Whisper hallucination "${text}"`);
          return { text: '', latency_ms: Date.now() - t0, is_silence: true, provider: 'groq-whisper' };
        }

        const latency_ms = Date.now() - t0;
        console.log(`[ASR][${callId}] Groq Whisper transcribed in ${latency_ms}ms: "${text}"`);
        return { text, latency_ms, is_silence: false, provider: 'groq-whisper' };
      }
    } catch (groqErr) {
      console.warn(`[ASR][${callId}] Groq Whisper ASR error:`, groqErr.message);
    }
  }

  // 2. Secondary Multimodal ASR: Gemini (gemini-3.8-flash)
  const geminiKey = CONFIG.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const base64Audio = audioBuffer.toString('base64');
      const promptText = `Transcribe the caller's spoken words verbatim in ${language}. Output ONLY the spoken words. If there is only silence, background noise, or no human speech, output NO_SPEECH.`;

      const geminiPromise = ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Audio
                }
              },
              { text: promptText }
            ]
          }
        ]
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gemini ASR timeout')), CONFIG.TIMEOUTS.ASR_GEMINI || 6000)
      );

      const response = await Promise.race([geminiPromise, timeoutPromise]);
      let text = (response.text || '').trim().replace(/^["']|["']$/g, '');

      if (text && text.toUpperCase() !== 'NO_SPEECH' && text.toUpperCase() !== 'NO SPEECH') {
        const isHallucination = HALLUCINATION_PATTERNS.some(p => p.test(text));
        if (isHallucination && audioBuffer.length < 3500) {
          return { text: '', latency_ms: Date.now() - t0, is_silence: true, provider: 'gemini-3.8-flash' };
        }

        const latency_ms = Date.now() - t0;
        console.log(`[ASR][${callId}] Gemini transcribed in ${latency_ms}ms: "${text}"`);
        return { text, latency_ms, is_silence: false, provider: 'gemini-3.8-flash' };
      }
    } catch (geminiErr) {
      console.warn(`[ASR][${callId}] Gemini ASR error:`, geminiErr.message);
    }
  }

  return { text: '', latency_ms: Date.now() - t0, is_silence: true, error: 'All ASR models exhausted' };
}
