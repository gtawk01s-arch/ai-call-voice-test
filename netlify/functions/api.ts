import { CONFIG, getCampaign } from '../../src/config.js';
import {
  getOrCreateSession,
  getSession,
  deleteSession,
  getAllSessions,
  getGlobalLatencyMetrics
} from '../../src/session.js';
import { processTurn } from '../../src/engine.js';
import { synthesizeSpeech } from '../../src/tts.js';
import { getProviderCounters } from '../../src/llm.js';
import { transcribeAudio } from '../../src/asr.js';

// Response helper
function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-call-id'
    }
  });
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-call-id'
      }
    });
  }

  const url = new URL(req.url);
  let pathname = url.pathname;

  // Normalize Netlify function path prefix if needed
  if (pathname.startsWith('/.netlify/functions/api')) {
    pathname = pathname.replace('/.netlify/functions/api', '/api');
  }

  try {
    // 1. Healthcheck
    if (pathname === '/api/health' || pathname === '/health') {
      const latency = getGlobalLatencyMetrics();
      const providers = getProviderCounters();
      return jsonResponse({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        platform: 'netlify-functions',
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
      });
    }

    // 2. Dialer Extensions
    if (pathname === '/api/dialer/extensions') {
      return jsonResponse({
        status: 'success',
        count: CONFIG.EXTENSIONS.length,
        extensions: CONFIG.EXTENSIONS
      });
    }

    // 3. Dialer Call History
    if (pathname === '/api/dialer/calls') {
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
      sessions.sort((a: any, b: any) => (b.startTime || 0) - (a.startTime || 0));
      return jsonResponse({
        status: 'success',
        count: sessions.length,
        calls: sessions
      });
    }

    // 4. Start Call
    if (pathname === '/api/dialer/call/start') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
      const callerId = body.caller_id || body.From || 'Anonymous';
      const customerName = body.customer_name || '';
      const campaignId = body.campaign || (direction === 'outbound' ? 'sales' : 'support');
      const chosenVoice = body.voice || CONFIG.AUDIO.DEFAULT_VOICE;

      const session = getOrCreateSession(callId, {
        direction,
        callerId,
        campaignId
      });
      if (customerName) {
        (session as any).customerName = customerName;
      }

      const campaign = getCampaign(campaignId);
      const greeting = body.custom_greeting || campaign.greeting;
      session.recordTurn('assistant', greeting);

      const ttsRes = await synthesizeSpeech(greeting, {
        isStatic: !body.custom_greeting,
        voice: chosenVoice,
        callId
      });

      return jsonResponse({
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
    }

    // 5. Interact / Turn
    if (pathname === '/api/dialer/call/interact') {
      const contentType = req.headers.get('content-type') || '';
      let callId = 'demo-call';
      let userText = '';
      let chosenVoice = CONFIG.AUDIO.DEFAULT_VOICE;

      if (contentType.includes('application/json')) {
        const body = await req.json().catch(() => ({}));
        callId = body.call_id || 'demo-call';
        userText = (body.text || '').trim();
        chosenVoice = body.voice || CONFIG.AUDIO.DEFAULT_VOICE;
      } else if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData();
        callId = (formData.get('call_id') as string) || 'demo-call';
        userText = ((formData.get('text') as string) || '').trim();
        chosenVoice = (formData.get('voice') as string) || CONFIG.AUDIO.DEFAULT_VOICE;

        const audioFile = formData.get('audio') as File | null;
        if (audioFile && !userText) {
          const buffer = Buffer.from(await audioFile.arrayBuffer());
          const asr = await transcribeAudio(buffer, { callId });
          userText = asr.text;
        }
      }

      const session = getOrCreateSession(callId);

      if (!userText) {
        return jsonResponse({
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
      const ttsResult = await synthesizeSpeech(engineResult.reply, {
        voice: chosenVoice,
        callId
      });

      return jsonResponse({
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
    }

    // 6. Transfer Call
    if (pathname === '/api/dialer/call/transfer') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || 'demo-call';
      const extId = body.extension_id;
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

      return jsonResponse({
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
    }

    // 7. End Call
    if (pathname === '/api/dialer/call/end') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id;
      const session = getSession(callId);
      if (session) {
        session.end(body.disposition || 'caller_ended');
      }
      return jsonResponse({ status: 'ended', call_id: callId });
    }

    // 8. Reset Call
    if (pathname.startsWith('/api/reset/')) {
      const callId = pathname.replace('/api/reset/', '');
      deleteSession(callId);
      return jsonResponse({ status: 'reset', call_id: callId });
    }

    // 9. Webhook: Call Answered
    if (pathname === '/api/webhook/call') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
      const campaignId = body.campaign_id || 'support';

      const session = getOrCreateSession(callId, { direction, campaignId });
      const campaign = getCampaign(campaignId);
      const greeting = campaign.greeting;
      session.recordTurn('assistant', greeting);

      const ttsRes = await synthesizeSpeech(greeting, { isStatic: true, callId });

      return jsonResponse({
        call_id: callId,
        event: 'call_answered',
        action: 'speak_and_listen',
        intent: 'greeting',
        reply: greeting,
        audio_url: ttsRes.audio_url,
        disposition: 'in_progress',
        confidence: 1.0,
        session: { direction, campaign: campaign.name, status: session.status }
      });
    }

    // 10. Webhook: Turn
    if (pathname === '/api/webhook/turn') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || 'demo-call';
      const session = getOrCreateSession(callId);
      const userText = (body.text || '').trim();

      const engineResult = await processTurn(session, userText);
      const ttsRes = await synthesizeSpeech(engineResult.reply, { callId });

      return jsonResponse({
        call_id: callId,
        action: engineResult.action,
        intent: engineResult.intent,
        transcription: userText,
        reply: engineResult.reply,
        audio_url: ttsRes.audio_url,
        disposition: engineResult.disposition,
        confidence: engineResult.confidence,
        transfer: engineResult.transfer ? {
          extension: engineResult.transfer.id,
          name: engineResult.transfer.name,
          department: engineResult.transfer.dept,
          sip_uri: engineResult.transfer.sip,
          phone_number: engineResult.transfer.phone
        } : null,
        session: { turns: session.turns, status: session.status, disposition: session.disposition }
      });
    }

    // 11. Webhook: Barge-in
    if (pathname === '/api/webhook/barge-in') {
      const body = await req.json().catch(() => ({}));
      return jsonResponse({ status: 'acknowledged', call_id: body.call_id });
    }

    // 12. Webhook: Hangup
    if (pathname === '/api/webhook/hangup') {
      const body = await req.json().catch(() => ({}));
      const session = getSession(body.call_id);
      if (session) {
        session.end(body.reason || 'caller_hangup');
        return jsonResponse({ status: 'closed', call_id: body.call_id, summary: session.getMetrics() });
      }
      return jsonResponse({ status: 'closed', call_id: body.call_id });
    }

    // 13. Webhook: Spec
    if (pathname === '/api/webhook/spec') {
      return jsonResponse({
        version: '1.0.0',
        endpoints: {
          call: '/api/webhook/call',
          turn: '/api/webhook/turn',
          barge_in: '/api/webhook/barge-in',
          hangup: '/api/webhook/hangup'
        },
        extensions: CONFIG.EXTENSIONS
      });
    }

    return jsonResponse({ error: 'Endpoint not found', path: pathname }, 404);
  } catch (err: any) {
    console.error('[Netlify Function Error]:', err);
    return jsonResponse({ error: err.message || 'Internal server error' }, 500);
  }
}

export const config = {
  path: ['/api/*', '/.netlify/functions/api/*']
};
