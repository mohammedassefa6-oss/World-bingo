const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { getCard, hasBingo } = require("./cartela");

admin.initializeApp();
const db = admin.database();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const HOUSE_CUT = 0.2;
const CALL_INTERVAL_MS = 3000;

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
      balance: 0,
      referrals: 0,
      cards: 0,
      name: user.first_name || "Player",
      telegramId: user.id,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
  }

  const balanceSnapshot = await userRef.child("balance").once("value");
  const balance = toFiniteNumber(balanceSnapshot.val());
  const customToken = await admin.auth().createCustomToken(uid);
  return { customToken, uid, balance: balance === null ? 0 : balance };
});

exports.joinRoom = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  if (!(await getTelegramProfile(uid))) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { stake, cartelaNumber } = request.data;
  const parsedStake = toPositiveInteger(stake);
  const parsedCartelaNumber = toPositiveInteger(cartelaNumber);
  if (parsedStake === null) throw new HttpsError("invalid-argument", "Invalid room stake");
  if (parsedCartelaNumber === null || parsedCartelaNumber > 100) throw new HttpsError("invalid-argument", "Invalid cartela number");

  const roomId = `stake_${parsedStake}_open`;
  const roomRef = db.ref(`rooms/${roomId}`);
  const balanceRef = db.ref(`users/${uid}/balance`);

  const balanceResult = await balanceRef.transaction((current) => {
    const balance = toFiniteNumber(current);
    if (balance === null || balance < parsedStake) return;
    return balance - parsedStake;
  });
  if (!balanceResult.committed) {
    const balance = toFiniteNumber(balanceResult.snapshot.val());
    if (balance === null) throw new HttpsError("failed-precondition", "Balance unavailable. Please try again.");
    throw new HttpsError("failed-precondition", `Insufficient balance. You have ${balance} ETB; ${parsedStake} ETB is required.`);
  }

  const joinResult = await roomRef.transaction((room) => {
    room = room || { stake: parsedStake, state: "waiting", players: {}, taken: {} };
    if (room.state !== "waiting") return;
    if (Number(room.stake) !== parsedStake) return;
    if (room.taken && room.taken[parsedCartelaNumber]) return;
    room.players = room.players || {};
    room.taken = room.taken || {};
    room.players[uid] = { cartelaNumber: parsedCartelaNumber, joinedAt: Date.now() };
    room.taken[parsedCartelaNumber] = true;
    return room;
  });

  if (!joinResult.committed) {
    await balanceRef.transaction((current) => {
      const balance = toFiniteNumber(current);
      return (balance === null ? 0 : balance) + parsedStake;
    });
    throw new HttpsError("failed-precondition", "Could not join room (cartela taken or room started)");
  }

  const room = joinResult.snapshot.val();
  const playerCount = Object.keys(room.players).length;

  if (playerCount >= 2 && room.state === "waiting") {
    await roomRef.child("state").set("running");
    await roomRef.child("startedAt").set(admin.database.ServerValue.TIMESTAMP);
    await roomRef.child("calledNumbers").set({});
  }

  const balanceSnapshot = await balanceRef.once("value");
  const balance = toFiniteNumber(balanceSnapshot.val());
  return { roomId, playerCount, yourCard: getCard(parsedCartelaNumber), balance };
});

exports.advanceGames = onSchedule(
  { schedule: `every ${Math.round(CALL_INTERVAL_MS / 1000)} seconds` },
  async () => {
    const roomsSnap = await db.ref("rooms").orderByChild("state").equalTo("running").once("value");
    const rooms = roomsSnap.val() || {};

    for (const [roomId, room] of Object.entries(rooms)) {
      const called = Object.keys(room.calledNumbers || {}).map(Number);
      const remaining = [];
      for (let n = 1; n <= 75; n++) if (!called.includes(n)) remaining.push(n);
      if (remaining.length === 0) {
        await db.ref(`rooms/${roomId}/state`).set("finished");
        continue;
      }
      const next = remaining[Math.floor(Math.random() * remaining.length)];
      await db.ref(`rooms/${roomId}/calledNumbers/${next}`).set(true);
      await db.ref(`rooms/${roomId}/lastCalled`).set(next);
    }
  }
);

exports.claimBingo = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");
  if (!(await getTelegramProfile(uid))) throw new HttpsError("permission-denied", "Telegram user verification required");

  const { roomId } = request.data;
  const roomRef = db.ref(`rooms/${roomId}`);
  const roomSnap = await roomRef.once("value");
  const room = roomSnap.val();
  if (!room) throw new HttpsError("not-found", "Room not found");
  if (room.state !== "running") throw new HttpsError("failed-precondition", "Room not active");

  const player = room.players?.[uid];
  if (!player) throw new HttpsError("permission-denied", "You are not in this room");

  const calledSet = new Set(Object.keys(room.calledNumbers || {}).map(Number));
  const win = hasBingo(player.cartelaNumber, calledSet);
  if (!win) {
    throw new HttpsError("failed-precondition", "No BINGO on your card yet");
  }

  const playerCount = Object.keys(room.players).length;
  const gross = room.stake * playerCount;
  const prize = Math.floor(gross * (1 - HOUSE_CUT));

  await roomRef.child("state").set("finished");
  await roomRef.child("winner").set(uid);
  await roomRef.child("prize").set(prize);
  await db.ref(`users/${uid}/balance`).transaction((current) => (current || 0) + prize);

  return { won: true, prize };
});
