const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { getCard, hasBingo } = require("./cartela");
const { sendMessage, answerCallbackQuery, editMessageText } = require("./telegram");

admin.initializeApp();
const db = admin.database();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID = 442182826;
const DEFAULT_TELEBIRR_NUMBER = "0914338110";
const FIRST_DEPOSIT_BONUS = 10;
const HOUSE_CUT = 0.2;
const CALL_INTERVAL_MS = 3000;
const MAX_CARTELAS_PER_PLAYER = 2;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPositiveInteger(value) {
  const number = toFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

async function getTelegramProfile(uid) {
  if (typeof uid !== "string" || !/^tg_\d+$/.test(uid)) return null;
  const snapshot = await db.ref(`users/${uid}`).once("value");
  const profile = snapshot.val();
  return profile && String(profile.telegramId) === uid.slice(3) ? profile : null;
}

async function getTelebirrNumber() {
  const snap = await db.ref("settings/telebirrNumber").once("value");
  return snap.val() || DEFAULT_TELEBIRR_NUMBER;
}

// ============ LOGIN ============
exports.verifyTelegramLogin = onCall(async (request) => {
  const { initData } = request.data;
  if (!initData) throw new HttpsError("invalid-argument", "initData required");
  if (!TELEGRAM_BOT_TOKEN) throw new HttpsError("failed-precondition", "Bot token not configured");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");
  if (!hash || !authDateValue || !userValue) throw new HttpsError("invalid-argument", "Invalid Telegram WebApp data");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const computedHashBuffer = Buffer.from(computedHash, "hex");
  const providedHashBuffer = Buffer.from(hash, "hex");
  if (providedHashBuffer.length !== computedHashBuffer.length || !crypto.timingSafeEqual(computedHashBuffer, providedHashBuffer)) {
    throw new HttpsError("permission-denied", "Invalid Telegram signature");
  }

  const authDate = Number(authDateValue);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!Number.isFinite(authDate) || ageSeconds > 300 || ageSeconds < -30) {
    throw new HttpsError("permission-denied", "initData expired, reopen the app");
  }

  let user;
  try { user = JSON.parse(userValue); } catch { throw new HttpsError("invalid-argument", "Invalid Telegram user data"); }
  if (!user || !user.id) throw new HttpsError("invalid-argument", "Telegram user is required");
  const uid = `tg_${user.id}`;

  const userRef = db.ref(`users/${uid}`);
  const snapshot = await userRef.once("value");
  if (!snapshot.exists()) {
    await userRef.set({
      mainWallet: 0,
      playWallet: 0,
      bonus: 0,
      firstDepositBonusGiven: false,
      name: user.first_name || "Player",
      telegramId: user.id,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
  }

  const finalSnap = await userRef.once("value");
  const profile = finalSnap.val();
  const customToken = await admin.auth().createCustomToken(uid);
  return {
    customToken,
    uid,
    mainWallet: toFiniteNumber(profile.mainWallet) || 0,
    playWallet: toFiniteNumber(profile.playWallet) || 0,
    bonus: toFiniteNumber(profile.bonus) || 0,
  };
});

// ============ CONVERT BONUS -> PLAY WALLET ============
exports.convertBonus = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  if (!(await getTelegramProfile(uid))) throw new HttpsError("permission-denied", "Telegram user verification required");

  const userRef = db.ref(`users/${uid}`);
  const bonusRef = userRef.child("bonus");
  const bonusSnap = await bonusRef.once("value");
  const bonus = toFiniteNumber(bonusSnap.val()) || 0;
  if (bonus <= 0) throw new HttpsError("failed-precondition", "No bonus available to convert");

  await bonusRef.set(0);
  await userRef.child("playWallet").transaction((current) => (toFiniteNumber(current) || 0) + bonus);

  const updatedSnap = await userRef.once("value");
  return { converted: bonus, playWallet: toFiniteNumber(updatedSnap.val().playWallet) || 0 };
});

