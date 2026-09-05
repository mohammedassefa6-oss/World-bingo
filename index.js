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

exports.verifyTelegramLogin = onCall(async (request) => {
  const { initData } = request.data;
  if (!initData) throw new HttpsError("invalid-argument", "initData required");
  if (!TELEGRAM_BOT_TOKEN) throw new HttpsError("failed-precondition", "Bot token not configured");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    throw new HttpsError("permission-denied", "Invalid Telegram signature");
  }

  const authDate = Number(params.get("auth_date") || 0);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > 300) {
    throw new HttpsError("permission-denied", "initData expired, reopen the app");
  }

  const user = JSON.parse(params.get("user"));
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

  const customToken = await admin.auth().createCustomToken(uid);
  return { customToken, uid };
});

exports.joinRoom = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first");

  const { stake, cartelaNumber } = request.data;
  if (!Number.isInteger(stake) || stake <= 0) throw new HttpsError("invalid-argument", "bad stake");
  if (!Number.isInteger(cartelaNumber) || cartelaNumber < 1 || cartelaNumber > 100) {
    throw new HttpsError("invalid-argument", "bad cartela number");
  }

  const roomId = `stake_${stake}_open`;
  const roomRef = db.ref(`rooms/${roomId}`);
  const balanceRef = db.ref(`users/${uid}/balance`);

  const balanceResult = await balanceRef.transaction((current) => {
    current = current || 0;
    if (current < stake) return;
    return current - stake;
  });
  if (!balanceResult.committed) {
    throw new HttpsError("failed-precondition", "Insufficient balance");
  }

  const joinResult = await roomRef.transaction((room) => {
    room = room || { stake, state: "waiting", players: {}, taken: {} };
    if (room.state !== "waiting") return;
    if (room.taken && room.taken[cartelaNumber]) return;
    room.players = room.players || {};
    room.taken = room.taken || {};
    room.players[uid] = { cartelaNumber, joinedAt: Date.now() };
    room.taken[cartelaNumber] = true;
    return room;
  });

  if (!joinResult.committed) {
    await balanceRef.transaction((current) => (current || 0) + stake);
    throw new HttpsError("failed-precondition", "Could not join room (cartela taken or room started)");
  }

  const room = joinResult.snapshot.val();
  const playerCount = Object.keys(room.players).length;

  if (playerCount >= 2 && room.state === "waiting") {
    await roomRef.child("state").set("running");
    await roomRef.child("startedAt").set(admin.database.ServerValue.TIMESTAMP);
    await roomRef.child("calledNumbers").set({});
  }

  return { roomId, playerCount, yourCard: getCard(cartelaNumber) };
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
