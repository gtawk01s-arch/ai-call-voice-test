/**
 * Browser Voice Engine
 * Provides client-side conversational AI and intent processing when the app
 * is hosted on static platforms like Netlify without a Node.js backend running.
 */

import { ExtensionTransfer } from '../types';

export interface EngineTurnResult {
  response: string;
  action?: 'continue' | 'transfer' | 'hangup' | 'schedule';
  transfer?: ExtensionTransfer;
}

const EXTENSIONS: ExtensionTransfer[] = [
  {
    name: 'Customer Support',
    extension: '101',
    department: 'General Support',
    sip_uri: 'sip:101@pbx.local',
    phone_number: '+1 (800) 555-0101'
  },
  {
    name: 'Billing & Accounting',
    extension: '102',
    department: 'Billing & Invoices',
    sip_uri: 'sip:102@pbx.local',
    phone_number: '+1 (800) 555-0102'
  },
  {
    name: 'Technical Escalations',
    extension: '103',
    department: 'Engineering & Tech',
    sip_uri: 'sip:103@pbx.local',
    phone_number: '+1 (800) 555-0103'
  },
  {
    name: 'Sales & New Accounts',
    extension: '104',
    department: 'Enterprise Sales',
    sip_uri: 'sip:104@pbx.local',
    phone_number: '+1 (800) 555-0104'
  }
];