// ============ TRANSFER (main -> main) ============
exports.transferFunds = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  if (!(await getTelegramProfile(uid))) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { toTelegramId, amount } = request.data;
  const parsedAmount = toPositiveInteger(amount);
  const targetId = toPositiveInteger(toTelegramId);
  if (parsedAmount === null) throw new HttpsError("invalid-argument", "Invalid amount");
  if (!targetId) throw new HttpsError("invalid-argument", "Invalid recipient");

  const targetUid = `tg_${targetId}`;
  if (targetUid === uid) throw new HttpsError("invalid-argument", "Cannot transfer to yourself");

  const targetRef = db.ref(`users/${targetUid}`);
  const targetSnap = await targetRef.once("value");
  if (!targetSnap.exists()) throw new HttpsError("not-found", "Recipient not found");

  const senderRef = db.ref(`users/${uid}/mainWallet`);
  const result = await senderRef.transaction((current) => {
    const balance = toFiniteNumber(current);
    if (balance === null || balance < parsedAmount) return;
    return balance - parsedAmount;
  });
  if (!result.committed) throw new HttpsError("failed-precondition", "Insufficient main wallet balance");

  await targetRef.child("mainWallet").transaction((current) => (toFiniteNumber(current) || 0) + parsedAmount);
  await sendMessage(targetId, `💸 You received ${parsedAmount} ETB from a friend in your main wallet.`);

  const newBalanceSnap = await senderRef.once("value");
  return { mainWallet: toFiniteNumber(newBalanceSnap.val()) || 0 };
});

// ============ DEPOSIT ============
exports.requestDeposit = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  const profile = await getTelegramProfile(uid);
  if (!profile) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { amount } = request.data;
  const parsedAmount = toPositiveInteger(amount);
  if (parsedAmount === null) throw new HttpsError("invalid-argument", "Invalid amount");

  const telebirrNumber = await getTelebirrNumber();
  const isFirstDeposit = !profile.firstDepositBonusGiven;

  const requestRef = db.ref("depositRequests").push();
  await requestRef.set({
    uid,
    telegramId: profile.telegramId,
    name: profile.name,
    amount: parsedAmount,
    isFirstDeposit,
    status: "pending",
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });

  await sendMessage(
    ADMIN_TELEGRAM_ID,
    `🆕 New Deposit Request\n\nUser: ${profile.name}\nTelegram ID: ${profile.telegramId}\nAmount: ${parsedAmount} ETB${isFirstDeposit ? "\n(First deposit — +10 ETB bonus will be added on approval)" : ""}\n\nApprove only after confirming payment on Telebirr ${telebirrNumber}.`,
    {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `dep_approve_${requestRef.key}` },
        { text: "❌ Reject", callback_data: `dep_reject_${requestRef.key}` },
      ]],
    }
  );

  return { requestId: requestRef.key, telebirrNumber };
});

// ============ WITHDRAWAL (main wallet only) ============
exports.requestWithdrawal = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  const profile = await getTelegramProfile(uid);
  if (!profile) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { amount, telebirrNumber } = request.data;
  const parsedAmount = toPositiveInteger(amount);
  if (parsedAmount === null) throw new HttpsError("invalid-argument", "Invalid amount");
  if (!telebirrNumber || typeof telebirrNumber !== "string" || !/^\d{9,15}$/.test(telebirrNumber)) {
    throw new HttpsError("invalid-argument", "Valid Telebirr number required");
  }

  const mainWalletRef = db.ref(`users/${uid}/mainWallet`);
  const result = await mainWalletRef.transaction((current) => {
    const balance = toFiniteNumber(current);
    if (balance === null || balance < parsedAmount) return;
    return balance - parsedAmount;
  });
  if (!result.committed) throw new HttpsError("failed-precondition", "Insufficient main wallet balance");

  const requestRef = db.ref("withdrawalRequests").push();
  await requestRef.set({
    uid,
    telegramId: profile.telegramId,
    name: profile.name,
    amount: parsedAmount,
    telebirrNumber,
    status: "pending",
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });

  await sendMessage(
    ADMIN_TELEGRAM_ID,
    `🆕 New Withdrawal Request\n\nUser: ${profile.name}\nTelegram ID: ${profile.telegramId}\nAmount: ${parsedAmount} ETB\nSend to Telebirr: ${telebirrNumber}\n\nTap Confirm once you've sent the money.`,
    { inline_keyboard: [[{ text: "✅ Confirm Sent", callback_data: `wd_confirm_${requestRef.key}` }]] }
  );

  const newBalanceSnap = await mainWalletRef.once("value");
  return { requestId: requestRef.key, mainWallet: toFiniteNumber(newBalanceSnap.val()) || 0 };
});

// ============ CONTACT SUPPORT ============
exports.contactSupport = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  const profile = await getTelegramProfile(uid);
  if (!profile) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { message } = request.data;
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new HttpsError("invalid-argument", "Message required");
  }

  await sendMessage(
    ADMIN_TELEGRAM_ID,
    `📩 Support Message\n\nFrom: ${profile.name}\nTelegram ID: ${profile.telegramId}\n\n"${message.trim()}"`
  );

  return { sent: true };
});

