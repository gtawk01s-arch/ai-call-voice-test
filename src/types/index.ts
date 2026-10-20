export interface Extension {
  id: string;
  name: string;
  dept: string;
  sip: string;
  phone: string;
  keywords: string[];
}

export interface ExtensionTransfer {
  extension: string;
  name: string;
  department: string;
  sip_uri: string;
  phone_number: string;
  reason?: string;
  warm_transfer_notes?: string;
}

export interface MessageItem {
  id: string;
  type: 'user' | 'bot' | 'transfer' | 'summary';
  text: string;
  audioUrl?: string | null;
  timestamp: number;
  transfer?: ExtensionTransfer;
  summaryData?: {
    duration: number;
    callId: string;
  };
}

export interface CallLogSession {
  callId: string;
  direction: 'inbound' | 'outbound';
  callerId: string;
  customerName?: string;
  status: string;
  disposition: string;
  campaign?: string;
  turns?: number;
  startTime?: number;
  endTime?: number;
  duration_seconds?: number;
  transferredTo?: Extension;
}

export interface WebhookTurnResult {
  call_id: string;
  action: string;
  intent: string;
  transcription?: string;
  reply: string;
  audio_url?: string;
  audio_format?: string;
  disposition: string;
  confidence?: number;
  transfer?: ExtensionTransfer | null;
  timing_ms?: {
    asr?: number;
    llm?: number;
    tts?: number;
    total?: number;
  };
  session?: {
    turns?: number;
    status?: string;
    disposition?: string;
  };
}