export function cleanSpokenText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\*+/g, '')
    .replace(/#+/g, '')
    .replace(/[_`~]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a smart conversational response in the browser
 */
export function generateBrowserVoiceResponse(
  userText: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }> = []
): EngineTurnResult {
  const query = userText.trim().toLowerCase();

  // 1. Check for transfer requests
  if (
    query.includes('transfer') ||
    query.includes('speak to a human') ||
    query.includes('talk to a human') ||
    query.includes('speak with an agent') ||
    query.includes('talk to a person') ||
    query.includes('representative') ||
    query.includes('real person')
  ) {
    if (query.includes('bill') || query.includes('payment') || query.includes('invoice')) {
      const ext = EXTENSIONS[1]; // Billing
      return {
        response: `Certainly. I am transferring you directly to our Billing Department at extension ${ext.extension}. Please hold.`,
        action: 'transfer',
        transfer: ext
      };
    }
    if (query.includes('tech') || query.includes('broken') || query.includes('error') || query.includes('bug')) {
      const ext = EXTENSIONS[2]; // Tech
      return {
        response: `Connecting you to our Technical Support team at extension ${ext.extension}. Please hold while I connect you.`,
        action: 'transfer',
        transfer: ext
      };
    }
    if (query.includes('sales') || query.includes('pricing') || query.includes('buy') || query.includes('quote')) {
      const ext = EXTENSIONS[3]; // Sales
      return {
        response: `I will get you right over to Sales at extension ${ext.extension}. Transferring now.`,
        action: 'transfer',
        transfer: ext
      };
    }
    // Default transfer
    const defaultExt = EXTENSIONS[0];
    return {
      response: `I would be glad to connect you with a specialist. Transferring you to Customer Support at extension ${defaultExt.extension}.`,
      action: 'transfer',
      transfer: defaultExt
    };
  }

  // 2. Billing & Invoices
  if (
    query.includes('bill') ||
    query.includes('invoice') ||
    query.includes('charge') ||
    query.includes('payment') ||
    query.includes('refund') ||
    query.includes('due date')
  ) {
    return {
      response: "For billing questions, payments can be viewed in your account dashboard under Invoices. If you notice an unexpected charge or need a refund processed, I can connect you with Billing at extension 102. Would you like me to transfer you?"
    };
  }

  // 3. Technical Support
  if (
    query.includes('not working') ||
    query.includes('error') ||
    query.includes('broken') ||
    query.includes('troubleshoot') ||
    query.includes('issue') ||
    query.includes('bug') ||
    query.includes('down') ||
    query.includes('crash')
  ) {
    return {
      response: "I can help with that. First, try refreshing your session or clearing temporary cache. If the issue persists, our technical engineering team can run diagnostics for you. Would you like me to transfer you to extension 103?"
    };
  }

  // 4. Appointments & Scheduling
  if (
    query.includes('appointment') ||
    query.includes('schedule') ||
    query.includes('book') ||
    query.includes('reserve') ||
    query.includes('meeting') ||
    query.includes('call back') ||
    query.includes('callback')
  ) {
    return {
      response: "I can help you schedule a callback or appointment. We have slots available Monday through Friday between 9 AM and 5 PM Eastern Time. What day and time works best for you?",
      action: 'schedule'
    };
  }

  // 5. Hours & Location
  if (
    query.includes('hours') ||
    query.includes('open') ||
    query.includes('close') ||
    query.includes('location') ||
    query.includes('address') ||
    query.includes('where are you')
  ) {
    return {
      response: "Our customer assistance center is available Monday through Friday from 8 AM to 8 PM Eastern Time, and Saturdays from 9 AM to 3 PM. You can also reach our emergency support line 24/7."
    };
  }

  // 6. Pricing & Plans
  if (
    query.includes('price') ||
    query.includes('pricing') ||
    query.includes('cost') ||
    query.includes('plan') ||
    query.includes('subscription') ||
    query.includes('discount')
  ) {
    return {
      response: "Our standard plans start at 29 dollars per month with unlimited voice inquiries, while enterprise plans include dedicated phone lines and custom integrations. Would you like me to connect you to our Sales team for a quote?"
    };
  }

  // 7. Identity & Capabilities
  if (
    query.includes('who are you') ||
    query.includes('what are you') ||
    query.includes('what can you do') ||
    query.includes('your name') ||
    query.includes('how do you work')
  ) {
    return {
      response: "I am Alex, an AI voice assistant. I can answer customer inquiries, troubleshoot issues, look up account info, schedule appointments, and transfer your call to the right team. What can I help you with today?"
    };
  }

  // 8. Greetings
  if (
    query === 'hello' ||
    query === 'hi' ||
    query === 'hey' ||
    query.startsWith('hello') ||
    query.startsWith('hi ') ||
    query.startsWith('hey ') ||
    query.includes('good morning') ||
    query.includes('good afternoon') ||
    query.includes('good evening')
  ) {
    return {
      response: "Hello! Thank you for calling. How can I assist you today?"
    };
  }

  // 9. Gratitude & Pleasantries
  if (
    query.includes('thank you') ||
    query.includes('thanks') ||
    query.includes('appreciate') ||
    query.includes('great help')
  ) {
    return {
      response: "You are very welcome! Is there anything else I can help you with today?"
    };
  }

  // 10. Closings & Goodbyes
  if (
    query.includes('bye') ||
    query.includes('goodbye') ||
    query.includes('that is all') ||
    query.includes("that's all") ||
    query.includes('nothing else') ||
    query.includes('no thanks') ||
    query.includes('no thank you') ||
    query.includes('have a good day')
  ) {
    return {
      response: "Thank you for reaching out to us today. Have a wonderful day ahead. Goodbye!",
      action: 'hangup'
    };
  }

  // 11. Frustration / Anger
  if (
    query.includes('angry') ||
    query.includes('ridiculous') ||
    query.includes('terrible') ||
    query.includes('worst') ||
    query.includes('stupid') ||
    query.includes('unacceptable')
  ) {
    const ext = EXTENSIONS[0];
    return {
      response: `I completely understand your frustration and apologize for the inconvenience. Let me immediately connect you to a live senior specialist at extension ${ext.extension} who can resolve this.`,
      action: 'transfer',
      transfer: ext
    };
  }

  // 12. General intelligent conversational fallback
  return {
    response: `I understand you are asking about "${cleanSpokenText(userText)}". Could you tell me a little more details, or would you like me to transfer you to our customer support team?`
  };
}