// ============ JOIN ROOM (up to 2 cartelas, Play Wallet) ============
exports.joinRoom = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  if (!(await getTelegramProfile(uid))) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { stake, cartelaNumbers } = request.data;
  const parsedStake = toPositiveInteger(stake);
  if (parsedStake === null) throw new HttpsError("invalid-argument", "Invalid room stake");

  if (!Array.isArray(cartelaNumbers) || cartelaNumbers.length < 1 || cartelaNumbers.length > MAX_CARTELAS_PER_PLAYER) {
    throw new HttpsError("invalid-argument", `Choose 1 to ${MAX_CARTELAS_PER_PLAYER} cartelas`);
  }
  const parsedNumbers = [...new Set(cartelaNumbers.map(toPositiveInteger))];
  if (parsedNumbers.includes(null) || parsedNumbers.some((n) => n > 100) || parsedNumbers.length !== cartelaNumbers.length) {
    throw new HttpsError("invalid-argument", "Invalid cartela number(s)");
  }

  const totalCost = parsedStake * parsedNumbers.length;
  const roomId = `stake_${parsedStake}_open`;
  const roomRef = db.ref(`rooms/${roomId}`);
  const playWalletRef = db.ref(`users/${uid}/playWallet`);

  const balanceResult = await playWalletRef.transaction((current) => {
    const balance = toFiniteNumber(current);
    if (balance === null || balance < totalCost) return;
    return balance - totalCost;
  });
  if (!balanceResult.committed) {
    const balance = toFiniteNumber(balanceResult.snapshot.val());
    throw new HttpsError("failed-precondition", `Insufficient play wallet balance. You have ${balance === null ? 0 : balance} ETB; ${totalCost} ETB required.`);
  }

  const joinResult = await roomRef.transaction((room) => {
    room = room || { stake: parsedStake, state: "waiting", players: {}, taken: {}, cartelaCount: 0 };
    if (room.state !== "waiting") return;
    if (Number(room.stake) !== parsedStake) return;
    room.taken = room.taken || {};
    for (const num of parsedNumbers) {
      if (room.taken[num]) return;
    }
    room.players = room.players || {};
    room.players[uid] = { cartelaNumbers: parsedNumbers, joinedAt: Date.now() };
    for (const num of parsedNumbers) room.taken[num] = true;
    room.cartelaCount = (room.cartelaCount || 0) + parsedNumbers.length;
    return room;
  });

  if (!joinResult.committed) {
    await playWalletRef.transaction((current) => (toFiniteNumber(current) || 0) + totalCost);
    throw new HttpsError("failed-precondition", "Could not join room (a cartela is already taken or room started)");
  }

  const room = joinResult.snapshot.val();
  const playerCount = Object.keys(room.players).length;

  if (playerCount >= 2 && room.state === "waiting") {
    await roomRef.child("state").set("running");
    await roomRef.child("startedAt").set(admin.database.ServerValue.TIMESTAMP);
    await roomRef.child("calledNumbers").set({});
  }

  const balanceSnapshot = await playWalletRef.once("value");
  return {
    roomId,
    playerCount,
    yourCards: parsedNumbers.map((n) => ({ number: n, card: getCard(n) })),
    playWallet: toFiniteNumber(balanceSnapshot.val()) || 0,
  };
});

// ============ NUMBER CALLER + AUTO WIN DETECTION ============
exports.advanceGames = onSchedule(
  { schedule: `every ${Math.round(CALL_INTERVAL_MS / 1000)} seconds` },
  async () => {
    const roomsSnap = await db.ref("rooms").orderByChild("state").equalTo("running").once("value");
    const rooms = roomsSnap.val() || {};

    for (const [roomId, room] of Object.entries(rooms)) {
      const roomRef = db.ref(`rooms/${roomId}`);
      const calledBefore = Object.keys(room.calledNumbers || {}).map(Number);
      const remaining = [];
      for (let n = 1; n <= 75; n++) if (!calledBefore.includes(n)) remaining.push(n);

      if (remaining.length === 0) {
        await roomRef.child("state").set("finished");
        continue;
      }

      const next = remaining[Math.floor(Math.random() * remaining.length)];
      await roomRef.child(`calledNumbers/${next}`).set(true);
      await roomRef.child("lastCalled").set(next);

      const calledSet = new Set([...calledBefore, next]);
      const players = room.players || {};
      const winners = [];
      for (const [uid, player] of Object.entries(players)) {
        const cards = player.cartelaNumbers || [];
        const won = cards.some((num) => hasBingo(num, calledSet));
        if (won) winners.push(uid);
      }

      if (winners.length > 0) {
        const totalCartelas = room.cartelaCount || Object.values(players).reduce((sum, p) => sum + (p.cartelaNumbers || []).length, 0);
        const gross = room.stake * totalCartelas;
        const totalPrize = Math.floor(gross * (1 - HOUSE_CUT));
        const share = Math.floor(totalPrize / winners.length);

        await roomRef.child("state").set("finished");
        await roomRef.child("winners").set(winners);
        await roomRef.child("prizePerWinner").set(share);

        for (const winnerUid of winners) {
          await db.ref(`users/${winnerUid}/mainWallet`).transaction((current) => (toFiniteNumber(current) || 0) + share);
          const telegramId = winnerUid.replace("tg_", "");
          await sendMessage(telegramId, `🎉 BINGO! You won ${share} ETB! It has been added to your Main Wallet.`);
        }
      }
    }
  }
);

// ============ TELEGRAM WEBHOOK (admin buttons + /setphone) ============
exports.telegramWebhook = onRequest(async (req, res) => {
  const update = req.body;

  if (update.message && update.message.text) {
    const message = update.message;
    if (String(message.from.id) === String(ADMIN_TELEGRAM_ID)) {
      const match = message.text.match(/^\/setphone\s+(\d{9,15})$/);
      if (match) {
        await db.ref("settings/telebirrNumber").set(match[1]);
        await sendMessage(ADMIN_TELEGRAM_ID, `✅ Deposit Telebirr number updated to ${match[1]}`);
      }
    }
    res.status(200).send("ok");
    return;
  }

  const callback = update.callback_query;
  if (!callback) {
    res.status(200).send("ok");
    return;
  }

  const fromId = callback.from.id;
  if (String(fromId) !== String(ADMIN_TELEGRAM_ID)) {
    await answerCallbackQuery(callback.id, "Not authorized");
    res.status(200).send("ok");
    return;
  }

  const data = callback.data;
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;

  if (data.startsWith("dep_approve_") || data.startsWith("dep_reject_")) {
    const approve = data.startsWith("dep_approve_");
    const requestId = data.replace(approve ? "dep_approve_" : "dep_reject_", "");
    const requestRef = db.ref(`depositRequests/${requestId}`);
    const snap = await requestRef.once("value");
    const depositRequest = snap.val();

    if (!depositRequest || depositRequest.status !== "pending") {
      await answerCallbackQuery(callback.id, "Already handled");
      res.status(200).send("ok");
      return;
    }

    if (approve) {
      const userRef = db.ref(`users/${depositRequest.uid}`);
      await userRef.child("mainWallet").transaction((current) => (toFiniteNumber(current) || 0) + depositRequest.amount);

      let bonusMsg = "";
      if (depositRequest.isFirstDeposit) {
        const userSnap = await userRef.once("value");
        const userProfile = userSnap.val();
        if (userProfile && !userProfile.firstDepositBonusGiven) {
          await userRef.child("bonus").transaction((current) => (toFiniteNumber(current) || 0) + FIRST_DEPOSIT_BONUS);
          await userRef.child("firstDepositBonusGiven").set(true);
          bonusMsg = ` + 🎁 ${FIRST_DEPOSIT_BONUS} ETB first-deposit bonus`;
        }
      }

      await requestRef.child("status").set("approved");
      await editMessageText(chatId, messageId, `Deposit of ${depositRequest.amount} ETB approved for ${depositRequest.name}.${bonusMsg}`);
      await sendMessage(depositRequest.telegramId, `✅ Your deposit of ${depositRequest.amount} ETB has been approved and added to your main wallet.${bonusMsg}`);
    } else {
      await requestRef.child("status").set("rejected");
      await editMessageText(chatId, messageId, `Deposit of ${depositRequest.amount} ETB rejected for ${depositRequest.name}.`);
      await sendMessage(depositRequest.telegramId, `❌ Your deposit request of ${depositRequest.amount} ETB was rejected. Contact support if this is a mistake.`);
    }
  }

  if (data.startsWith("wd_confirm_")) {
    const requestId = data.replace("wd_confirm_", "");
    const requestRef = db.ref(`withdrawalRequests/${requestId}`);
    const snap = await requestRef.once("value");
    const withdrawalRequest = snap.val();

    if (!withdrawalRequest || withdrawalRequest.status !== "pending") {
      await answerCallbackQuery(callback.id, "Already handled");
      res.status(200).send("ok");
      return;
    }

    await requestRef.child("status").set("completed");
    await editMessageText(chatId, messageId, `Withdrawal of ${withdrawalRequest.amount} ETB marked as sent to ${withdrawalRequest.name}.`);
    await sendMessage(withdrawalRequest.telegramId, `✅ Your withdrawal of ${withdrawalRequest.amount} ETB has been sent to ${withdrawalRequest.telebirrNumber}.`);
  }

  await answerCallbackQuery(callback.id, "Done");
  res.status(200).send("ok");
});


